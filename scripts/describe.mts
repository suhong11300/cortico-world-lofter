/**
 * 重新生成 describe.json,或(带 --check)只核对包里那份与代码里的定义是否一致。
 * Cortina 仓库没有根脚本,Cortico 官方的 describe:extension 跑不了,所以这里自带一份。
 *   node_modules/.bin/tsx scripts/describe.mts
 *   node_modules/.bin/tsx scripts/describe.mts --check
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDescribe, exportDescribe } from 'cortico/extensions/describe-export.ts';
import { LOFTER } from '../src/definition.ts';

const opts = { scratchDir: mkdtempSync(join(tmpdir(), 'lofter-describe-')), packageDir: process.cwd() };

if (process.argv.includes('--check')) {
  const report = await checkDescribe('world', LOFTER, 'describe.json', opts);
  for (const line of report.ok) console.log('ok   ' + line);
  for (const line of report.warnings) console.log('warn ' + line);
  for (const line of report.failures) console.log('FAIL ' + line);
  if (report.failures.length) process.exitCode = 1;
} else {
  const file = await exportDescribe('world', LOFTER, opts);
  if (!file) throw new Error('definition has no describe block');
  writeFileSync('describe.json', JSON.stringify(file, null, 2) + '\n', 'utf8');
  console.log('wrote describe.json: tools=' + (file.tools ?? []).map((t) => t.name).join(',')
    + ' prompts=' + (file.prompts ?? []).map((p) => p.key).join(','));
}
