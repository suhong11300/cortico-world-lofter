import { describe, expect, it } from 'vitest';
import {
  collectImages,
  describeCounts,
  htmlToText,
  normalizePost,
  normalizePostDetail,
  normalizeTime,
  postUrl,
} from '../src/types.ts';

describe('normalizeTime', () => {
  it('毫秒时间戳', () => {
    expect(normalizeTime(1714521600000)).toBe('2024-05-01T00:00:00.000Z');
  });

  it('秒时间戳补成毫秒', () => {
    expect(normalizeTime(1714521600)).toBe('2024-05-01T00:00:00.000Z');
  });

  it('数字字符串也认', () => {
    expect(normalizeTime('1714521600')).toBe('2024-05-01T00:00:00.000Z');
  });

  it('空值返回空串', () => {
    expect(normalizeTime(undefined)).toBe('');
    expect(normalizeTime('')).toBe('');
  });
});

describe('htmlToText', () => {
  it('丢标签保留段落', () => {
    expect(htmlToText('<p>第一段</p><p>第二段</p>')).toBe('第一段\n第二段');
  });

  it('br 转换行', () => {
    expect(htmlToText('a<br/>b')).toBe('a\nb');
  });

  it('还原常见实体', () => {
    expect(htmlToText('a &amp; b &lt;c&gt; &quot;d&quot;&nbsp;e')).toBe('a & b <c> "d" e');
  });

  it('空串原样返回', () => {
    expect(htmlToText('')).toBe('');
  });
});

describe('normalizePost', () => {
  it('按候选键取名', () => {
    const post = normalizePost({ postId: 12, title: '标题', blogId: 'abc', nickName: '作者' });
    expect(post?.postId).toBe('12');
    expect(post?.title).toBe('标题');
    expect(post?.blogName).toBe('作者');
    expect(post?.url).toBe('https://abc.lofter.com/post/12');
  });

  it('没有 id 的整条丢掉', () => {
    expect(normalizePost({ title: '无 id' })).toBeUndefined();
  });

  it('没有标题时给占位', () => {
    expect(normalizePost({ postId: 1 })?.title).toBe('无标题');
  });

  it('摘要里的 HTML 被清掉并截断', () => {
    const long = '<p>' + 'a'.repeat(300) + '</p>';
    const post = normalizePost({ postId: 1, digest: long });
    expect(post?.excerpt.length).toBe(240);
    expect(post?.excerpt).not.toContain('<');
  });
});

describe('collectImages', () => {
  it('从数组里取直链', () => {
    expect(collectImages(['https://a.com/1.jpg', 'https://a.com/2.jpg'], 10)).toEqual([
      'https://a.com/1.jpg',
      'https://a.com/2.jpg',
    ]);
  });

  it('从对象数组里按字段取', () => {
    expect(collectImages([{ url: 'https://a.com/1.jpg' }, { src: 'https://a.com/2.jpg' }], 10)).toEqual([
      'https://a.com/1.jpg',
      'https://a.com/2.jpg',
    ]);
  });

  it('空格分隔的一串也能拆', () => {
    expect(collectImages('https://a.com/1.jpg https://a.com/2.jpg', 10)).toHaveLength(2);
  });

  it('去重并按上限截断', () => {
    const urls = collectImages(['https://a.com/1.jpg', 'https://a.com/1.jpg', 'https://a.com/2.jpg'], 1);
    expect(urls).toEqual(['https://a.com/1.jpg']);
  });

  it('非 http 的丢掉', () => {
    expect(collectImages(['ftp://a.com/1.jpg', 'not a url'], 10)).toEqual([]);
  });
});

describe('normalizePostDetail', () => {
  it('正文去标签、图片带直链', () => {
    const detail = normalizePostDetail(
      { postId: 1, title: 't', content: '<p>正文</p>', images: ['https://a.com/1.jpg'] },
      8000,
      30,
    );
    expect(detail?.body).toBe('正文');
    expect(detail?.images).toEqual(['https://a.com/1.jpg']);
    expect(detail?.truncated).toBe(false);
  });

  it('超长正文截断并置位', () => {
    const detail = normalizePostDetail({ postId: 1, content: 'a'.repeat(20) }, 10, 30);
    expect(detail?.body).toHaveLength(10);
    expect(detail?.truncated).toBe(true);
  });

  it('没有正文时 body 是空串', () => {
    expect(normalizePostDetail({ postId: 1 }, 8000, 30)?.body).toBe('');
  });
});

describe('postUrl / describeCounts', () => {
  it('缺 id 时不拼地址', () => {
    expect(postUrl('', '1')).toBe('');
    expect(postUrl('abc', '')).toBe('');
  });

  it('计数只报非零的', () => {
    expect(describeCounts({ postId: '1', title: 't', blogId: '', blogName: '', publishAt: '', excerpt: '', likeCount: 3, commentCount: 0, url: '' })).toBe('赞 3');
    expect(describeCounts({ postId: '1', title: 't', blogId: '', blogName: '', publishAt: '', excerpt: '', likeCount: 0, commentCount: 0, url: '' })).toBe('');
  });
});
