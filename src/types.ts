/**
 * LOFTER 的数据形状与归一化。
 *
 * DWR 回来的对象字段名不稳(有的接口叫 title,有的叫 postTitle),所以这里不写死
 * 一套 DTO,而是按候选键取值 —— 拿不到就用空串,不让一个字段缺失把整篇搞崩。
 */

/** 列在一份流里的帖子摘要。 */
export interface LofterPostSummary {
  postId: string;
  title: string;
  blogId: string;
  blogName: string;
  publishAt: string;
  excerpt: string;
  likeCount: number;
  commentCount: number;
  /** 站内地址;拼不出来时为空串。 */
  url: string;
}

/** 单篇正文。 */
export interface LofterPostDetail extends LofterPostSummary {
  /** 去标签后的纯文本正文。 */
  body: string;
  /** 配图直链。 */
  images: string[];
  /** 正文是否被 maxBodyChars 截断。 */
  truncated: boolean;
}

function pick(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return 0;
}

/** 时间戳可能是毫秒数、秒数或 '2024-05-01 12:00:00';统一成 ISO 字符串。 */
export function normalizeTime(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }
  const text = asText(value).trim();
  if (text === '') return '';
  if (/^\d{10}$/.test(text)) return normalizeTime(Number(text));
  if (/^\d{13}$/.test(text)) return normalizeTime(Number(text));
  const parsed = Date.parse(text.replace(' ', 'T'));
  return Number.isNaN(parsed) ? text : new Date(parsed).toISOString();
}

/** HTML → 纯文本:段落换行保留,标签丢掉,常见实体还原。 */
export function htmlToText(html: string): string {
  if (html === '') return '';
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
  return text
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 从任意形态的图片字段里挖出 http(s) 直链。 */
export function collectImages(value: unknown, limit: number): string[] {
  const found: string[] = [];
  const push = (candidate: unknown): void => {
    const text = asText(candidate).trim();
    if (!/^https?:\/\//i.test(text)) return;
    if (!found.includes(text)) found.push(text);
  };
  const walk = (node: unknown): void => {
    if (found.length >= limit) return;
    if (typeof node === 'string') {
      const trimmed = node.trim();
      // 真机里 firstImageUrl / photoLinks 是「字符串化的 JSON 数组」,先解析再走
      if ((trimmed.startsWith('[') || trimmed.startsWith('{')) && trimmed.length > 1) {
        try {
          walk(JSON.parse(trimmed));
          return;
        } catch {
          // 不是合法 JSON,退回按普通字符串处理
        }
      }
      // 字段本身可能是逗号/空格分隔的一串
      for (const part of node.split(/[\s,]+/)) push(part);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node !== null && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      for (const key of ['url', 'src', 'origin', 'raw', 'big', 'href', 'imageUrl', 'imgUrl']) {
        if (record[key] !== undefined) push(record[key]);
      }
      for (const key of ['images', 'imgs', 'photoLinks', 'imageList', 'list']) {
        if (record[key] !== undefined) walk(record[key]);
      }
    }
  };
  walk(value);
  return found.slice(0, limit);
}

/** 站内地址;拿不到 id 时返回空串。 */
export function postUrl(blogId: string, postId: string): string {
  if (blogId === '' || postId === '') return '';
  return 'https://' + blogId + '.lofter.com/post/' + postId;
}

/** 一条记录 → 摘要;连 id 都没有时返回 undefined(整条丢掉,别污染列表)。 */
/** 博主域名形状:小写字母数字加连字符,不含中文与点。 */
const DOMAIN_LIKE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function normalizePost(raw: unknown): LofterPostSummary | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  // permalink 是真机热门流里的主键(形状 8位hex_9位hex),比数字 id 更常出现
  const postId = asText(pick(record, ['postId', 'permalink', 'id', 'postid']));
  if (postId === '') return undefined;
  const blogId = asText(pick(record, ['blogId', 'blogid', 'domainName', 'blogDomain']));
  const title = asText(pick(record, ['title', 'postTitle', 'name'])).trim();
  const blogName = asText(pick(record, ['blogName', 'nickName', 'nickname', 'authorName'])).trim();
  const excerptRaw = pick(record, ['digest', 'summary', 'excerpt', 'recommend', 'describe']);
  // 真机对象带 blogPageUrl,是拼好的完整地址,比自己拼可靠
  const pageUrl = asText(pick(record, ['blogPageUrl', 'pageUrl'])).trim();
  return {
    postId,
    title: title || '无标题',
    blogId,
    blogName,
    publishAt: normalizeTime(pick(record, ['publishTime', 'publishDate', 'time', 'postTime', 'date'])),
    excerpt: htmlToText(asText(excerptRaw)).slice(0, 240),
    likeCount: asNumber(pick(record, ['likeCount', 'likeNum', 'favoriteCount', 'favCount'])),
    commentCount: asNumber(pick(record, ['commentCount', 'commentNum', 'replyCount'])),
    // blogName 有时是域名(road11)、有时是昵称(中文),只有像域名时才拿它拼地址
    url: pageUrl !== ''
      ? pageUrl
      : DOMAIN_LIKE.test(blogName)
        ? 'https://' + blogName + '.lofter.com/post/' + postId
        : postUrl(blogId, postId),
  };
}

/** 一条记录 → 正文;正文取不到时 body 为空串。 */
export function normalizePostDetail(raw: unknown, maxChars: number, maxImages: number): LofterPostDetail | undefined {
  const summary = normalizePost(raw);
  if (!summary) return undefined;
  const record = raw as Record<string, unknown>;
  const full = htmlToText(asText(pick(record, ['content', 'body', 'text', 'contentRaw', 'postContent'])));
  const truncated = full.length > maxChars;
  const images = collectImages(
    pick(record, ['images', 'imgs', 'photoLinks', 'imageList', 'photos', 'imgList']),
    maxImages,
  );
  return {
    ...summary,
    body: truncated ? full.slice(0, maxChars) : full,
    images,
    truncated,
  };
}

/** 摘要里的计数太多余,压成一句人话。 */
export function describeCounts(post: LofterPostSummary): string {
  const bits: string[] = [];
  if (post.likeCount > 0) bits.push('赞 ' + post.likeCount);
  if (post.commentCount > 0) bits.push('评 ' + post.commentCount);
  return bits.join(' / ');
}
