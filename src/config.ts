import type { ConfigGroup } from 'cortico/core/types.ts';

/**
 * config.json 的 worlds.lofter 段。
 *
 * 默认全关:装上插件不等于开工。四项能力(标签流 / 搜索 / 图片落盘 / 订阅轮询)
 * 各自一个开关,默认关;主路径只有一条 —— 用户在对话里明确说要看哪一篇、哪个标签,
 * 模型才去取,取回来的正文直接进对话,不写盘、不定时联网。
 *
 * Cookie 不放这里:LOFTER 的 Cookie 头带空格与分号,塞不进 .env 的密钥槽,
 * 明文写 config.json 又会被部署目录的整体备份带走。它由面板粘贴后落到
 * data/lofter/session.json(仅本机可读),详见 session.ts。
 */
export interface LofterConfigSection {
  enabled: boolean;
  /** 允许 lofter_tag_posts:按标签翻流。默认关。 */
  allowTagStream: boolean;
  /** 允许 lofter_search:站内搜索。默认关。 */
  allowSearch: boolean;
  /** 允许 lofter_download:把配图存到本机。默认关,只回图片链接。 */
  allowDownload: boolean;
  /** 允许 lofter_watch_*:定时轮询某个博主/标签的新帖。默认关。 */
  allowWatch: boolean;
  /** 图片落盘目录;留空时用 dataDir/lofter/images。 */
  downloadDir: string;
  /** 两次请求之间至少间隔多少毫秒,给 LOFTER 侧留余地。 */
  requestIntervalMs: number;
  /** 单篇最多取几张贴图。 */
  maxImagesPerPost: number;
  /** 一次列表调用最多返回几篇。 */
  maxPostsPerCall: number;
  /** 单篇正文最多回多少字,超出截断并提示。 */
  maxBodyChars: number;
}

export const LOFTER_DEFAULTS: LofterConfigSection = {
  enabled: false,
  allowTagStream: false,
  allowSearch: false,
  allowDownload: false,
  allowWatch: false,
  downloadDir: '',
  requestIntervalMs: 1200,
  maxImagesPerPost: 30,
  maxPostsPerCall: 10,
  maxBodyChars: 8000,
};

/** World 配置的 JSON Schema 声明;每条路径都要落在 worlds.lofter 段里。 */
export const LOFTER_CONFIG_GROUP: ConfigGroup = {
  id: 'world:lofter',
  owner: 'world:lofter',
  schema: {
    type: 'object',
    title: 'LOFTER 阅读',
    description: '默认只在对话里按需取内容;标签流、搜索、图片落盘、订阅各是一个开关,关了就不联网。',
    properties: {
      'worlds.lofter.allowTagStream': {
        type: 'boolean',
        title: '允许标签流',
        description: '打开后模型可以按标签翻 LOFTER 的帖子流;关着时只做单篇与博主主页。',
        'x-hot': true,
      },
      'worlds.lofter.allowSearch': {
        type: 'boolean',
        title: '允许站内搜索',
        description: '打开后模型可以按关键词搜帖子。',
        'x-hot': true,
      },
      'worlds.lofter.allowDownload': {
        type: 'boolean',
        title: '允许存图',
        description: '打开后可以把配图存到本机;关着时只把图片直链回给模型。',
        'x-hot': true,
      },
      'worlds.lofter.allowWatch': {
        type: 'boolean',
        title: '允许订阅轮询',
        description: '打开后可以登记「盯着某个博主/标签」并定时检查新帖;关着时完全不后台联网。',
        'x-hot': true,
      },
      'worlds.lofter.downloadDir': {
        type: 'string',
        title: '存图目录',
        description: '留空时用 data/lofter/images。',
        'x-hot': true,
        'x-path': { kind: 'directory' },
      },
      'worlds.lofter.requestIntervalMs': {
        type: 'integer',
        title: '请求间隔',
        description: '两次请求之间至少隔多少毫秒。',
        minimum: 300,
        maximum: 30000,
        'x-hot': true,
        'x-suffix': ' ms',
      },
      'worlds.lofter.maxImagesPerPost': {
        type: 'integer',
        title: '单篇图片上限',
        minimum: 0,
        maximum: 100,
        'x-hot': true,
        'x-suffix': ' 张',
      },
      'worlds.lofter.maxPostsPerCall': {
        type: 'integer',
        title: '单次返回篇数',
        minimum: 1,
        maximum: 50,
        'x-hot': true,
        'x-suffix': ' 篇',
      },
      'worlds.lofter.maxBodyChars': {
        type: 'integer',
        title: '正文截断',
        description: '单篇正文最多返回多少字,超出截断。',
        minimum: 500,
        maximum: 40000,
        'x-hot': true,
        'x-suffix': ' 字',
      },
    },
  },
};
