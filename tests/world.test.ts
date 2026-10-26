import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOFTER_DEFAULTS, type LofterConfigSection } from '../src/config.ts';
import { writeSession } from '../src/session.ts';
import { LofterWorld, subscribeFile } from '../src/world.ts';

type Handler = (args: Record<string, unknown>, ctx?: unknown) => Promise<unknown>;

function makeWorld(overrides: Partial<LofterConfigSection>, fetchImpl?: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), 'lofter-world-'));
  const cfg: LofterConfigSection = { ...LOFTER_DEFAULTS, ...overrides };
  const world = new LofterWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    botDir: dir,
    dataDir: dir,
    fetchImpl,
    sleep: async () => {},
  });
  return { world, dir, cfg };
}

function tool(world: LofterWorld, name: string): Handler {
  const found = world.tools().find((entry) => entry.name === name);
  if (!found || !found.handler) throw new Error('没这个工具: ' + name);
  return found.handler as unknown as Handler;
}

const postsReply = [
  'var s0={};',
  's0.posts[0].postId=101;',
  's0.posts[0].title="第一篇";',
  's0.posts[0].blogId="abc";',
  's0.posts[0].nickName="作者甲";',
  's0.posts[0].publishTime=1714521600000;',
  's0.posts[1].postId=102;',
  's0.posts[1].title="第二篇";',
].join('\n');

const postReply = [
  'var s0={};',
  's0.postId=101;',
  's0.title="第一篇";',
  's0.content="<p>正文第一段</p><p>正文第二段</p>";',
  's0.images[0]="https://img.example.com/a.jpg";',
].join('\n');

describe('未登录', () => {
  it('login_status 直说没登录', async () => {
    const { world } = makeWorld({});
    const text = await tool(world, 'lofter_login_status')({});
    expect(String(text)).toContain('还没登录');
  });

  it('没 Cookie 时取帖给出重粘提示,不是"没有内容"', async () => {
    const { world } = makeWorld({});
    const text = await tool(world, 'lofter_blog_posts')({ blog: 'abc' });
    expect(String(text)).toContain('Cookie');
  });

  it('envPromptVars 报未登录', () => {
    const { world } = makeWorld({});
    expect(world.envPromptVars()['lofter.loggedIn']).toBe('未登录');
  });
});

describe('保存 Cookie', () => {
  it('写入成功后 login_status 报已登录', async () => {
    const fetchImpl = (async () => new Response(postsReply, { status: 200 })) as unknown as typeof fetch;
    const { world } = makeWorld({}, fetchImpl);
    const saved = await world.saveCookie('Cookie: a=1; b=2');
    expect(saved.ok).toBe(true);
    expect(saved.loggedIn).toBe(true);
    const text = await tool(world, 'lofter_login_status')({});
    expect(String(text)).toContain('已登录');
  });

  it('非法 Cookie 直接回错误文案,不落盘', async () => {
    const { world, dir } = makeWorld({});
    const saved = await world.saveCookie('这不是 cookie');
    expect(saved.ok).toBe(false);
    expect(readdirSync(dir)).not.toContain('lofter');
  });

  it('空响应被识别成登录过期', async () => {
    const fetchImpl = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const { world } = makeWorld({}, fetchImpl);
    const saved = await world.saveCookie('a=1');
    expect(saved.loggedIn).toBe(false);
    expect(saved.message).toContain('空响应');
  });

  it('HTTP 502 报上游错误', async () => {
    const fetchImpl = (async () => new Response('bad', { status: 502 })) as unknown as typeof fetch;
    const { world } = makeWorld({}, fetchImpl);
    const saved = await world.saveCookie('a=1');
    expect(saved.loggedIn).toBe(false);
    expect(saved.message).toContain('502');
  });
});

describe('能力门禁', () => {
  function seeded(cfg: Partial<LofterConfigSection>, fetchImpl?: typeof fetch) {
    const made = makeWorld(cfg, fetchImpl);
    writeSession(made.dir, {
      version: 1,
      cookie: 'a=1',
      updatedAt: '2026-10-27T00:00:00.000Z',
      nickname: '',
      scriptSessionId: '',
      httpSessionId: '',
    });
    return made;
  }

  it('标签流关着时不上网,直接说没开', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response(postsReply, { status: 200 });
    }) as unknown as typeof fetch;
    const { world } = seeded({}, fetchImpl);
    const text = await tool(world, 'lofter_tag_posts')({ tag: '摄影' });
    expect(String(text)).toContain('标签流没开');
    expect(called).toBe(false);
  });

  it('搜索关着时不上网', async () => {
    const { world } = seeded({});
    expect(String(await tool(world, 'lofter_search')({ keyword: 'x' }))).toContain('搜索没开');
  });

  it('存图关着时不写盘', async () => {
    const { world } = seeded({});
    expect(String(await tool(world, 'lofter_download')({ urls: ['https://a.com/1.jpg'] }))).toContain('存图没开');
  });

  it('订阅关着时仍可 list', async () => {
    const { world } = seeded({});
    expect(String(await tool(world, 'lofter_watch')({ action: 'list' }))).toContain('还没有订阅');
  });

  it('订阅关着时 add 被挡住', async () => {
    const { world } = seeded({});
    expect(String(await tool(world, 'lofter_watch')({ action: 'add', target: 'abc' }))).toContain('订阅没开');
  });
});

describe('读流', () => {
  const blogHtml = [
    '<html><head><title>某博主 - LOFTER</title></head><body>',
    '<a href="/post/1d124ca3_2b73840be">第一篇</a>',
    '<a href="/post/1f82af0d_2b7341f00">第二篇</a>',
    '</body></html>',
  ].join('');

  const postHtml = [
    '<html><head><title>扬 - 某博主</title></head><body>',
    '<h1 class="title">扬</h1>',
    '<div class="content"><p>正文第一段</p><p>正文第二段</p>',
    '<img src="https://lofter.lf127.net/img/a.jpg">',
    '</div></body></html>',
  ].join('');

  const loginWallHtml = '<html><body><form id="loginForm" action="/front/login">请先登录</form></body></html>';

  // 真机响应是摊开形状:一堆 sN 对象,首变量常是空壳
  const hotReply = [
    'var s16={};',
    'var s0={};',
    's0.permalink="1d124ca3_2b73840be";',
    's0.title="热门一";',
    's0.blogName="abc";',
    's0.content="<p>热门正文一</p>";',
  ].join('\n');

  function ready(cfg: Partial<LofterConfigSection> = {}, route?: (url: string) => string) {
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      const body = route ? route(url) : '';
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const made = makeWorld({ allowTagStream: true, allowSearch: true, ...cfg }, fetchImpl);
    writeSession(made.dir, {
      version: 1, cookie: 'a=1', updatedAt: '', nickname: '', scriptSessionId: '', httpSessionId: '',
    });
    return made;
  }

  it('博主流走 HTML 首屏,列出 permalink 与完整地址', async () => {
    const { world } = ready({}, () => blogHtml);
    const text = String(await tool(world, 'lofter_blog_posts')({ blog: 'abc' }));
    expect(text).toContain('2 条链接');
    expect(text).toContain('1d124ca3_2b73840be');
    expect(text).toContain('https://abc.lofter.com/post/1d124ca3_2b73840be');
  });

  it('博主域名写成 URL 也能认', async () => {
    const { world } = ready({}, () => blogHtml);
    const text = String(await tool(world, 'lofter_blog_posts')({ blog: 'https://abc.lofter.com/index' }));
    expect(text).toContain('博主「abc」');
  });

  it('首页没链接时说清楚,不冒充空列表', async () => {
    const { world } = ready({}, () => '<html><body>nothing</body></html>');
    expect(String(await tool(world, 'lofter_blog_posts')({ blog: 'abc' }))).toContain('没在');
  });

  it('标签流明确说不可用,并给出替代', async () => {
    const { world } = ready({}, () => blogHtml);
    const text = String(await tool(world, 'lofter_tag_posts')({ tag: '摄影' }));
    expect(text).toContain('标签流取不到');
    expect(text).toContain('lofter_hot_posts');
  });

  it('站内搜索明确说不可用', async () => {
    const { world } = ready({}, () => blogHtml);
    const text = String(await tool(world, 'lofter_search')({ keyword: '摄影' }));
    expect(text).toContain('站内搜索不可用');
  });

  it('单篇正文去标签并带图片直链', async () => {
    const { world } = ready({}, () => postHtml);
    const text = String(await tool(world, 'lofter_post')({ postId: '1d124ca3_2b73840be', blog: 'abc' }));
    expect(text).toContain('正文第一段');
    expect(text).toContain('正文第二段');
    expect(text).toContain('https://lofter.lf127.net/img/a.jpg');
    expect(text).not.toContain('<p>');
    expect(text).toContain('《扬》');
  });

  it('postId 给了完整地址时自动推出博主域名', async () => {
    const { world } = ready({}, () => postHtml);
    const text = String(await tool(world, 'lofter_post')({ postId: 'https://abc.lofter.com/post/1d124ca3_2b73840be' }));
    expect(text).toContain('正文第一段');
  });

  it('只有 permalink 没博主域名时明确要域名', async () => {
    const { world } = ready({}, () => postHtml);
    expect(String(await tool(world, 'lofter_post')({ postId: '1d124ca3_2b73840be' }))).toContain('要给博主域名');
  });

  it('正文超限时提示截断', async () => {
    const long = '<html><body><h1 class="title">长文</h1><div class="content"><p>' + 'a'.repeat(600) + '</p></div></body></html>';
    const { world } = ready({ maxBodyChars: 500 }, () => long);
    const text = String(await tool(world, 'lofter_post')({ postId: 'p1', blog: 'abc' }));
    expect(text).toContain('已截断');
    expect(text.length).toBeLessThan(900);
  });

  it('打到登录页时说 Cookie 过期', async () => {
    const { world } = ready({}, () => loginWallHtml);
    expect(String(await tool(world, 'lofter_post')({ postId: 'p1', blog: 'abc' }))).toContain('登录页');
  });

  it('缺 id 时给出提示', async () => {
    const { world } = ready({}, () => postHtml);
    expect(String(await tool(world, 'lofter_post')({}))).toContain('帖子 id');
  });

  it('热门流一次带回列表与正文', async () => {
    const { world } = ready({}, () => hotReply);
    const text = String(await tool(world, 'lofter_hot_posts')({ limit: 5 }));
    expect(text).toContain('热门 1 篇');
    expect(text).toContain('热门正文一');
  });

  it('热门流回空数组时如实说', async () => {
    const { world } = ready({}, () => 'var s0={};');
    expect(String(await tool(world, 'lofter_hot_posts')({}))).toContain('没解析出文章');
  });
});
describe('存图', () => {
  it('按上限落盘,重名加序号', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lofter-dl-'));
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url);
      if (text.endsWith('.jpg')) return new Response(Buffer.from([1, 2, 3]), { status: 200 });
      return new Response(postsReply, { status: 200 });
    }) as unknown as typeof fetch;
    const made = makeWorld({ allowDownload: true, downloadDir: dir }, fetchImpl);
    writeSession(made.dir, {
      version: 1, cookie: 'a=1', updatedAt: '', nickname: '', scriptSessionId: '', httpSessionId: '',
    });
    const text = String(await tool(made.world, 'lofter_download')({
      urls: ['https://imglf5.lf127.net/img/pic.jpg', 'https://imglf5.lf127.net/img/pic.jpg'],
    }));
    expect(text).toContain('2 张');
    const files = readdirSync(dir).sort();
    expect(files).toEqual(['pic-1.jpg', 'pic.jpg']);
    expect(readFileSync(join(dir, 'pic.jpg')).length).toBe(3);
  });

  it('下载失败时逐条报错,不整体暴毙', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lofter-dl-'));
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url);
      if (text.endsWith('.jpg')) return new Response('nope', { status: 404 });
      return new Response(postsReply, { status: 200 });
    }) as unknown as typeof fetch;
    const made = makeWorld({ allowDownload: true, downloadDir: dir }, fetchImpl);
    writeSession(made.dir, {
      version: 1, cookie: 'a=1', updatedAt: '', nickname: '', scriptSessionId: '', httpSessionId: '',
    });
    const text = String(await tool(made.world, 'lofter_download')({ urls: ['https://imglf5.lf127.net/img/pic.jpg'] }));
    expect(text).toContain('失败 1 张');
  });
});

describe('订阅', () => {
  it('add → list → remove 落盘正确', async () => {
    const fetchImpl = (async () => new Response(postsReply, { status: 200 })) as unknown as typeof fetch;
    const { world, dir } = makeWorld({ allowWatch: true }, fetchImpl);
    writeSession(dir, {
      version: 1, cookie: 'a=1', updatedAt: '', nickname: '', scriptSessionId: '', httpSessionId: '',
    });
    expect(String(await tool(world, 'lofter_watch')({ action: 'add', target: 'abc' }))).toContain('已登记');
    expect(String(await tool(world, 'lofter_watch')({ action: 'add', target: 'abc' }))).toContain('已经在订阅里');
    expect(String(await tool(world, 'lofter_watch')({ action: 'list' }))).toContain('[blog] abc');
    const stored = JSON.parse(readFileSync(subscribeFile(dir), 'utf8')) as Array<{ target: string }>;
    expect(stored.map((item) => item.target)).toEqual(['abc']);
    expect(String(await tool(world, 'lofter_watch')({ action: 'remove', target: 'abc' }))).toContain('还剩 0 项');
  });

  it('check 首次记基线,第二次报没有新帖', async () => {
    const page = '<html><body><a href="/post/abc_123">新的</a></body></html>';
    const fetchImpl = (async () => new Response(page, { status: 200 })) as unknown as typeof fetch;
    const { world, dir } = makeWorld({ allowWatch: true }, fetchImpl);
    writeSession(dir, {
      version: 1, cookie: 'a=1', updatedAt: '', nickname: '', scriptSessionId: '', httpSessionId: '',
    });
    await tool(world, 'lofter_watch')({ action: 'add', target: 'abc' });
    const first = String(await tool(world, 'lofter_watch')({ action: 'check' }));
    expect(first).toContain('首次检查');
    const second = String(await tool(world, 'lofter_watch')({ action: 'check' }));
    expect(second).toContain('没有新帖');
  });
});

describe('面板', () => {
  it('state 给出登录态与四个开关', () => {
    const { world } = makeWorld({ allowTagStream: true });
    const state = world.panelState();
    expect(state.loggedIn).toBe(false);
    expect(state.abilities.tagStream).toBe(true);
    expect(state.abilities.search).toBe(false);
    expect(state.sessionFile).toContain('session.json');
  });

  it('clear-cookie 之后 loggedIn 为 false', async () => {
    const fetchImpl = (async () => new Response(postsReply, { status: 200 })) as unknown as typeof fetch;
    const { world } = makeWorld({}, fetchImpl);
    await world.saveCookie('a=1');
    expect(world.panelState().loggedIn).toBe(true);
    world.clearCookie();
    expect(world.panelState().loggedIn).toBe(false);
  });

  it('未知面板方法抛错', async () => {
    const { world } = makeWorld({});
    await expect(world.invoke('lofter', 'nope', [])).rejects.toThrow();
  });

  it('envPromptVars 列出已开能力', () => {
    const { world } = makeWorld({ allowTagStream: true, allowDownload: true });
    expect(world.envPromptVars()['lofter.abilities']).toBe('标签流、存图');
  });
});
