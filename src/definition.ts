import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { LOFTER_DEFAULTS, type LofterConfigSection } from './config.ts';
import { LOFTER_TOOL_DECLS, LofterWorld } from './world.ts';

export const LOFTER: WorldDefinition<LofterConfigSection> = {
  id: 'lofter',
  label: 'LOFTER 阅读',
  defaults: () => ({ ...LOFTER_DEFAULTS }),
  // ctx.cfg 是 worlds.lofter 的活引用:热改的键现读即生效。
  create: (ctx) => new LofterWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    botDir: ctx.botDir,
    dataDir: ctx.dataDir,
  }),
  describe: {
    tools: describeTools(LOFTER_TOOL_DECLS, {
      lofter_login_status: {
        zh: '报本机有没有存 LOFTER 的 Cookie,以及哪几项可选能力是打开的。',
        en: 'Reports whether a LOFTER cookie is stored and which optional abilities are enabled.',
      },
      lofter_login_cookie: {
        zh: '把用户粘过来的 Cookie 存到本机,并立刻探一次活。',
        en: 'Stores the pasted cookie locally, then probes whether it still works.',
      },
      lofter_blog_posts: {
        zh: '列某个博主主页上的帖子。',
        en: 'Lists posts on one blog page.',
      },
      lofter_tag_posts: {
        zh: '按标签翻帖;需要先打开「允许标签流」。',
        en: 'Lists posts under a tag; requires the tag-stream switch.',
      },
      lofter_search: {
        zh: '站内搜帖;需要先打开「允许站内搜索」。',
        en: 'Searches posts; requires the search switch.',
      },
      lofter_post: {
        zh: '读单篇正文,连配图直链一起回。',
        en: 'Reads one post, including image links.',
      },
      lofter_hot_posts: {
        zh: '取站内热门;这个接口一次就把列表和全文一起带回来了。',
        en: 'Fetches hot posts; one call returns both the list and the full bodies.',
      },
      lofter_download: {
        zh: '把配图存到本机;需要先打开「允许存图」。',
        en: 'Downloads images locally; requires the download switch.',
      },
      lofter_watch: {
        zh: '管理订阅:登记要盯的博主或标签,并检查有没有新帖。',
        en: 'Manages the watch list and checks for new posts.',
      },
    }),
    events: [
      {
        type: 'lofter.ready',
        description: {
          zh: 'World 挂载完成,附带本机登录态。',
          en: 'The World was mounted, with the local login state.',
        },
      },
    ],
  },
};
