/**
 * 实参签名自适应:真机上「Bean 名对、实参不对」只会回一个不带线索的
 * IllegalArgumentException,所以调用层必须自己排队试签名。这里锁住这几条行为:
 *   - IAE 换下一组,命中后记住;
 *   - 全 IAE 时报错且把试过的标签列出来;
 *   - Bean 名错 / 未登录 立刻上抛,不许被当成「再试一组」;
 *   - 响应判读函数对四类文本给出正确分类。
 */
import { describe, expect, it } from 'vitest';
import {
  LofterApi,
  LofterAuthError,
  LofterSignatureError,
  LofterUpstreamError,
  classifyDwrFault,
  type DwrCall,
  type DwrVariant,
} from '../src/api.ts';
import type { LofterSession } from '../src/session.ts';

const IAE =
  '//#DWR-INSERT\n//#DWR-REPLY\ndwr.engine._remoteHandleException(\'0\',\'0\',{javaClassName:"java.lang.IllegalArgumentException",message:"Error"});';
const NO_CLASS =
  '//#DWR-REPLY\ndwr.engine._remoteHandleBatchException({ name:\'java.lang.SecurityException\', message:\'No class by name: SearchBean\' }, \'0\');';
const DENIED =
  '//#DWR-REPLY\ndwr.engine._remoteHandleBatchException({ name:\'java.lang.SecurityException\', message:\'Access denied\' }, \'0\');';
const OK = 'var s0={};\ns0.postId=101;\ns0.title="第一篇";';

function makeSession(cookie = 'a=1; b=2'): LofterSession {
  return {
    version: 1,
    cookie,
    updatedAt: '2026-10-27T00:00:00.000Z',
    nickname: '',
    scriptSessionId: '',
    httpSessionId: '',
  };
}

/** 按脚本顺序回文本,并记下每次请求体与次数。 */
function scripted(replies: string[]) {
  const bodies: string[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ''));
    const text = replies[Math.min(bodies.length - 1, replies.length - 1)] ?? '';
    return new Response(text, { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

function makeApi(replies: string[], variantsSession = makeSession()) {
  const { impl, bodies } = scripted(replies);
  const api = new LofterApi({
    session: () => variantsSession,
    requestIntervalMs: () => 0,
    fetchImpl: impl,
  });
  return { api, bodies };
}

const VARIANTS: DwrVariant[] = [
  { label: 'v1', params: ['x', 0, 5] },
  { label: 'v2', params: ['x', 0] },
  { label: 'v3', params: ['x'] },
];

describe('classifyDwrFault', () => {
  it('把 IllegalArgumentException 判成实参签名不对', () => {
    expect(classifyDwrFault(IAE)).toBe('bad-signature');
  });

  it('把 No class by name 判成 Bean 名不存在', () => {
    expect(classifyDwrFault(NO_CLASS)).toBe('no-such-bean');
  });

  it('其余 SecurityException 判成被拒', () => {
    expect(classifyDwrFault(DENIED)).toBe('denied');
  });

  it('正常响应判成没有错误', () => {
    expect(classifyDwrFault(OK)).toBe('none');
  });
});

describe('callAdaptive', () => {
  it('第一组被 IAE 顶回来就换第二组,命中后返回数据', async () => {
    const { api, bodies } = makeApi([IAE, OK]);
    const reply = await api.callAdaptive('BlogBean', 'getPostList', VARIANTS);
    expect(reply).toEqual({ postId: 101, title: '第一篇' });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('c0-param0=string:x');
    expect(bodies[0]).toContain('c0-param2=number:5');
    expect(bodies[1]).not.toContain('c0-param2');
  });

  it('命中过的签名会缓存,下一次先试它', async () => {
    const { api, bodies } = makeApi([IAE, OK, OK]);
    await api.callAdaptive('BlogBean', 'getPostList', VARIANTS);
    await api.callAdaptive('BlogBean', 'getPostList', VARIANTS);
    expect(api.knownSignatures()).toEqual({ 'BlogBean.getPostList': 'v2' });
    // 第一次 2 个请求(IAE + OK),第二次直接命中缓存所以只有 1 个
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).not.toContain('c0-param2');
  });

  it('全部被 IAE 顶回来时报签名错误,并列出试过的标签', async () => {
    const { api, bodies } = makeApi([IAE, IAE, IAE]);
    await expect(api.callAdaptive('BlogBean', 'getPostList', VARIANTS)).rejects.toThrow(LofterSignatureError);
    await expect(api.callAdaptive('BlogBean', 'getPostList', VARIANTS)).rejects.toThrow(/v1 \/ v2 \/ v3/);
    expect(bodies).toHaveLength(6);
  });

  it('Bean 名不存在时立刻上抛,不再换签名', async () => {
    const { api, bodies } = makeApi([NO_CLASS, OK]);
    await expect(api.callAdaptive('SearchBean', 'search', VARIANTS)).rejects.toThrow(LofterUpstreamError);
    expect(bodies).toHaveLength(1);
  });

  it('空响应(没登录)时立刻上抛,不再换签名', async () => {
    const { api, bodies } = makeApi(['', OK]);
    await expect(api.callAdaptive('BlogBean', 'getPostList', VARIANTS)).rejects.toThrow(LofterAuthError);
    expect(bodies).toHaveLength(1);
  });

  it('没有候选签名时直接报签名错误', async () => {
    const { api, bodies } = makeApi([OK]);
    await expect(api.callAdaptive('BlogBean', 'getPostList', [])).rejects.toThrow(LofterSignatureError);
    expect(bodies).toHaveLength(0);
  });
});

describe('probe', () => {
  it('探活成功时把命中的签名记下来', async () => {
    const { api } = makeApi([IAE, OK]);
    const result = await api.probe();
    expect(result.ok).toBe(true);
    expect(Object.keys(api.knownSignatures())).toEqual(['BlogBean.getPostList']);
  });

  it('探活遇到 Bean 名问题时不谎报成功', async () => {
    const { api } = makeApi([NO_CLASS]);
    const result = await api.probe();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('No class by name');
  });
});

describe('callChain', () => {
  const FIRST: DwrCall = { bean: 'NoSuchBean', method: 'getPost', variants: [{ label: 'a', params: ['1'] }] };
  const SECOND: DwrCall = { bean: 'PostBean', method: 'getPost', variants: [{ label: 'b', params: ['1'] }] };

  it('前一个 Bean 不存在时换下一个候选', async () => {
    const { api, bodies } = makeApi([NO_CLASS, OK]);
    const reply = await api.callChain([FIRST, SECOND]);
    expect(reply).toEqual({ postId: 101, title: '第一篇' });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('c0-scriptName=NoSuchBean');
    expect(bodies[1]).toContain('c0-scriptName=PostBean');
  });

  it('前一个候选签名全不对时换下一个候选', async () => {
    // 前 3 次都 IAE(把第一个候选的 3 组签名全耗掉),第 4 次才成功
    const { api, bodies } = makeApi([IAE, IAE, IAE, OK]);
    const reply = await api.callChain([
      { bean: 'PostBean', method: 'getPost', variants: VARIANTS },
      { bean: 'BlogBean', method: 'getPost', variants: [{ label: 'c', params: ['1'] }] },
    ]);
    expect(reply).toEqual({ postId: 101, title: '第一篇' });
    expect(bodies).toHaveLength(4);
    expect(bodies[0]).toContain('c0-scriptName=PostBean');
    expect(bodies[2]).toContain('c0-scriptName=PostBean');
    expect(bodies[3]).toContain('c0-scriptName=BlogBean');
  });

  it('没登录时立刻上抛,不许在各候选之间白试', async () => {
    const { api, bodies } = makeApi(['', OK]);
    await expect(api.callChain([FIRST, SECOND])).rejects.toThrow(LofterAuthError);
    expect(bodies).toHaveLength(1);
  });

  it('候选全空时直接报错且不发请求', async () => {
    const { api, bodies } = makeApi([OK]);
    await expect(api.callChain([])).rejects.toThrow(LofterSignatureError);
    expect(bodies).toHaveLength(0);
  });
});