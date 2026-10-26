import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clearSession,
  hasCookie,
  maskCookie,
  normalizeCookie,
  readSession,
  sessionFile,
  writeSession,
} from '../src/session.ts';

describe('normalizeCookie', () => {
  it('去掉 Cookie: 前缀', () => {
    expect(normalizeCookie('Cookie: a=1; b=2')).toBe('a=1; b=2');
  });

  it('换行压成分号', () => {
    expect(normalizeCookie('a=1\nb=2')).toBe('a=1; b=2');
  });

  it('多行每行都带前缀也认', () => {
    expect(normalizeCookie('Cookie: a=1\nCookie: b=2')).toBe('a=1; b=2');
  });

  it('去掉多余空格与行尾分号', () => {
    expect(normalizeCookie('  a=1 ;   b=2 ;  ')).toBe('a=1; b=2');
  });

  it('没有 key=value 就报错', () => {
    expect(() => normalizeCookie('随便一段话')).toThrow();
  });

  it('空串报错', () => {
    expect(() => normalizeCookie('   ')).toThrow();
  });

  it('非字符串报错', () => {
    expect(() => normalizeCookie(undefined)).toThrow();
  });
});

describe('session 存取', () => {
  it('写入后能读回,文件落在 data/lofter/session.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lofter-session-'));
    writeSession(dir, {
      version: 1,
      cookie: 'a=1; b=2',
      updatedAt: '2026-10-27T00:00:00.000Z',
      nickname: '测试',
      scriptSessionId: '',
      httpSessionId: '',
    });
    expect(sessionFile(dir)).toBe(join(dir, 'lofter', 'session.json'));
    const back = readSession(dir);
    expect(back.cookie).toBe('a=1; b=2');
    expect(back.nickname).toBe('测试');
    expect(hasCookie(back)).toBe(true);
    const text = readFileSync(sessionFile(dir), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('文件不存在时返回空会话', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lofter-session-'));
    expect(readSession(dir).cookie).toBe('');
    expect(hasCookie(readSession(dir))).toBe(false);
  });

  it('文件坏了也退回空会话,不抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lofter-session-'));
    writeSession(dir, {
      version: 1, cookie: 'x=1', updatedAt: '', nickname: '', scriptSessionId: '', httpSessionId: '',
    });
    const file = sessionFile(dir);
    require('node:fs').writeFileSync(file, '{坏', 'utf8');
    expect(readSession(dir).cookie).toBe('');
  });

  it('清除后读回是空的', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lofter-session-'));
    writeSession(dir, {
      version: 1, cookie: 'x=1', updatedAt: '', nickname: '', scriptSessionId: '', httpSessionId: '',
    });
    clearSession(dir);
    expect(readSession(dir).cookie).toBe('');
  });

  it('权限压到仅本人可读(posix)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lofter-session-'));
    writeSession(dir, {
      version: 1, cookie: 'x=1', updatedAt: '', nickname: '', scriptSessionId: '', httpSessionId: '',
    });
    const mode = statSync(sessionFile(dir)).mode & 0o777;
    if (process.platform !== 'win32') expect(mode).toBe(0o600);
  });
});

describe('maskCookie', () => {
  it('只露前两个键名与长度', () => {
    const masked = maskCookie('a=1; b=2; c=3');
    expect(masked).toContain('a');
    expect(masked).toContain('等 3 项');
    expect(masked).not.toContain('c=3');
  });

  it('空 Cookie 返回空串', () => {
    expect(maskCookie('')).toBe('');
  });
});
