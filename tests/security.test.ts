import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOFTER_DEFAULTS, type LofterConfigSection } from '../src/config.ts';
import {
  MAX_IMAGE_BYTES,
  assertImageUrl,
  assertLofterPageUrl,
  isDomainLike,
  isImageHost,
  normalizeBlogName,
} from '../src/guard.ts';
import { writeSession } from '../src/session.ts';
import { LofterWorld } from '../src/world.ts';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function makeWorld(overrides: Partial<LofterConfigSection>, fetchImpl?: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), 'lofter-sec-'));
  const cfg: LofterConfigSection = { ...LOFTER_DEFAULTS, ...overrides };
  const world = new LofterWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    botDir: dir,
    dataDir: dir,
    fetchImpl,
    sleep: async () => {},
  });
  writeSession(dir, {
    version: 1, cookie: 'a=1', updatedAt: '', nickname: '', scriptSessionId: '', httpSessionId: '',
  });
  return { world, dir };
}

function tool(world: LofterWorld, name: string): Handler {
  const found = world.tools().find((entry) => entry.name === name);
  if (!found || !found.handler) throw new Error('没这个工具: ' + name);
  return found.handler as unknown as Handler;
}

describe('页面地址闸门', () => {
  it('LOFTER 自己的域放行', () => {
    expect(assertLofterPageUrl('https://www.lofter.com/front/discover').hostname).toBe('www.lofter.com');
    expect(assertLofterPageUrl('https://someone.lofter.com/post/abc_1').hostname).toBe('someone.lofter.com');
    expect(assertLofterPageUrl('https://lofter.com/').hostname).toBe('lofter.com');
  });

  it('非 lofter.com 的域一律拒 —— Cookie 不外发', () => {
    expect(() => assertLofterPageUrl('https://evil.com/x')).toThrow(/lofter\.com/);
    expect(() => assertLofterPageUrl('https://evillofter.com/x')).toThrow(/lofter\.com/);
    expect(() => assertLofterPageUrl('https://lofter.com.evil.com/x')).toThrow(/lofter\.com/);
  });

  it('明文 http 与非 http 协议都拒', () => {
    expect(() => assertLofterPageUrl('http://www.lofter.com/x')).toThrow(/https/);
    expect(() => assertLofterPageUrl('file:///C:/Windows/win.ini')).toThrow(/https/);
    expect(() => assertLofterPageUrl('ftp://www.lofter.com/x')).toThrow(/https/);
  });

  it('空串与畸形地址给出人类可读的错', () => {
    expect(() => assertLofterPageUrl('   ')).toThrow(/空的/);
    expect(() => assertLofterPageUrl('not a url')).toThrow(/合法地址/);
  });
});

describe('图床白名单', () => {
  it('实测图床后缀放行', () => {
    expect(isImageHost('imglf5.lf127.net')).toBe(true);
    expect(isImageHost('lf127.net')).toBe(true);
    expect(isImageHost('nos.netease.com')).toBe(true);
    expect(isImageHost('nosdn.127.net')).toBe(true);
  });

  it('内网 / 云元数据 / 冒名后缀都拒', () => {
    expect(isImageHost('127.0.0.1')).toBe(false);
    expect(isImageHost('169.254.169.254')).toBe(false);
    expect(isImageHost('localhost')).toBe(false);
    expect(isImageHost('evil-lf127.net')).toBe(false);
    expect(isImageHost('lf127.net.evil.com')).toBe(false);
  });

  it('存图地址只接受 http/https 且要过白名单', () => {
    expect(assertImageUrl('https://imglf5.lf127.net/img/a.jpg').hostname).toBe('imglf5.lf127.net');
    expect(() => assertImageUrl('file:///etc/passwd')).toThrow(/http/);
    expect(() => assertImageUrl('https://127.0.0.1:8080/a.jpg')).toThrow(/白名单/);
    expect(() => assertImageUrl('http://169.254.169.254/latest/meta-data/')).toThrow(/白名单/);
    expect(() => assertImageUrl('https://evil.com/a.jpg')).toThrow(/白名单/);
  });
});

describe('博主名归一化', () => {
  it('域名、URL、大小写都能收敛成同一个名字', () => {
    expect(normalizeBlogName('someone')).toBe('someone');
    expect(normalizeBlogName('someone.lofter.com')).toBe('someone');
    expect(normalizeBlogName('https://someone.lofter.com/')).toBe('someone');
    expect(normalizeBlogName('HTTPS://Someone.LOFTER.COM/post/1')).toBe('someone');
  });

  it('带斜杠、@、空格或点的脏名字一律拒,不给拼畸形 URL 的机会', () => {
    expect(() => normalizeBlogName('')).toThrow(/博主域名/);
    expect(() => normalizeBlogName('@evil.com')).toThrow(/字母数字/);
    expect(() => normalizeBlogName('a b')).toThrow(/字母数字/);
    expect(() => normalizeBlogName('someone.evil.com')).toThrow(/字母数字/);
  });

  it('isDomainLike 与归一化判断一致', () => {
    expect(isDomainLike('someone')).toBe(true);
    expect(isDomainLike('a-b_c')).toBe(false);
  });
});

describe('存图工具层的三道闸', () => {
  it('内网地址不发请求,直接进失败列表', async () => {
    let called = 0;
    const fetchImpl = (async () => { called += 1; return new Response('x', { status: 200 }); }) as unknown as typeof fetch;
    const dir = dir0();
    const { world } = makeWorld({ allowDownload: true, downloadDir: dir }, fetchImpl);
    const text = String(await tool(world, 'lofter_download')({ urls: ['http://127.0.0.1:8080/a.jpg'] }));
    expect(text).toContain('失败 1 张');
    expect(text).toContain('白名单');
    expect(called).toBe(0);
    expect(readdirSync(dir).filter((f) => f.endsWith('.jpg')).length).toBe(0);
  });

  it('Content-Type 不是图片时拒', async () => {
    const fetchImpl = (async () => new Response('<html>hi</html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    })) as unknown as typeof fetch;
    const { world } = makeWorld({ allowDownload: true, downloadDir: dir0() }, fetchImpl);
    const text = String(await tool(world, 'lofter_download')({ urls: ['https://imglf5.lf127.net/img/a.jpg'] }));
    expect(text).toContain('不是图片');
  });

  it('Content-Length 超上限时先拒,不把整包读进内存', async () => {
    const fetchImpl = (async () => new Response(Buffer.from([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': String(MAX_IMAGE_BYTES + 1) },
    })) as unknown as typeof fetch;
    const { world } = makeWorld({ allowDownload: true, downloadDir: dir0() }, fetchImpl);
    const text = String(await tool(world, 'lofter_download')({ urls: ['https://imglf5.lf127.net/img/big.jpg'] }));
    expect(text).toContain('图太大');
  });

  it('白名单内的正常图片照旧落盘', async () => {
    const fetchImpl = (async () => new Response(Buffer.from([1, 2, 3]), {
      status: 200, headers: { 'content-type': 'image/jpeg' },
    })) as unknown as typeof fetch;
    const dir = dir0();
    const { world } = makeWorld({ allowDownload: true, downloadDir: dir }, fetchImpl);
    const text = String(await tool(world, 'lofter_download')({ urls: ['https://imglf5.lf127.net/img/ok.jpg'] }));
    expect(text).toContain('1 张');
    expect(readdirSync(dir)).toContain('ok.jpg');
  });
});

describe('畸形博主名在工具层就挡住', () => {
  it('blog_posts 收到 @evil.com 时直接回执,不发请求', async () => {
    let called = 0;
    const fetchImpl = (async () => { called += 1; return new Response('<html></html>', { status: 200 }); }) as unknown as typeof fetch;
    const { world } = makeWorld({}, fetchImpl);
    const text = String(await tool(world, 'lofter_blog_posts')({ blog: '@evil.com' }));
    expect(text).toContain('字母数字');
    expect(called).toBe(0);
  });

  it('post 的 blog 参数同样校验', async () => {
    const { world } = makeWorld({}, (async () => new Response('', { status: 200 })) as unknown as typeof fetch);
    const text = String(await tool(world, 'lofter_post')({ postId: 'abc_123', blog: 'someone.evil.com' }));
    expect(text).toContain('字母数字');
  });
});

function dir0(): string {
  return mkdtempSync(join(tmpdir(), 'lofter-dl-'));
}
