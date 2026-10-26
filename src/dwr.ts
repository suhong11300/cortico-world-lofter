/**
 * LOFTER 的 DWR 通道编解码。
 *
 * 站点前端不是 REST:页面里内联了 location.dwr = ".../plaincall/",所有读接口都走
 * DWR 的 plaincall —— 请求体是一行一个 key=value 的表单,响应是若干条赋值语句:
 *   var s0={};
 *   s0.blogId=12345;
 *   s0.posts[0].title="...";
 * 这里只做两件纯函数:buildDwrRequest 组请求,parseDwrReply 还原对象树。
 * 网络与鉴权交给上层,方便单测。
 */

/** 一次 DWR 调用要 POST 的位置与体。 */
export interface DwrRequest {
  url: string;
  body: string;
}

/** 默认站点;企业内网那套(lofter.hz.netease.com)与这里无关。 */
export const DWR_ORIGIN = 'https://www.lofter.com';

/** plaincall 入口前缀,与页面内联脚本里的路径一致。 */
export const DWR_CALL_PATH = '/dwr/mobile/call/plaincall/';

/** DWR session 的粘性字段;首次为空,LOFTER 会在响应里回带。 */
export interface DwrSession {
  scriptSessionId?: string;
  httpSessionId?: string;
  batchId?: number;
}

/** 显式标类型:数组/对象要按 DWR 的写法发,不能当字符串。 */
export interface DwrComplex {
  __type: 'object' | 'array';
  value: unknown;
}

/** 一个实参:基本类型按 JS 值定,复杂类型用 DwrComplex 包一层。 */
export type DwrParam = string | number | boolean | null | DwrComplex;

function encodeValue(value: DwrParam): string {
  if (value === null || value === undefined) return 'null:null';
  if (typeof value === 'string') return 'string:' + encodeURIComponent(value);
  if (typeof value === 'number') return 'number:' + (Number.isFinite(value) ? String(value) : '0');
  if (typeof value === 'boolean') return 'boolean:' + (value ? 'true' : 'false');
  const shaped = value as DwrComplex;
  const prefix = shaped.__type === 'array' ? 'array:' : 'object:';
  return prefix + encodeURIComponent(JSON.stringify(shaped.value ?? null));
}

/**
 * 组一次 plaincall 请求。
 *
 * @param bean    DWR 暴露的 Bean 名,如 BlogBean
 * @param method  Bean 上的方法名,如 getPostList
 * @param params  按顺序的实参
 * @param session 上一次响应带回来的 DWR session,可省
 * @param origin  站点根,默认 www.lofter.com
 */
export function buildDwrRequest(
  bean: string,
  method: string,
  params: DwrParam[] = [],
  session: DwrSession = {},
  origin: string = DWR_ORIGIN,
): DwrRequest {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(bean)) throw new Error('DWR bean 名不合法: ' + bean);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(method)) throw new Error('DWR method 名不合法: ' + method);
  const page = DWR_CALL_PATH + bean + '.' + method + '.dwr';
  const lines: string[] = [
    'callCount=1',
    'page=' + page,
    'httpSessionId=' + (session.httpSessionId ?? ''),
    'scriptSessionId=' + (session.scriptSessionId ?? ''),
    'c0-scriptName=' + bean,
    'c0-methodName=' + method,
    'c0-id=0',
  ];
  for (let index = 0; index < params.length; index += 1) {
    lines.push('c0-param' + index + '=' + encodeValue(params[index]));
  }
  lines.push('batchId=' + (session.batchId ?? 0));
  return { url: origin + page, body: lines.join('\n') };
}

/** 找到语句里第一个不在引号/括号内的 = 的下标;没找到返回 -1。 */
function topLevelEquals(text: string): number {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== '') {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{' || ch === '(') depth += 1;
    else if (ch === ']' || ch === '}' || ch === ')') depth -= 1;
    else if (ch === '=' && depth === 0 && text[i + 1] !== '=') return i;
  }
  return -1;
}

/** 按分号切语句,跳过引号与括号里的分号。 */
function splitStatements(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quote = '';
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== '') {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{' || ch === '(') depth += 1;
    else if (ch === ']' || ch === '}' || ch === ')') depth -= 1;
    else if (ch === ';' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out
    .map((line) => line.replace(/\/\/#[^\n]*/g, '').trim())
    .filter((line) => line !== '');
}

/** 解析 .a.b[0] 这样的后缀路径;不合法返回 undefined。 */
function parsePath(raw: string): Array<string | number> | undefined {
  const path: Array<string | number> = [];
  let rest = raw.trim();
  while (rest !== '') {
    if (rest[0] === '.') {
      const match = /^\.([A-Za-z_$][A-Za-z0-9_$]*)/.exec(rest);
      if (!match) return undefined;
      path.push(match[1]);
      rest = rest.slice(match[0].length);
      continue;
    }
    if (rest[0] === '[') {
      const end = rest.indexOf(']');
      if (end < 0) return undefined;
      const inner = rest.slice(1, end).trim();
      if (/^-?\d+$/.test(inner)) path.push(Number(inner));
      else if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) {
        path.push(inner.slice(1, -1));
      } else return undefined;
      rest = rest.slice(end + 1);
      continue;
    }
    return undefined;
  }
  return path;
}

/** 字面量 → JS 值;认不出的保持原样字符串。 */
export function parseDwrLiteral(raw: string): unknown {
  const text = raw.trim();
  if (text === '') return undefined;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === 'undefined') return null;
  if (text === 'NaN') return NaN;
  if (/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return Number(text);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    const inner = text.slice(1, -1);
    if (text[0] === '"') {
      try {
        return JSON.parse(text);
      } catch {
        return inner;
      }
    }
    return inner.replace(/\\'/g, "'");
  }
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      /* 落到下面按裸串处理 */
    }
  }
  return text;
}

function containerFor(next: string | number): Record<string | number, unknown> | unknown[] {
  return typeof next === 'number' ? [] : {};
}

function assign(root: Record<string, unknown>, path: Array<string | number>, value: unknown): void {
  let cursor: Record<string | number, unknown> | unknown[] = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    const store = cursor as Record<string | number, unknown>;
    const next = store[key];
    if (next === undefined || next === null || typeof next !== 'object') {
      store[key] = containerFor(path[i + 1]);
    }
    cursor = store[key] as Record<string | number, unknown> | unknown[];
  }
  const last = path[path.length - 1];
  (cursor as Record<string | number, unknown>)[last] = value;
}

/**
 * 解析 plaincall 响应。
 *
 * 返回 根名 → 值 的映射(通常是 s0、s1 几条),调用方一般只关心第一个。
 * 未登录时 LOFTER 回空体,这里得到空对象 —— 上层据此判「没登录」。
 */
export function parseDwrReply(text: string): Record<string, unknown> {
  const roots: Record<string, unknown> = {};
  for (const statement of splitStatements(text)) {
    const eq = topLevelEquals(statement);
    if (eq < 0) continue;
    const left = statement.slice(0, eq).trim().replace(/^var\s+/, '');
    const right = statement.slice(eq + 1);
    const head = /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(left);
    if (!head) continue;
    const rootName = head[1];
    const suffix = left.slice(head[0].length);
    const path = suffix === '' ? [] : parsePath(suffix);
    if (path === undefined) continue;
    if (path.length === 0) {
      roots[rootName] = parseDwrLiteral(right);
      continue;
    }
    const existing = roots[rootName];
    if (existing === undefined || existing === null || typeof existing !== 'object') {
      roots[rootName] = containerFor(path[0]);
    }
    assign(roots[rootName] as Record<string, unknown>, path, parseDwrLiteral(right));
  }
  return roots;
}

/** 取第一条根(s0);没有返回 undefined。 */
export function firstDwrReply(text: string): unknown {
  const roots = parseDwrReply(text);
  const keys = Object.keys(roots);
  return keys.length === 0 ? undefined : roots[keys[0]];
}
