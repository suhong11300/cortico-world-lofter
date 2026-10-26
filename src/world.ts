/**
 * LOFTER 阅读 World。
 *
 * 装上不等于开工:默认全被动 —— 用户在对话里说要看哪一篇、哪个博主,模型才去取,
 * 取回来的正文直接进对话,不写盘、不定时联网。标签流、搜索、存图、订阅各是一个
 * 配置开关,关着时对应工具会直接告诉模型"这个能力没开",而不是偷偷联网。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { LofterApi, LofterUpstreamError, describeError, type DwrCall, type DwrVariant } from './api.ts';
import { LOFTER_CONFIG_GROUP, type LofterConfigSection } from './config.ts';
import {
  clearSession,
  hasCookie,
  maskCookie,
  normalizeCookie,
  readSession,
  sessionFile,
  writeSession,
  type LofterSession,
} from './session.ts';
import {
  collectImages,
  describeCounts,
  htmlToText,
  normalizePost,
  normalizePostDetail,
  type LofterPostDetail,
  type LofterPostSummary,
} from './types.ts';
import {
  blogNameFromUrl,
  extractPageImages,
  extractPermalinks,
  extractPostBody,
  extractPostTitle,
  looksLikeLoginWall,
} from './html.ts';
import { MAX_IMAGE_BYTES, assertImageUrl, normalizeBlogName } from './guard.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 面板 id:同一页内唯一,不带 World 前缀。 */
export const LOFTER_PANEL = 'lofter';

/**
 * LOFTER 的 DWR 接口表。
 *
 * 站点把读接口都挂在 DWR 上,Bean 名没有公开文档,这张表是从页面内联脚本与前端
 * bundle 里读出来的。站点换名时只改这里 —— 面板的「探活」会告诉你哪一条还通。
 */
export const DWR_ENDPOINTS = {
  /**
   * 热门文章。**唯一一条真机验证过能出数的列表接口**(2026-10-27 实测):
   *
   *   getHotPosts(number:0, number:10) -> 143247 字节 / 10 篇
   *
   * 每篇都是完整对象,直接带 content(HTML 正文)、title、permalink、blogId、
   * blogName、publishTime、digest —— 一次请求把列表和正文都拿到了,不用二次取详情。
   */
  hotPosts: {
    bean: 'PostBean',
    method: 'getHotPosts',
    variants: (offset: number, limit: number): DwrVariant[] => [
      { label: 'offset,limit', params: [offset, limit] },
      { label: 'offset', params: [offset] },
    ],
  },
  /**
   * 首页随机推荐。零参,实测 18643 字节。
   *
   * 字段:id / imageUrl / imageUrl2 / linkUrl / blogId / blogName / editorUserId。
   * 注意它给的是「推荐位」不是完整文章,正文要另取。
   */
  recommend: {
    bean: 'TagBean',
    method: 'getRandomRTPostList',
    variants: (): DwrVariant[] => [{ label: 'no-args', params: [] }],
  },
  /**
   * 博主主页的帖子流。
   *
   * @deprecated 未校准 —— 真机实测这个方法在存根里根本不存在
   * (`/dwr/interface/BlogBean.js` 里没有 getPostList),博主文章流改走 HTML。
   * 留着只当历史记录,别再拿它发请求。
   */
  blogPosts: {
    bean: 'BlogBean',
    method: 'getPostList',
    variants: (blog: string, offset: number, limit: number): DwrVariant[] => [
      { label: 'blog,offset,limit', params: [blog, offset, limit] },
      { label: 'blog,offset', params: [blog, offset] },
      { label: 'blog,limit,offset', params: [blog, limit, offset] },
      { label: 'blog', params: [blog] },
    ],
  },
  /**
   * 单篇正文。
   *
   * 实测 PostBean 与 BlogBean 同时存在(未登录探测能分开「No class by name」与
   * 「IllegalArgumentException」),两个都排上;前者语义更正,所以优先。
   */
  post: {
    calls: (postId: string, blog: string): DwrCall[] => [
      {
        bean: 'PostBean',
        method: 'getPost',
        variants: [
          { label: 'postId', params: [postId] },
          { label: 'blog,postId', params: [blog, postId] },
        ],
      },
      {
        bean: 'BlogBean',
        method: 'getPost',
        variants: [
          { label: 'postId', params: [postId] },
          { label: 'blog,postId', params: [blog, postId] },
          { label: 'postId,blog', params: [postId, blog] },
        ],
      },
    ],
  },
  /** 标签流。 */
  tagPosts: {
    bean: 'TagBean',
    method: 'getTagPostList',
    variants: (tag: string, limit: number): DwrVariant[] => [
      { label: 'tag,limit', params: [tag, limit] },
      { label: 'tag,offset,limit', params: [tag, 0, limit] },
      { label: 'tag', params: [tag] },
    ],
  },
  /**
   * 站内搜索。
   *
   * 说明:实测 SearchBean 在 mobile DWR 上不存在(直接回 No class by name),
   * 十几个搜索类候选名也都是这个结果 —— 站内搜索大概率不在这一层。这里保留
   * 声明,只在站点哪天把它补回来时才有用;真机上走不通时工具会直说原因。
   */
  search: {
    calls: (keyword: string, limit: number): DwrCall[] => [
      {
        bean: 'SearchBean',
        method: 'search',
        variants: [
          { label: 'keyword,limit', params: [keyword, limit] },
          { label: 'keyword,offset,limit', params: [keyword, 0, limit] },
          { label: 'keyword', params: [keyword] },
        ],
      },
    ],
  },
} as const;

export interface LofterWorldOptions {
  /** worlds.lofter 的活引用。 */
  cfg: LofterConfigSection;
  timezone: string;
  /** 部署目录:config.json 在这里。 */
  botDir: string;
  /** 数据目录:登录态与订阅都在 dataDir/lofter 下。 */
  dataDir: string;
  /** 换掉 fetch,单测注入。 */
  fetchImpl?: typeof fetch;
  /** 换掉 sleep,单测注入。 */
  sleep?: (ms: number) => Promise<void>;
}

/** 面板首屏。 */
export interface LofterPanelState {
  loggedIn: boolean;
  /** 脱敏后的 Cookie 摘要,面板上显示"已登录"时给人看的。 */
  cookieHint: string;
  updatedAt: string;
  nickname: string;
  /** 登录态文件位置,方便用户自己删。 */
  sessionFile: string;
  /** 四个能力的开关快照。 */
  abilities: {
    tagStream: boolean;
    search: boolean;
    download: boolean;
    watch: boolean;
  };
  /** 存图目录的最终落点。 */
  downloadDir: string;
}

/** 面板「保存并探活」的回执。 */
export interface LofterSaveResult {
  ok: boolean;
  loggedIn: boolean;
  cookieHint: string;
  message: string;
}

function readSubscribeFile(dataDir: string): WatchEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(subscribeFile(dataDir), 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => normalizeWatchEntry(item))
      .filter((item): item is WatchEntry => item !== undefined);
  } catch {
    return [];
  }
}

export interface WatchEntry {
  /** 订阅目标:博主域名或标签名。 */
  target: string;
  /** blog 或 tag。 */
  kind: 'blog' | 'tag';
  /** 上次检查时见到的最新一篇,用来判"有没有新帖"。 */
  lastPostId: string;
  /** 上次检查时间(ISO)。 */
  checkedAt: string;
}

export function subscribeFile(dataDir: string): string {
  return join(dataDir, 'lofter', 'watch.json');
}

function normalizeWatchEntry(raw: unknown): WatchEntry | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const target = typeof record.target === 'string' ? record.target.trim() : '';
  if (target === '') return undefined;
  const kind = record.kind === 'tag' ? 'tag' : 'blog';
  return {
    target,
    kind,
    lastPostId: typeof record.lastPostId === 'string' ? record.lastPostId : '',
    checkedAt: typeof record.checkedAt === 'string' ? record.checkedAt : '',
  };
}

export class LofterWorld implements World {
  readonly id = 'lofter';

  private api?: LofterApi;

  constructor(private readonly opts: LofterWorldOptions) {}

  /** 现取会话:面板改完立刻生效,不用重启 World。 */
  session(): LofterSession {
    return readSession(this.opts.dataDir);
  }

  private client(): LofterApi {
    if (!this.api) {
      this.api = new LofterApi({
        session: () => this.session(),
        requestIntervalMs: () => this.opts.cfg.requestIntervalMs,
        fetchImpl: this.opts.fetchImpl,
        sleep: this.opts.sleep,
        log: (message) => this.host?.log?.info(message),
      });
    }
    return this.api;
  }

  private host?: WorldHost;

  /** 存图目录:配置优先,否则 data/lofter/images。 */
  downloadDir(): string {
    const configured = this.opts.cfg.downloadDir.trim();
    return configured !== '' ? configured : join(this.opts.dataDir, 'lofter', 'images');
  }

  abilities() {
    return {
      tagStream: this.opts.cfg.allowTagStream === true,
      search: this.opts.cfg.allowSearch === true,
      download: this.opts.cfg.allowDownload === true,
      watch: this.opts.cfg.allowWatch === true,
    };
  }

  /** 只报值;段落文本一律来自 ENV_PROMPT.md 模板。 */
  envPromptVars(): Record<string, string> {
    const session = this.session();
    const abilities = this.abilities();
    const on: string[] = [];
    if (abilities.tagStream) on.push('标签流');
    if (abilities.search) on.push('站内搜索');
    if (abilities.download) on.push('存图');
    if (abilities.watch) on.push('订阅');
    return {
      'lofter.loggedIn': hasCookie(session) ? '已登录' : '未登录',
      'lofter.nickname': session.nickname,
      'lofter.abilities': on.length === 0 ? '只读单篇与博主主页' : on.join('、'),
    };
  }

  tools(): ToolDef[] {
    return [
      this.loginStatusTool(),
      this.loginCookieTool(),
      this.blogPostsTool(),
      this.tagPostsTool(),
      this.searchTool(),
      this.postTool(),
      this.hotPostsTool(),
      this.downloadTool(),
      this.watchTool(),
    ];
  }

  webUi(): WorldWebUiDecl {
    return {
      panels: [
        {
          id: LOFTER_PANEL,
          title: 'LOFTER 阅读',
          description: '粘一次 Cookie 就能读博文;标签流、搜索、存图、订阅各自一个开关,默认全关。',
        },
      ],
      invoke: (panel, method, args) => this.invoke(panel, method, args),
      config: [LOFTER_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.lofter.envPrompt',
          title: 'LOFTER 阅读 · 环境提示词',
          description: '把登录态与已开的能力放进 system 前缀,模型才知道自己能不能联网取文。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'lofter.loggedIn', description: '已登录 / 未登录。' },
            { name: 'lofter.nickname', description: '探活拿到的昵称;没探过时为空。' },
            { name: 'lofter.abilities', description: '当前已打开的可选能力;全关时给一句默认说明。' },
          ],
        },
      ],
    };
  }

  /** 面板数据面:state 读,save-cookie / clear-cookie / probe 写。 */
  async invoke(panel: string, method: string, args: unknown[]): Promise<unknown> {
    if (panel !== LOFTER_PANEL) throw new Error('未知面板: ' + panel);
    if (method === 'state') return this.panelState();
    if (method === 'save-cookie') return this.saveCookie(args[0]);
    if (method === 'clear-cookie') return this.clearCookie();
    if (method === 'probe') return this.probePanel();
    throw new Error('未知面板方法: ' + panel + '/' + method);
  }

  panelState(): LofterPanelState {
    const session = this.session();
    const abilities = this.abilities();
    return {
      loggedIn: hasCookie(session),
      cookieHint: maskCookie(session.cookie),
      updatedAt: session.updatedAt,
      nickname: session.nickname,
      sessionFile: sessionFile(this.opts.dataDir),
      abilities,
      downloadDir: this.downloadDir(),
    };
  }

  /** 面板保存:归一化 → 落盘 → 顺手探一次活。 */
  async saveCookie(raw: unknown): Promise<LofterSaveResult> {
    const source = typeof raw === 'string' ? raw : (raw as { cookie?: unknown } | null)?.cookie;
    let cookie = '';
    try {
      cookie = normalizeCookie(source);
    } catch (error) {
      return {
        ok: false,
        loggedIn: false,
        cookieHint: '',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const previous = this.session();
    const session: LofterSession = {
      ...previous,
      cookie,
      updatedAt: new Date().toISOString(),
      nickname: '',
      scriptSessionId: '',
      httpSessionId: '',
    };
    writeSession(this.opts.dataDir, session);
    const probe = await this.client().probe();
    if (probe.ok) {
      return { ok: true, loggedIn: true, cookieHint: maskCookie(cookie), message: '已保存,' + probe.message };
    }
    return {
      ok: true,
      loggedIn: false,
      cookieHint: maskCookie(cookie),
      message: '已保存,但探活没过:' + probe.message,
    };
  }

  clearCookie(): { ok: boolean; message: string } {
    clearSession(this.opts.dataDir);
    return { ok: true, message: '已删掉本机存的 Cookie。' };
  }

  async probePanel(): Promise<{ ok: boolean; loggedIn: boolean; message: string }> {
    if (!hasCookie(this.session())) {
      return { ok: false, loggedIn: false, message: '还没有 Cookie,先在面板里粘一段。' };
    }
    const probe = await this.client().probe();
    return { ok: probe.ok, loggedIn: probe.ok, message: probe.message };
  }

  /** 挂载时投一条状态事件,让对话里知道这个 World 起来了。 */
  async start(host: WorldHost): Promise<void> {
    this.host = host;
    const session = this.session();
    const text = hasCookie(session)
      ? 'LOFTER 阅读 World 已挂载:' + (session.nickname === '' ? '本机有 Cookie' : '登录态是「' + session.nickname + '」') + '。'
      : 'LOFTER 阅读 World 已挂载:还没有 Cookie,在面板里粘一段才能读文。';
    await host.pushEvent({
      type: 'lofter.ready',
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text,
    });
  }

  async stop(): Promise<void> {
    this.api = undefined;
  }

  // ── 工具实现 ────────────────────────────────────────────────

  /** 登录态:纯本地读,不联网。 */
  private loginStatusTool(): ToolDef {
    return {
      ...LOFTER_TOOL_DECLS[0],
      handler: async () => {
        const session = this.session();
        const abilities = this.abilities();
        const on: string[] = [];
        if (abilities.tagStream) on.push('标签流');
        if (abilities.search) on.push('站内搜索');
        if (abilities.download) on.push('存图');
        if (abilities.watch) on.push('订阅');
        if (!hasCookie(session)) {
          return 'LOFTER 还没登录:本机没有 Cookie。请打开 Coopanion 设置里的「LOFTER 阅读」面板粘贴一次,或在对话里让我用 lofter_login_cookie 写进去。';
        }
        return 'LOFTER 已登录(' + maskCookie(session.cookie) + '),能力:' + (on.length === 0 ? '只读单篇与博主主页' : on.join('、')) + '。';
      },
    };
  }

  /** 写入 Cookie:对话里也能粘,省得切面板。 */
  private loginCookieTool(): ToolDef {
    return {
      ...LOFTER_TOOL_DECLS[1],
      handler: async (args: Record<string, unknown>) => {
        const result = await this.saveCookie(args.cookie);
        return result.message;
      },
    };
  }

  private blogPostsTool(): ToolDef {
    return {
      ...LOFTER_TOOL_DECLS[2],
      handler: async (args: Record<string, unknown>) => {
        const raw = typeof args.blog === 'string' ? args.blog.trim() : '';
        let blog = '';
        try {
          blog = normalizeBlogName(raw);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        const url = 'https://' + blog + '.lofter.com/';
        try {
          const html = await this.client().fetchPage(url);
          if (looksLikeLoginWall(html)) {
            return 'LOFTER 把这次请求打回了登录页,Cookie 大概过期了。去面板重新粘一次。';
          }
          const permalinks = extractPermalinks(html);
          if (permalinks.length === 0) {
            return (
              '没在「' + blog + '」的首页解析出文章链接 —— 可能博主名不对,或者首页整屏是图集。' +
              '原地址:' + url
            );
          }
          const picked = permalinks.slice(0, this.clampLimit(args.limit));
          const lines = picked.map((p, i) => String(i + 1) + '. ' + p + '   https://' + blog + '.lofter.com/post/' + p);
          return [
            '博主「' + blog + '」首页共 ' + permalinks.length + ' 条链接,取前 ' + picked.length + ' 条:',
            lines.join('\n'),
            '',
            'LOFTER 没有「按博主翻全部文章」的公开接口(PostBean.getPosts 实测恒回空数组、加第三个参数就抛 DB 异常),',
            '因此这里只能给首页渲染出来的那一屏。要正文请把 permalink 连博主域名一起交给 lofter_post。',
          ].join('\n');
        } catch (error) {
          return describeError(error);
        }
      },
    };
  }

  private tagPostsTool(): ToolDef {
    return {
      ...LOFTER_TOOL_DECLS[3],
      handler: async (args: Record<string, unknown>) => {
        if (!this.abilities().tagStream) {
          return '标签流没开。要按标签翻帖,先在 Coopanion 设置 → LOFTER 阅读 里打开「允许标签流」;默认是关的,免得后台自己联网。';
        }
        const tag = typeof args.tag === 'string' ? args.tag.trim() : '';
        if (tag === '') return '要给一个标签名,比如「摄影」。';
        return [
          '标签流取不到 —— 这是接口层的硬限制,不是没登录。',
          '',
          '真机实测:TagBean 存在,但它的存根 /dwr/interface/TagBean.js 里没有按标签翻帖的方法;',
          '唯一能出数的 TagBean.getRandomRTPostList() 回的是首页随机推荐,不吃标签参数。',
          '',
          '能替代的做法:',
          '1. 知道作者域名 → lofter_blog_posts 看首页那屏;',
          '2. 知道 permalink 与博主域名 → lofter_post 读全文;',
          '3. 想看站内热门 → lofter_hot_posts(已验证能出数)。',
        ].join('\n');
      },
    };
  }

  private searchTool(): ToolDef {
    return {
      ...LOFTER_TOOL_DECLS[4],
      handler: async (args: Record<string, unknown>) => {
        if (!this.abilities().search) {
          return '站内搜索没开。要用搜索,先在面板里打开「允许站内搜索」。';
        }
        const keyword = typeof args.keyword === 'string' ? args.keyword.trim() : '';
        if (keyword === '') return '要给一个关键词。';
        return [
          '站内搜索不可用 —— 「' + keyword + '」这个关键词没法拿去搜。',
          '',
          '真机实测:移动 DWR 层的 SearchBean / SearchV2Bean / Search2Bean / BlogSearchBean /',
          'IndexSearchBean 等二十多个候选 Bean 名全部回「java.lang.SecurityException: No class by name」,',
          '说明 LOFTER 压根没把搜索暴露在这一层(它只在前端页面里做)。',
          '',
          '能用的替代:',
          '1. 站内热门 → lofter_hot_posts;',
          '2. 已知博主域名 → lofter_blog_posts;',
          '3. 已知 permalink + 博主域名 → lofter_post。',
          '4. 真要按关键词找,请在浏览器里搜出链接后把地址丢给我。',
        ].join('\n');
      },
    };
  }

  private postTool(): ToolDef {
    return {
      ...LOFTER_TOOL_DECLS[5],
      handler: async (args: Record<string, unknown>) => {
        const postId = typeof args.postId === 'string' ? args.postId.trim() : String(args.postId ?? '').trim();
        if (postId === '') return '要给一个帖子 id。';
        let blog = typeof args.blog === 'string' ? args.blog.trim() : '';
        if (blog === '' && /^https?:/i.test(postId)) blog = blogNameFromUrl(postId);
        if (blog === '') {
          return (
            '要给博主域名。LOFTER 的文章页地址是 https://<博主>.lofter.com/post/<permalink>,' +
            ' 光有 permalink 拼不出完整地址(站内没有按 permalink 全局查单篇的接口)。'
          );
        }
        try {
          blog = normalizeBlogName(blog);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        const permalink = postId.replace(/^.*\/post\//, '').trim();
        const url = 'https://' + blog + '.lofter.com/post/' + permalink;
        try {
          const html = await this.client().fetchPage(url);
          if (looksLikeLoginWall(html)) {
            return 'LOFTER 把这次请求打回了登录页,Cookie 大概过期了。去面板重新粘一次。';
          }
          const rawBody = extractPostBody(html) ?? '';
          if (rawBody === '') {
            return '这一页没解析出正文(可能整篇是图集、视频或已删除)。原地址:' + url;
          }
          const maxChars = this.opts.cfg.maxBodyChars;
          const fullBody = htmlToText(rawBody);
          const truncated = fullBody.length > maxChars;
          const detail: LofterPostDetail = {
            postId: permalink,
            title: extractPostTitle(html, blog),
            blogId: '',
            blogName: blog,
            publishAt: '',
            excerpt: '',
            likeCount: 0,
            commentCount: 0,
            url,
            body: truncated ? fullBody.slice(0, maxChars) + '...(已截断)' : fullBody,
            images: extractPageImages(html, this.opts.cfg.maxImagesPerPost),
            truncated,
          };
          return this.renderDetail(detail);
        } catch (error) {
          return describeError(error);
        }
      },
    };
  }

  /**
   * 热门文章。真机唯一验证过能出数的列表接口,而且正文随列表一起回来 ——
   * 一次请求就有 10 篇全文,不用再逐篇取详情。
   */
  private hotPostsTool(): ToolDef {
    return {
      ...LOFTER_TOOL_DECLS[8],
      handler: async (args: Record<string, unknown>) => {
        const limit = this.clampLimit(args.limit);
        const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : 0;
        try {
          const values = await this.client().callAdaptiveValues(
            DWR_ENDPOINTS.hotPosts.bean,
            DWR_ENDPOINTS.hotPosts.method,
            DWR_ENDPOINTS.hotPosts.variants(offset, limit),
          );
          const raws = values.filter(
            (value): value is Record<string, unknown> =>
              typeof value === 'object' &&
              value !== null &&
              typeof (value as Record<string, unknown>).permalink === 'string',
          );
          if (raws.length === 0) {
            return '热门流这次没解析出文章(回了 ' + values.length + ' 个值,但没有带 permalink 的) —— 可能被限流,过一会儿再试。';
          }
          const details = raws
            .map((raw) => normalizePostDetail(raw, this.opts.cfg.maxBodyChars, this.opts.cfg.maxImagesPerPost))
            .filter((item): item is LofterPostDetail => item !== null)
            .slice(0, limit);
          if (details.length === 0) {
            return '热门流取到 ' + raws.length + ' 篇文章对象,但都没解析出正文(字段名可能变了)。';
          }
          const blocks = details.map((item, index) => '—— 第 ' + (index + 1) + ' 篇 ——\n' + this.renderDetail(item));
          return (
            'LOFTER 热门 ' + details.length + ' 篇(正文随列表一起回来,不用二次取):\n\n' + blocks.join('\n\n')
          );
        } catch (error) {
          return describeError(error);
        }
      },
    };
  }
  private downloadTool(): ToolDef {
    return {
      ...LOFTER_TOOL_DECLS[6],
      handler: async (args: Record<string, unknown>) => {
        if (!this.abilities().download) {
          return '存图没开:默认只把图片直链回给你,不写盘。要落盘请在面板里打开「允许存图」。';
        }
        const urls = Array.isArray(args.urls)
          ? args.urls.filter((item): item is string => typeof item === 'string')
          : [];
        if (urls.length === 0) return '要给至少一个图片直链(可从 lofter_post 的回执里抄)。';
        const dir = this.downloadDir();
        mkdirSync(dir, { recursive: true });
        const saved: string[] = [];
        const failed: string[] = [];
        for (const url of urls.slice(0, this.opts.cfg.maxImagesPerPost)) {
          try {
            const savedPath = await this.saveOne(url, dir);
            saved.push(savedPath);
          } catch (error) {
            failed.push(url + ' → ' + (error instanceof Error ? error.message : String(error)));
          }
        }
        const head = '存到 ' + dir + ':' + saved.length + ' 张';
        const tail = failed.length === 0 ? '' : ';失败 ' + failed.length + ' 张(' + failed.slice(0, 3).join(';') + ')';
        return head + tail;
      },
    };
  }

  private watchTool(): ToolDef {
    return {
      ...LOFTER_TOOL_DECLS[7],
      handler: async (args: Record<string, unknown>) => {
        const action = typeof args.action === 'string' ? args.action : 'list';
        if (!this.abilities().watch && action !== 'list') {
          return '订阅没开。订阅会让插件定期去看有没有新帖,默认关着;要用先在面板里打开「允许订阅轮询」。';
        }
        const entries = readSubscribeFile(this.opts.dataDir);
        if (action === 'list') {
          if (entries.length === 0) return '还没有订阅任何博主或标签。';
          return '订阅 ' + entries.length + ' 项:\n' + entries
            .map((item) => '- [' + item.kind + '] ' + item.target + (item.checkedAt === '' ? '(还没查过)' : '(上次查:' + item.checkedAt + ')'))
            .join('\n');
        }
        const target = typeof args.target === 'string' ? args.target.trim() : '';
        if (action === 'remove') {
          if (target === '') return '要告诉我去掉哪一项。';
          const rest = entries.filter((item) => item.target !== target);
          this.writeWatch(rest);
          return rest.length === entries.length ? '没有「' + target + '」这一项。' : '已去掉「' + target + '」,还剩 ' + rest.length + ' 项。';
        }
        if (action === 'add') {
          if (target === '') return '要告诉我要盯谁,博主域名或标签名都行。';
          const kind: 'blog' | 'tag' = args.kind === 'tag' ? 'tag' : 'blog';
          if (entries.some((item) => item.target === target && item.kind === kind)) {
            return '「' + target + '」已经在订阅里了。';
          }
          entries.push({ target, kind, lastPostId: '', checkedAt: '' });
          this.writeWatch(entries);
          return '已登记 [' + kind + '] ' + target + '。要立刻看有没有新帖,用 action=check。';
        }
        if (action === 'check') {
          if (entries.length === 0) return '还没有订阅任何东西。';
          const lines: string[] = [];
          for (const entry of entries) {
            if (entry.kind === 'tag') {
              lines.push('- [tag] ' + entry.target + ':标签维度在接口层不可用,这一项跳过(登记保留,不会误报新帖)。');
              continue;
            }
            try {
              const html = await this.client().fetchPage('https://' + entry.target + '.lofter.com/');
              const permalinks = looksLikeLoginWall(html) ? [] : extractPermalinks(html);
              const newest = permalinks[0];
              if (!newest) {
                lines.push('- ' + entry.target + ':首页没解析出文章链接');
                continue;
              }
              const fresh = entry.lastPostId !== '' && newest !== entry.lastPostId;
              lines.push(
                '- ' + entry.target + ':' +
                  (entry.lastPostId === ''
                    ? '首次检查,最新是 ' + newest
                    : fresh
                      ? '有新帖 ' + newest
                      : '没有新帖'),
              );
              entry.lastPostId = newest;
              entry.checkedAt = nowIso(this.opts.timezone);
            } catch (error) {
              lines.push('- ' + entry.target + ':' + describeError(error));
            }
          }
          this.writeWatch(entries);
          return '检查完毕:\n' + lines.join('\n');
        }
        return 'action 只认 add / list / remove / check。';
      },
    };
  }

  // ── 内部工具 ────────────────────────────────────────────────

  private writeWatch(entries: WatchEntry[]): void {
    const file = subscribeFile(this.opts.dataDir);
    mkdirSync(join(this.opts.dataDir, 'lofter'), { recursive: true });
    writeFileSync(file, JSON.stringify(entries, null, 2) + '\n', 'utf8');
  }

  private clampLimit(raw: unknown): number {
    const cap = this.opts.cfg.maxPostsPerCall;
    const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : cap;
    return Math.min(Math.max(value, 1), cap);
  }

  /** 从 DWR 回包里挖出帖子数组 —— 站点在不同接口上用了不同的字段名。 */
  private extractPosts(reply: unknown): LofterPostSummary[] {
    const found: LofterPostSummary[] = [];
    const seen = new Set<string>();
    const walk = (node: unknown, depth: number): void => {
      if (found.length >= this.opts.cfg.maxPostsPerCall || depth > 4) return;
      if (Array.isArray(node)) {
        for (const item of node) {
          const post = normalizePost(item);
          if (post && !seen.has(post.postId)) {
            seen.add(post.postId);
            found.push(post);
          } else {
            walk(item, depth + 1);
          }
        }
        return;
      }
      if (node !== null && typeof node === 'object') {
        const record = node as Record<string, unknown>;
        for (const key of ['posts', 'list', 'items', 'data', 'result', 'records', 'postList']) {
          if (record[key] !== undefined) walk(record[key], depth + 1);
        }
      }
    };
    walk(reply, 0);
    return found;
  }

  private renderList(reply: unknown, label: string): string {
    const posts = this.extractPosts(reply);
    if (posts.length === 0) {
      return label + '没取到帖子。可能是这个地址没有公开内容,或 Cookie 对应的账号看不到。';
    }
    const lines = posts.map((post, index) => {
      const counts = describeCounts(post);
      const meta = [post.blogName, post.publishAt.slice(0, 10), counts].filter((part) => part !== '').join(' · ');
      return (index + 1) + '. ' + post.title + '\n   id:' + post.postId + (meta === '' ? '' : ' · ' + meta)
        + (post.excerpt === '' ? '' : '\n   ' + post.excerpt) + (post.url === '' ? '' : '\n   ' + post.url);
    });
    return label + '共 ' + posts.length + ' 篇:\n' + lines.join('\n');
  }

  private renderDetail(detail: LofterPostDetail): string {
    const head = ['《' + detail.title + '》', detail.blogName === '' ? '' : '作者:' + detail.blogName,
      detail.publishAt === '' ? '' : '时间:' + detail.publishAt.slice(0, 16).replace('T', ' ')]
      .filter((part) => part !== '').join(' · ');
    const parts: string[] = [head];
    if (detail.body !== '') parts.push(detail.body + (detail.truncated ? '\n…(正文超过 ' + this.opts.cfg.maxBodyChars + ' 字已截断)' : ''));
    else parts.push('(这篇没有正文文本,可能是纯图)');
    if (detail.images.length > 0) {
      const list = detail.images.map((url, index) => '  ' + (index + 1) + '. ' + url).join('\n');
      const tail = this.abilities().download ? '\n(要存到本机就调 lofter_download)' : '\n(存图没开,只回直链)';
      parts.push('配图 ' + detail.images.length + ' 张:\n' + list + tail);
    }
    if (detail.url !== '') parts.push('原帖:' + detail.url);
    return parts.join('\n\n');
  }

  /** 下载一张图:先过闸门(协议 + 图床白名单),再卡大小与类型,最后才落盘。 */
  private async saveOne(url: string, dir: string): Promise<string> {
    const target = assertImageUrl(url);
    let response: Response;
    try {
      response = await (this.opts.fetchImpl ?? fetch)(target.href, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.lofter.com/' },
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      throw new Error('拉不下来:' + (error instanceof Error ? error.message : String(error)));
    }
    if (response.status !== 200) throw new Error('HTTP ' + response.status);
    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    if (type !== '' && !type.startsWith('image/')) {
      throw new Error('不是图片(Content-Type: ' + type + ')');
    }
    const limitMb = Math.round(MAX_IMAGE_BYTES / 1048576);
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      throw new Error('图太大(' + Math.round(declared / 1048576) + 'MB,上限 ' + limitMb + 'MB)');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new Error('图太大(' + Math.round(buffer.byteLength / 1048576) + 'MB,上限 ' + limitMb + 'MB)');
    }
    let name = basename(target.pathname);
    if (extname(name) === '') name = name + '.jpg';
    name = name.replace(/[\\/:*?"<>|]/g, '_');
    // 路径段可能被构造成 "." 或 "..",那样 join(dir, name) 就跳出下载目录:去掉首尾的点与空白。
    name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
    if (name === '' || name === 'jpg') name = 'image.jpg';
    let dest = join(dir, name);
    let index = 1;
    while (existsSync(dest)) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      dest = join(dir, stem + '-' + index + ext);
      index += 1;
    }
    writeFileSync(dest, buffer);
    return dest;
  }
}

/** 工具声明:不含 handler,definition.ts 用它生成 describe.json。 */
export const LOFTER_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'lofter_login_status',
    description: 'Report whether a LOFTER cookie is stored locally and which optional abilities are enabled.',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'lofter_login_cookie',
    description: 'Store the LOFTER cookie header typed by the user, then probe whether it still works.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cookie: { type: 'string', description: 'Raw cookie header pasted from a logged-in browser; the "Cookie:" prefix is optional.' },
      },
      required: ['cookie'],
    },
  },
  {
    name: 'lofter_blog_posts',
    description: 'List posts on one LOFTER blog page.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        blog: { type: 'string', description: 'Blog domain, e.g. "someone" for someone.lofter.com.' },
        offset: { type: 'number', description: 'Skip this many posts; default 0.' },
        limit: { type: 'number', description: 'How many posts to return; capped by the world config.' },
      },
      required: ['blog'],
    },
  },
  {
    name: 'lofter_tag_posts',
    description: 'List posts under one LOFTER tag. Requires the tag-stream switch.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tag: { type: 'string', description: 'Tag name, e.g. 摄影.' },
        limit: { type: 'number', description: 'How many posts to return.' },
      },
      required: ['tag'],
    },
  },
  {
    name: 'lofter_search',
    description: 'Search LOFTER posts by keyword. Requires the search switch.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keyword: { type: 'string', description: 'Search keyword.' },
        limit: { type: 'number', description: 'How many posts to return.' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'lofter_post',
    description: 'Read one LOFTER post: title, body text, image links.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        postId: { type: 'string', description: 'Post id.' },
        blog: { type: 'string', description: 'Blog domain the post belongs to; improves the permalink.' },
      },
      required: ['postId'],
    },
  },
  {
    name: 'lofter_download',
    description: 'Download post images to the local folder. Requires the download switch.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        urls: { type: 'array', description: 'Image URLs, usually copied from lofter_post output.', items: { type: 'string' } },
      },
      required: ['urls'],
    },
  },
  {
    name: 'lofter_watch',
    description: 'Manage watched blogs or tags: action add / list / remove / check.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove', 'check'], description: 'What to do with the watch list.' },
        target: { type: 'string', description: 'Blog domain or tag name.' },
        kind: { type: 'string', enum: ['blog', 'tag'], description: 'Defaults to blog.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'lofter_hot_posts',
    description: 'Fetch LOFTER hot posts; this call returns full HTML bodies together with the list.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'How many posts to return; default 10.' },
        offset: { type: 'integer', minimum: 0, description: 'Skip this many posts; default 0.' },
      },
      required: [],
    },
  },
];
