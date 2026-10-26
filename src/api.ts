/**
 * LOFTER 的 HTTP 层:只管把人话变成一次 DWR 调用,再把响应摊回对象。
 *
 * 三条硬约束来自实测:
 *   1) 未登录时 LOFTER 不报 401,而是 200 + 空体 —— 所以"空体"必须被识别成没登录,
 *      否则上层会把一次登录失败当成"这个博主没发过帖子"。
 *   2) 请求要带站点自己的 Cookie 与 Referer,裸 UA 会被判爬虫。
 *   3) 连续裸奔会挨限流,所以每次调用之间至少隔 requestIntervalMs。
 * 这一层不碰文件、不碰配置,方便用假的 fetch 做单测。
 */
import { buildDwrRequest, firstDwrReply, parseDwrReply, type DwrParam } from './dwr.ts';
import { assertLofterPageUrl } from './guard.ts';
import type { LofterSession } from './session.ts';

/** 没登录 / 登录态过期。调用方据此提示用户去面板重粘 Cookie。 */
export class LofterAuthError extends Error {
  constructor(message = 'LOFTER 没登录:面板里的 Cookie 为空或已过期。') {
    super(message);
    this.name = 'LofterAuthError';
  }
}

/** 站点侧回的响应不像话(502、挑战页、非预期结构)。 */
export class LofterUpstreamError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'LofterUpstreamError';
    this.status = status;
  }
}

/**
 * DWR 回了 IllegalArgumentException —— 「这个方法吃不下你给的东西」。
 *
 * 精度说明(2026-10 实测):站点把三种情况合并成同一个 139 字节的错误,分不开:
 *   - 方法名不存在;
 *   - 实参个数/类型不对;
 *   - 缺 DWR 会话粘性字段(httpSessionId / scriptSessionId)。
 * 能分开的只有 Bean 名:写错时是 SecurityException("No class by name: X")。
 * 因为分不开,上层拿到它就该换一组候选再试(见 callAdaptive / callChain),
 * 而不是认定某一处错了。
 */
export class LofterSignatureError extends Error {
  constructor(message = 'LOFTER 说参数对不上(IllegalArgumentException),Bean 名没问题,是实参签名不匹配。') {
    super(message);
    this.name = 'LofterSignatureError';
  }
}

/** 一次 DWR 响应文本里能读出的站点态度。 */
export type DwrFault = 'none' | 'bad-signature' | 'no-such-bean' | 'denied';

/**
 * 从响应文本判读站点的错误类型。
 *
 * 实测(2026-10,未登录直连 /dwr/mobile/call/plaincall/):
 *   - 正常返回是 s0.xxx = ... 的 JS 赋值;
 *   - Bean 名写错   -> SecurityException + "No class by name: X"(324 字节);
 *   - 实参签名不对 -> IllegalArgumentException("Error")(139 字节);
 *   - 未登录        -> 200 + 空体(不在这里判,调用方先看空体)。
 */
export function classifyDwrFault(text: string): DwrFault {
  if (text.includes('IllegalArgumentException')) return 'bad-signature';
  if (text.includes('SecurityException')) {
    return /No class by name/i.test(text) ? 'no-such-bean' : 'denied';
  }
  return 'none';
}

/** 一组候选实参。label 只用于日志与命中缓存的键,不参与请求。 */
export interface DwrVariant {
  label: string;
  params: DwrParam[];
}

/** 一次具体的接口候选:哪个 Bean 的哪个方法,配哪几组实参。 */
export interface DwrCall {
  bean: string;
  method: string;
  variants: DwrVariant[];
}

export interface LofterApiOptions {
  /** 取当前会话(每次调用现取,面板改了 Cookie 立刻生效)。 */
  session: () => LofterSession;
  /** 两次请求之间的最小间隔。 */
  requestIntervalMs: () => number;
  /** 换掉 fetch 用,单测注入。 */
  fetchImpl?: typeof fetch;
  /** 记一条日志。 */
  log?: (message: string) => void;
  /** 睡多久,sleep 注入同样为了单测。 */
  sleep?: (ms: number) => Promise<void>;
  /** 站点根。 */
  origin?: string;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 探活用的候选实参。
 *
 * 用空博主名 + 一页来探,是最轻的一次读;四种签名都排上,是因为站点没公开过
 * getPostList 到底吃几个参数 —— 探活顺手把签名试出来,后面正式调用就省一轮。
 */
const PROBE_VARIANTS: DwrVariant[] = [
  { label: 'blog,offset,limit', params: ['', 0, 1] },
  { label: 'blog,offset', params: ['', 0] },
  { label: 'blog,limit', params: ['', 1] },
  { label: 'blog', params: [''] },
];

export class LofterApi {
  private lastCallAt = 0;
  /** bean.method -> 命中过的实参签名标签。进程内记忆,重启后重新试一轮。 */
  private readonly signatures = new Map<string, string>();

  constructor(private readonly opts: LofterApiOptions) {}

  private get fetchImpl(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  /** 限速:和上一次调用至少隔 requestIntervalMs。 */
  private async gate(): Promise<void> {
    const interval = Math.max(0, Math.floor(this.opts.requestIntervalMs()));
    if (interval === 0) return;
    const wait = this.lastCallAt + interval - Date.now();
    if (wait > 0) await (this.opts.sleep ?? realSleep)(wait);
    this.lastCallAt = Date.now();
  }

  /**
   * 调一次 DWR。
   *
   * @param bean   Bean 名
   * @param method 方法名
   * @param params 实参
   */
  async call(bean: string, method: string, params: DwrParam[] = []): Promise<unknown> {
    const text = await this.callText(bean, method, params);
    const reply = firstDwrReply(text);
    if (reply === undefined) {
      throw new LofterUpstreamError('LOFTER 的响应不是 DWR 格式,可能被拦在登录页了。');
    }
    return reply;
  }

  /**
   * 一次调用的全部顶层值,按 s 编号升序。
   *
   * 为什么需要它:实测 PostBean.getHotPosts 的响应是 `var s16={}; var s30={}; ...
   * var s0={}` 这种一堆对象摊开的形状,而 firstDwrReply 取的是文本里第一个出现的
   * 变量 —— 那个往往只是空壳。要拿真正的数据,得看全部值里谁带着 permalink/title。
   */
  async callValues(bean: string, method: string, params: DwrParam[] = []): Promise<unknown[]> {
    const text = await this.callText(bean, method, params);
    const roots = parseDwrReply(text);
    return Object.keys(roots)
      .sort((a, b) => Number(a.replace(/^s/, '')) - Number(b.replace(/^s/, '')))
      .map((key) => roots[key])
      .filter((value) => value !== undefined);
  }

  /** 发一次请求、拿回原始文本;所有错误分类集中在这里。 */
  private async callText(bean: string, method: string, params: DwrParam[]): Promise<string> {
    const session = this.opts.session();
    if (session.cookie.trim() === '') throw new LofterAuthError();
    await this.gate();
    const request = buildDwrRequest(
      bean,
      method,
      params,
      { scriptSessionId: session.scriptSessionId, httpSessionId: session.httpSessionId },
      this.opts.origin,
    );
    let response: Response;
    try {
      response = await this.fetchImpl(request.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain; charset=UTF-8',
          'User-Agent': DEFAULT_UA,
          Accept: '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Cookie: session.cookie,
          Referer: 'https://www.lofter.com/front/discover',
          Origin: 'https://www.lofter.com',
        },
        body: request.body,
        redirect: 'follow',
      });
    } catch (error) {
      this.opts.log?.('lofter: 请求失败 ' + String(error));
      throw new LofterUpstreamError('LOFTER 请求发不出去:' + (error instanceof Error ? error.message : String(error)));
    }
    if (response.status !== 200) {
      throw new LofterUpstreamError('LOFTER 返回 HTTP ' + response.status, response.status);
    }
    let text = '';
    try {
      text = await response.text();
    } catch {
      text = '';
    }
    if (text.trim() === '') {
      // 实测:未登录就是这个样子,不是"没有数据"
      throw new LofterAuthError('LOFTER 回了空响应,通常是 Cookie 过期了。');
    }
    const fault = classifyDwrFault(text);
    if (fault === 'bad-signature') throw new LofterSignatureError();
    if (fault === 'no-such-bean') {
      throw new LofterUpstreamError('LOFTER 不认这个接口(No class by name),站点大概率改过 Bean 名。');
    }
    if (fault === 'denied') {
      throw new LofterUpstreamError('LOFTER 拒了这次调用,可能要去浏览器里过一次人机验证。');
    }
    return text;
  }
  /**
   * 抓一个服务端渲染的 HTML 页面。
   *
   * 为什么 DWR 不够:实测移动 DWR 层只有「热门」和「首页推荐」两条流能稳定出数,
   * 单篇正文与博主文章流都得读 HTML —— 单篇 https://<blog>.lofter.com/post/<permalink>
   * 实测 200 / 15KB 量级,正文在 <div class="content"> 里。
   *
   * @param url 绝对地址
   */
  async fetchPage(url: string): Promise<string> {
    const target = assertLofterPageUrl(url);
    const session = this.opts.session();
    if (session.cookie.trim() === '') throw new LofterAuthError();
    await this.gate();
    let response: Response;
    try {
      response = await this.fetchImpl(target.href, {
        method: 'GET',
        headers: {
          'User-Agent': DEFAULT_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Cookie: session.cookie,
          Referer: 'https://www.lofter.com/front/discover',
        },
        redirect: 'follow',
      });
    } catch (error) {
      this.opts.log?.('lofter: 页面请求失败 ' + String(error));
      throw new LofterUpstreamError('LOFTER 页面拉不下来:' + (error instanceof Error ? error.message : String(error)));
    }
    if (response.status === 404) {
      throw new LofterUpstreamError(
        'LOFTER 说这一篇不存在(HTTP 404)。permalink 形状是 <8位hex>_<9位hex>,纯数字拼出来一定是 404。',
        404,
      );
    }
    if (response.status !== 200) {
      throw new LofterUpstreamError('LOFTER 页面返回 HTTP ' + response.status, response.status);
    }
    let text = '';
    try {
      text = await response.text();
    } catch {
      text = '';
    }
    if (text.trim() === '') {
      throw new LofterAuthError('LOFTER 页面回了空内容,通常是 Cookie 过期了。');
    }
    return text;
  }

  /**
   * 带着「实参签名不确定」这件事去调一次 DWR。
   *
   * LOFTER 没公开过 DWR 的方法签名,而参数不对时站点只回一个 139 字节的
   * IllegalArgumentException —— 不带任何期望签名的线索。所以这里把同一个方法的
   * 几种常见签名按可能性排好队逐个试,谁不报 IllegalArgumentException 就用谁,
   * 并把命中过的标签记下来,下次同进程内直接先试它。
   *
   * 只有 LofterSignatureError 会被吞掉;没登录、Bean 名错、被拦 一律立刻上抛,
   * 免得把「Cookie 过期」误当成「多试几组参数」。
   */
  async callAdaptive(bean: string, method: string, variants: DwrVariant[]): Promise<unknown> {
    if (variants.length === 0) throw new LofterSignatureError('没有可用的实参签名。');
    const key = bean + '.' + method;
    const known = this.signatures.get(key);
    const ordered =
      known === undefined
        ? variants
        : [...variants].sort((a, b) => (a.label === known ? -1 : b.label === known ? 1 : 0));
    let lastError: LofterSignatureError | undefined;
    for (const variant of ordered) {
      try {
        const reply = await this.call(bean, method, variant.params);
        if (known !== variant.label) {
          this.signatures.set(key, variant.label);
          this.opts.log?.('lofter: ' + key + ' 命中实参签名 ' + variant.label);
        }
        return reply;
      } catch (error) {
        if (error instanceof LofterSignatureError) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    throw new LofterSignatureError(
      (lastError?.message ?? '实参签名全都对不上。') + '(试过 ' + variants.length + ' 种:' + variants.map((v) => v.label).join(' / ') + ')',
    );
  }

  /** 与 callAdaptive 同策略,但返回全部顶层值(给摊开式响应用)。 */
  async callAdaptiveValues(bean: string, method: string, variants: DwrVariant[]): Promise<unknown[]> {
    if (variants.length === 0) throw new LofterSignatureError('没有可用的实参签名。');
    const key = bean + '.' + method;
    const known = this.signatures.get(key);
    const ordered =
      known === undefined
        ? variants
        : [...variants].sort((a, b) => (a.label === known ? -1 : b.label === known ? 1 : 0));
    let lastError: LofterSignatureError | undefined;
    for (const variant of ordered) {
      try {
        const values = await this.callValues(bean, method, variant.params);
        if (known !== variant.label) {
          this.signatures.set(key, variant.label);
          this.opts.log?.('lofter: ' + key + ' 命中实参签名 ' + variant.label);
        }
        return values;
      } catch (error) {
        if (error instanceof LofterSignatureError) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    throw new LofterSignatureError(
      (lastError?.message ?? '实参签名全都对不上。') + '(试过 ' + variants.length + ' 种:' + variants.map((v) => v.label).join(' / ') + ')',
    );
  }
  /**
   * 一串候选接口,按顺序试。
   *
   * 用途:同一个功能在站点上可能挂在不同的 Bean 上(实测 BlogBean 与 PostBean 同时
   * 存在,单篇正文两边都有 getPost)。这里把「先试谁后试谁」显式写出来,
   * 只在「签名全不对」或「Bean 不存在」时往下走,其余错误(没登录、被拦)立刻上抛。
   */
  async callChain(calls: DwrCall[]): Promise<unknown> {
    if (calls.length === 0) throw new LofterSignatureError('没有可用的接口候选。');
    let lastError: Error | undefined;
    for (const call of calls) {
      try {
        return await this.callAdaptive(call.bean, call.method, call.variants);
      } catch (error) {
        if (error instanceof LofterSignatureError) {
          lastError = error;
          continue;
        }
        if (error instanceof LofterUpstreamError && /No class by name/.test(error.message)) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    throw lastError ?? new LofterSignatureError('候选接口全都不通。');
  }

  /** 当前进程内记住的实参签名,面板与日志可以读出来排障。 */
  knownSignatures(): Record<string, string> {
    return Object.fromEntries(this.signatures);
  }

  /**
   * 探活:用一次最轻的读调用判断登录态还行不行。
   * 只关心「通不通」,不解释业务错误 —— 上层据此显示已登录/过期。
   */
  async probe(): Promise<{ ok: boolean; message: string }> {
    try {
      // 探活不只看通不通,还顺手把实参签名试出来:命中后同进程内的正式调用就不用再试。
      await this.callAdaptive(
        'BlogBean',
        'getPostList',
        PROBE_VARIANTS,
      );
      return { ok: true, message: 'Cookie 可用。' };
    } catch (error) {
      if (error instanceof LofterAuthError) return { ok: false, message: error.message };
      if (error instanceof LofterUpstreamError) return { ok: false, message: error.message };
      if (error instanceof LofterSignatureError) {
        return { ok: false, message: 'Bean 名是对的,但这几组实参签名都被拒了 —— 站点可能换了方法签名。' + error.message };
      }
      return { ok: false, message: '探活失败:' + (error instanceof Error ? error.message : String(error)) };
    }
  }
}

/** 把任意错误翻成给人看的一句话,工具回执里用。 */
export function describeError(error: unknown): string {
  if (error instanceof LofterAuthError) return error.message + ' 到「LOFTER 阅读」面板重新粘贴一次 Cookie。';
  if (error instanceof LofterUpstreamError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
