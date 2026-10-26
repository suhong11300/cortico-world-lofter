import { describe, expect, it } from 'vitest';
import { buildDwrRequest, firstDwrReply, parseDwrLiteral, parseDwrReply } from '../src/dwr.ts';

describe('buildDwrRequest', () => {
  it('把 bean / method / 参数拼成 plaincall 表单', () => {
    const req = buildDwrRequest('BlogBean', 'getPostList', ['abc', 20, true, null]);
    expect(req.url).toBe('https://www.lofter.com/dwr/mobile/call/plaincall/BlogBean.getPostList.dwr');
    const lines = req.body.split('\n');
    expect(lines).toContain('callCount=1');
    expect(lines).toContain('page=/dwr/mobile/call/plaincall/BlogBean.getPostList.dwr');
    expect(lines).toContain('c0-scriptName=BlogBean');
    expect(lines).toContain('c0-methodName=getPostList');
    expect(lines).toContain('c0-param0=string:abc');
    expect(lines).toContain('c0-param1=number:20');
    expect(lines).toContain('c0-param2=boolean:true');
    expect(lines).toContain('c0-param3=null:null');
    expect(lines[lines.length - 1]).toBe('batchId=0');
  });

  it('字符串参数做 urlencode,分号与等号不会破结构', () => {
    const req = buildDwrRequest('TagBean', 'getTagPostList', ['摄影&a=b;c']);
    expect(req.body).toContain('c0-param0=string:%E6%91%84%E5%BD%B1%26a%3Db%3Bc');
  });

  it('带上会话与批次号', () => {
    const req = buildDwrRequest('BlogBean', 'x', [], { scriptSessionId: 'S1', httpSessionId: 'H1', batchId: 7 });
    expect(req.body).toContain('scriptSessionId=S1');
    expect(req.body).toContain('httpSessionId=H1');
    expect(req.body).toContain('batchId=7');
  });

  it('数组与对象走 array: / object:', () => {
    const req = buildDwrRequest('BlogBean', 'x', [{ __type: 'array', value: [1, 2] }]);
    expect(req.body).toContain('c0-param0=array:%5B1%2C2%5D');
  });

  it('非法 bean 名直接抛错', () => {
    expect(() => buildDwrRequest('Bad-Name', 'x')).toThrow();
  });
});

describe('parseDwrReply', () => {
  it('还原标量赋值', () => {
    const roots = parseDwrReply('var s0={};\ns0.blogId=12345;\ns0.blogName="张三";');
    expect(roots.s0).toEqual({ blogId: 12345, blogName: '张三' });
  });

  it('没先声明 var 也能建出根', () => {
    const roots = parseDwrReply('s0.a=1;');
    expect(roots.s0).toEqual({ a: 1 });
  });

  it('数组下标路径按数组建', () => {
    const roots = parseDwrReply('s0.posts[0].title="甲";s0.posts[0].id=7;s0.posts[1].title="乙";');
    expect(roots.s0).toEqual({ posts: [{ title: '甲', id: 7 }, { title: '乙' }] });
  });

  it('引号里的分号不切句', () => {
    const roots = parseDwrReply('s0.text="a;b;c";s0.ok=true;');
    expect(roots.s0).toEqual({ text: 'a;b;c', ok: true });
  });

  it('忽略 DWR 注释行', () => {
    const roots = parseDwrReply('//#DWR-INSERT\n//#DWR-REPLY\nvar s0={};\ns0.n=null;');
    expect(roots.s0).toEqual({ n: null });
  });

  it('空响应得到空对象', () => {
    expect(parseDwrReply('')).toEqual({});
  });

  it('多个根各自独立', () => {
    const roots = parseDwrReply('var s0={};s0.a=1;var s1="x";');
    expect(roots.s0).toEqual({ a: 1 });
    expect(roots.s1).toBe('x');
  });

  it('JSON 形态的整块赋值也能吃下', () => {
    const roots = parseDwrReply('var s0={"a":[1,2],"b":"c"};');
    expect(roots.s0).toEqual({ a: [1, 2], b: 'c' });
  });
});

describe('parseDwrLiteral', () => {
  it('数字带小数与科学计数', () => {
    expect(parseDwrLiteral('1.5')).toBe(1.5);
    expect(parseDwrLiteral('1e3')).toBe(1000);
  });

  it('布尔与 null', () => {
    expect(parseDwrLiteral('false')).toBe(false);
    expect(parseDwrLiteral('null')).toBeNull();
    expect(parseDwrLiteral('undefined')).toBeNull();
  });

  it('单引号字符串', () => {
    expect(parseDwrLiteral("'abc'")).toBe('abc');
  });
});

describe('firstDwrReply', () => {
  it('取第一条根', () => {
    expect(firstDwrReply('var s0={};s0.a=1;')).toEqual({ a: 1 });
  });

  it('空体返回 undefined', () => {
    expect(firstDwrReply('')).toBeUndefined();
  });
});
