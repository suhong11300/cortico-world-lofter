/**
 * LOFTER 页面(HTML)侧的抽取工具。
 *
 * 为什么需要这一层:实测 DWR 移动接口只稳定给出「热门 / 首页推荐」两条流,
 * 单篇正文与博主文章流都要走服务端渲染的 HTML。
 *  - 单篇: https://<blogName>.lofter.com/post/<permalink>  (200 / 15KB 量级)
 *  - 主页: https://<blogName>.lofter.com/                  (200 / 30KB 量级, 只含首屏)
 *
 * 这里只做纯字符串处理,不发请求 —— 发请求在 api.ts / world.ts 里。
 */

/** 常见 HTML 实体表。数字实体走 parseNumericEntity 单独处理。 */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: String.fromCharCode(34),
  apos: String.fromCharCode(39),
  nbsp: ' ',
  ldquo: String.fromCharCode(0x201c),
  rdquo: String.fromCharCode(0x201d),
  lsquo: String.fromCharCode(0x2018),
  rsquo: String.fromCharCode(0x2019),
  hellip: String.fromCharCode(0x2026),
  mdash: String.fromCharCode(0x2014),
  ndash: String.fromCharCode(0x2013),
  middot: String.fromCharCode(0xb7),
  times: String.fromCharCode(0xd7),
};

/** 把 &xxx; / &#123; / &#x1F600; 还原成字符。认不出的原样保留。 */
export function decodeEntities(text: string): string {
  if (!text || text.indexOf('&') < 0) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.charAt(0) === '#') {
      const isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const digits = isHex ? body.slice(2) : body.slice(1);
      const code = parseInt(digits, isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const hit = ENTITIES[body.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
}

/** 从 URL 里取出博主域名。'https://road11.lofter.com/post/xxx' -> 'road11'。 */
export function blogNameFromUrl(url: string): string {
  const m = /^https?:\/\/([a-z0-9][a-z0-9-]*)\.lofter\.com\//i.exec(url.trim());
  return m && m[1] ? m[1].toLowerCase() : '';
}

/**
 * 抓一个 div 的 innerHTML 并配平嵌套。
 *
 * openRe 必须能匹配到起始标签本身(且带 class 之类的特征),内部嵌套的 div
 * 靠 depth 计数跳过 —— 单层正则做不到这件事。
 */
export function findDivBlock(html: string, openRe: RegExp): string | undefined {
  const m = openRe.exec(html);
  if (!m) return undefined;
  const startTagEnd = html.indexOf('>', m.index);
  if (startTagEnd < 0) return undefined;
  const tagRe = /<\/?div\b[^>]*>/gi;
  tagRe.lastIndex = m.index;
  let depth = 0;
  for (;;) {
    const tag = tagRe.exec(html);
    if (!tag) return undefined;
    if (tag[0].charAt(1) === '/') depth -= 1;
    else depth += 1;
    if (depth === 0) return html.slice(startTagEnd + 1, tag.index);
  }
}

/** 单篇页标题。优先 h1.title,退回 <title>,再去掉结尾的 '-博主名'。 */
export function extractPostTitle(html: string, blogName?: string): string {
  const h1 = /<h1[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1 && h1[1]) {
    const text = decodeEntities(h1[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  const m = /<title>([\s\S]*?)<\/title>/i.exec(html);
  if (!m || !m[1]) return '';
  let title = decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
  // 站点把「文章标题-博主名」拼进 title。实测单篇页的 <h1> 里放的正是博主名
  // (形如 <h1><a href="/">笛啵威</a></h1>),所以拿它当后缀候选,比自己传的域名准。
  const ownerMatch = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const owner =
    ownerMatch && ownerMatch[1]
      ? decodeEntities(ownerMatch[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
      : '';
  const names = [blogName ?? '', owner].filter((name) => name.trim() !== '');
  for (const name of names) {
    for (const sep of ['-', '–', '—', '|', '_']) {
      const suffix = sep + name;
      if (title.endsWith(suffix)) {
        title = title.slice(0, title.length - suffix.length).trim();
        break;
      }
    }
  }
  return title;
}

/** 单篇页正文 div.content 的 innerHTML。找不到返回 undefined。 */
export function extractPostBody(html: string): string | undefined {
  return findDivBlock(html, /<div[^>]*class="[^"]*\bcontent\b[^"]*"[^>]*>/i);
}

/**
 * 从列表页抽出所有 permalink。
 *
 * LOFTER 的 permalink 是 <8位hex>_<9位hex> 形状(如 1d124ca3_2b73840be),
 * 不是纯数字 —— 拿纯数字拼 URL 一定 404。这里不猜形状,按 /post/ 后面
 * 的合法字符段整体取,再用第一次出现的顺序去重。
 */
export function extractPermalinks(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\/post\/([A-Za-z0-9_]+)/g;
  for (;;) {
    const m = re.exec(html);
    if (!m) break;
    const id = m[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 单篇页里出现的大图(头像与站内图标已按域名过滤)。 */
export function extractPageImages(html: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /https:\/\/[a-z0-9.-]*lf127\.net\/img\/[^"'\\s)]+/gi;
  for (;;) {
    const m = re.exec(html);
    if (!m) break;
    const url = m[0];
    if (!url || seen.has(url)) continue;
    // 头像和小图会带 thumbnail=16y16 / 96x96 这类参数,正文配图不会这么小
    if (/[?&]thumbnail=(1[0-9]|[2-9][0-9])[xy]/.test(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

/** 页面里是否含登录墙特征(被踢回登录页时用来给准确回执)。 */
export function looksLikeLoginWall(html: string): boolean {
  return /(\/front\/login)|(id="loginForm")|(class="login-?wrap)/i.test(html);
}
