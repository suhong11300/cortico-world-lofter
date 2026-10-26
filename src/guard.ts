/**
 * 出网闸门:所有请求发出去之前都从这里过一遍。
 *
 * 为什么单独一个文件 —— 这个插件手里有两样不能交给「模型传进来的字符串」的东西:
 * 一份用户的 LOFTER Cookie,和一个能写本机磁盘的位置。域名白名单挡住 Cookie 外发
 * 与 SSRF(内网 / 云元数据),大小与类型上限挡住「把存图当写盘放大器」。
 */

const LOFTER_APEX = 'lofter.com';

/** 只有这些后缀下的主机才允许落盘 —— 都是 LOFTER 自己的图床。 */
export const IMAGE_HOST_SUFFIXES: readonly string[] = [
  'lf127.net',
  'nosdn.127.net',
  'nos.netease.com',
  '127.net',
  'netease.com',
];

/** 单张图上限 32MB;超过就明确报错,不静默截断也不写半个文件。 */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/** 博主域名形状:小写字母数字加连字符,不含点、斜杠、@。 */
const DOMAIN_LIKE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function hostMatches(hostname: string, suffix: string): boolean {
  const host = hostname.toLowerCase();
  return host === suffix || host.endsWith('.' + suffix);
}

export function isImageHost(hostname: string): boolean {
  return IMAGE_HOST_SUFFIXES.some((suffix) => hostMatches(hostname, suffix));
}

export function isDomainLike(name: string): boolean {
  return DOMAIN_LIKE.test(name);
}

function parseUrl(raw: string, what: string): URL {
  const text = raw.trim();
  if (text === '') throw new Error(what + '是空的。');
  try {
    return new URL(text);
  } catch {
    throw new Error(what + '不是合法地址:' + text.slice(0, 120));
  }
}

/** 网页请求只许发给 lofter.com 自己:其它域一律不发,Cookie 也就带不过去。 */
export function assertLofterPageUrl(raw: string): URL {
  const url = parseUrl(raw, '页面地址');
  if (url.protocol !== 'https:') {
    throw new Error('页面地址必须是 https(收到 ' + url.protocol + ')。');
  }
  if (!hostMatches(url.hostname, LOFTER_APEX)) {
    throw new Error('只访问 lofter.com 下的页面(收到 ' + url.hostname + '),Cookie 不外发给别的站。');
  }
  return url;
}

/** 存图只许连图床白名单:挡住内网地址、云元数据端点与任意写盘。 */
export function assertImageUrl(raw: string): URL {
  const url = parseUrl(raw, '图片地址');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('图片地址只支持 http/https(收到 ' + url.protocol + ')。');
  }
  if (!isImageHost(url.hostname)) {
    throw new Error(
      '这个域名不在 LOFTER 图床白名单里(' + url.hostname + ')。可落盘的是 ' +
        IMAGE_HOST_SUFFIXES.join(' / ') + ' —— 白名单是为了不让存图变成任意写盘或内网探测。',
    );
  }
  return url;
}

/** 博主名归一化 + 形状校验;不合法直接抛中文原因,调用方转成工具回执。 */
export function normalizeBlogName(raw: string): string {
  const name = raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/\.lofter\.com$/i, '')
    .toLowerCase();
  if (name === '') throw new Error('要给一个博主域名,比如 someone.lofter.com 里的 someone。');
  if (!isDomainLike(name)) {
    throw new Error('博主域名只能是字母数字与连字符(收到:' + name.slice(0, 60) + ')。');
  }
  return name;
}
