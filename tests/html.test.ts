import { describe, expect, it } from 'vitest';
import {
  blogNameFromUrl,
  decodeEntities,
  extractPageImages,
  extractPermalinks,
  extractPostBody,
  extractPostTitle,
  findDivBlock,
  looksLikeLoginWall,
} from '../src/html.ts';

describe('decodeEntities', () => {
  it('还原命名实体', () => {
    expect(decodeEntities('a&amp;b')).toBe('a&b');
    expect(decodeEntities('&lt;p&gt;')).toBe('<p>');
    expect(decodeEntities('x&nbsp;y')).toBe('x y');
  });

  it('还原数字实体', () => {
    expect(decodeEntities('&#39;')).toBe(String.fromCharCode(39));
    expect(decodeEntities('&#20013;')).toBe(String.fromCharCode(0x4e2d));
    expect(decodeEntities('&#x4e2d;')).toBe(String.fromCharCode(0x4e2d));
  });

  it('认不出的实体原样保留', () => {
    expect(decodeEntities('&nosuchthing;')).toBe('&nosuchthing;');
    expect(decodeEntities('100% & more')).toBe('100% & more');
  });

  it('没有 & 时快速返回原串', () => {
    expect(decodeEntities('plain text')).toBe('plain text');
  });
});

describe('blogNameFromUrl', () => {
  it('取出子域名', () => {
    expect(blogNameFromUrl('https://road11.lofter.com/post/1d124ca3_2b73840be')).toBe('road11');
  });

  it('非 LOFTER 域名返回空串', () => {
    expect(blogNameFromUrl('https://example.com/x')).toBe('');
  });
});

describe('findDivBlock', () => {
  it('抓单层 div 的 innerHTML', () => {
    const html = '<div class="content"><p>hi</p></div>';
    expect(findDivBlock(html, /<div[^>]*class="content"[^>]*>/i)).toBe('<p>hi</p>');
  });

  it('嵌套 div 能配平', () => {
    const html = '<div class="content"><div class="inner">x</div><p>y</p></div><div>tail</div>';
    expect(findDivBlock(html, /<div[^>]*class="content"[^>]*>/i)).toBe('<div class="inner">x</div><p>y</p>');
  });

  it('找不到返回 undefined', () => {
    expect(findDivBlock('<p>x</p>', /<div class="content">/i)).toBeUndefined();
  });
});

describe('extractPostTitle', () => {
  it('优先 h1.title', () => {
    const html = '<title>ignored</title><h1 class="title">真正的标题</h1>';
    expect(extractPostTitle(html, 'road11')).toBe('真正的标题');
  });

  it('退回 title 并去掉博客名后缀', () => {
    const html = '<title>扬-笛啵威-road11</title>';
    expect(extractPostTitle(html, 'road11')).toBe('扬-笛啵威');
  });

  it('没有 title 返回空串', () => {
    expect(extractPostTitle('<p>x</p>')).toBe('');
  });
});

describe('extractPostBody', () => {
  it('取出正文 div', () => {
    const html = '<div class="content"><p>Set sail.</p></div>';
    expect(extractPostBody(html)).toBe('<p>Set sail.</p>');
  });

  it('没有正文返回 undefined', () => {
    expect(extractPostBody('<p>x</p>')).toBeUndefined();
  });
});

describe('extractPermalinks', () => {
  it('去重且保序', () => {
    const html = [
      '<a href="https://a.lofter.com/post/1d124ca3_2bc1f5597">x</a>',
      '<a href="https://a.lofter.com/post/1d124ca3_2bc1f5597">x</a>',
      '<a href="https://a.lofter.com/post/1f82af0d_2b7341f00">y</a>',
    ].join('');
    expect(extractPermalinks(html)).toEqual(['1d124ca3_2bc1f5597', '1f82af0d_2b7341f00']);
  });

  it('没有 permalink 返回空数组', () => {
    expect(extractPermalinks('<p>x</p>')).toEqual([]);
  });
});

describe('extractPageImages', () => {
  it('只收 lf127 的 img 链接并按 limit 截断', () => {
    const html = [
      '<img src="https://imglf5.lf127.net/img/aaa.jpg">',
      '<img src="https://imglf4.lf127.net/img/bbb.png">',
      '<img src="https://other.cdn.com/img/ccc.jpg">',
    ].join('');
    expect(extractPageImages(html, 5)).toEqual([
      'https://imglf5.lf127.net/img/aaa.jpg',
      'https://imglf4.lf127.net/img/bbb.png',
    ]);
    expect(extractPageImages(html, 1)).toHaveLength(1);
  });
});

describe('looksLikeLoginWall', () => {
  it('认出登录页特征', () => {
    expect(looksLikeLoginWall('<a href="/front/login">登录</a>')).toBe(true);
    expect(looksLikeLoginWall('<div class="login-wrap"></div>')).toBe(true);
  });

  it('正常页返回 false', () => {
    expect(looksLikeLoginWall('<div class="content">hi</div>')).toBe(false);
  });
});
