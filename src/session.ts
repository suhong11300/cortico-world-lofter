/**
 * 登录态存储。
 *
 * LOFTER 的读接口全要登录态:未登录时 DWR 回 200 + 空体。Cookie 不放 config.json
 * (会被部署目录的整体备份带走),也不放 .env(ctx.storeSecret 拒收带空白的值,
 * 而 Cookie 头天然带空格与分号)。这里落在 data/lofter/session.json,文件权限压到
 * 仅本人可读,面板粘贴、面板清除。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanText } from './types.ts';

/** 存储格式版本。 */
export const LOFTER_SESSION_VERSION = 1;

export interface LofterSession {
  version: number;
  /** 归一化后的 Cookie 请求头原文;空串表示没登录。 */
  cookie: string;
  /** 上次写入时间(ISO),面板显示「几天前粘的」。 */
  updatedAt: string;
  /** 探活时拿到的昵称,面板上显示「已登录:xxx」。 */
  nickname: string;
  /** DWR 会话粘性字段,首次调用后回填。 */
  scriptSessionId: string;
  httpSessionId: string;
}

export function sessionFile(dataDir: string): string {
  return join(dataDir, 'lofter', 'session.json');
}

function emptySession(): LofterSession {
  return {
    version: LOFTER_SESSION_VERSION,
    cookie: '',
    updatedAt: '',
    nickname: '',
    scriptSessionId: '',
    httpSessionId: '',
  };
}

export function readSession(dataDir: string): LofterSession {
  const file = sessionFile(dataDir);
  if (!existsSync(file)) return emptySession();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return emptySession();
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  const text = (key: string): string => (typeof record[key] === 'string' ? (record[key] as string) : '');
  return {
    version: LOFTER_SESSION_VERSION,
    cookie: text('cookie'),
    updatedAt: text('updatedAt'),
    // 昵称来自上游响应,会进环境前缀与面板;先洗控制字符再限长,别把别人的排版带进来。
    nickname: cleanText(text('nickname'), 40),
    scriptSessionId: text('scriptSessionId'),
    httpSessionId: text('httpSessionId'),
  };
}

/** 原子写 + 压权限;window 上 chmod 只影响读属性,失败忽略。 */
export function writeSession(dataDir: string, session: LofterSession): void {
  const file = sessionFile(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(session, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* 非 posix 文件系统忽略 */
  }
}

export function clearSession(dataDir: string): void {
  const file = sessionFile(dataDir);
  if (existsSync(file)) rmSync(file, { force: true });
}

/**
 * 把面板里粘贴的原文归一化成 Cookie 请求头。
 *
 * 用户可能直接抄 DevTools 的「Cookie: a=1; b=2」整行,也可能带换行;
 * 这里统一去掉前缀、把换行压成分号,并挡掉明显不像 Cookie 的输入。
 */
export function normalizeCookie(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Cookie 要是一段文本。');
  let text = raw.replace(/\r\n?/g, '\n').trim();
  if (text === '') throw new Error('Cookie 是空的。');
  text = text.replace(/^cookie\s*:\s*/i, '');
  const parts = text
    .split('\n')
    .map((line) => line.trim().replace(/^cookie\s*:\s*/i, '').replace(/;\s*$/, ''))
    .filter((line) => line !== '');
  text = parts.join('; ').replace(/\s*;\s*/g, '; ').replace(/\s{2,}/g, ' ').trim();
  if (!text.includes('=')) throw new Error('这段文本里没有 key=value,不像是 Cookie。');
  if (/[\u0000-\u001f]/.test(text)) throw new Error('Cookie 里有控制字符,粘贴时可能截断了。');
  return text;
}

/** 只留「有没有登录」这一位,给日志和工具回执用。 */
export function hasCookie(session: LofterSession): boolean {
  return session.cookie.trim() !== '';
}

/** 面板上展示的脱敏摘要:只露出前两个键名与总长度。 */
export function maskCookie(cookie: string): string {
  if (cookie === '') return '';
  const keys = cookie
    .split(';')
    .map((part) => part.split('=')[0].trim())
    .filter((key) => key !== '');
  const head = keys.slice(0, 2).join('、');
  const rest = keys.length > 2 ? ' 等 ' + keys.length + ' 项' : '';
  return head + rest + '(' + cookie.length + ' 字符)';
}
