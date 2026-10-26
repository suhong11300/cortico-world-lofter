/**
 * LOFTER 阅读面板:粘一次 Cookie,看一眼登录态与四个能力的开关。
 *
 * 浏览器侧只允许 import type 框架,运行时依赖一律本地实现。
 */
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

const PANEL = 'lofter';

interface AbilityView {
  tagStream: boolean;
  search: boolean;
  download: boolean;
  watch: boolean;
}

interface PanelState {
  loggedIn: boolean;
  cookieHint: string;
  updatedAt: string;
  nickname: string;
  sessionFile: string;
  abilities: AbilityView;
  downloadDir: string;
}

interface SaveResult {
  ok: boolean;
  loggedIn: boolean;
  cookieHint: string;
  message: string;
}

interface ProbeResult {
  ok: boolean;
  loggedIn: boolean;
  message: string;
}

const errText = (error: unknown): string => String((error as Error)?.message ?? error);

const onOff = (value: boolean): string => (value ? '开' : '关');

const stamp = (iso: string): string => {
  if (iso === '') return '没记';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    at.getFullYear() +
    '-' +
    pad(at.getMonth() + 1) +
    '-' +
    pad(at.getDate()) +
    ' ' +
    pad(at.getHours()) +
    ':' +
    pad(at.getMinutes())
  );
};

function mount(ctx: WebUiPanelContext): void {
  const { ui } = ctx;

  const card = ui.sheet({
    title: 'LOFTER 阅读',
    en: 'lofter reader',
    desc: '粘一次浏览器里的 Cookie,模型就能按你说的去读博文。标签流、站内搜索、存图、订阅各自一个开关,默认全关。',
  });
  card.el.classList.add('iocard');

  const loginLine = ui.msgline('正在读登录态…');
  const note = ui.msgline('');
  const abilityLine = ui.msgline('');
  const dirLine = ui.msgline('');
  const fileLine = ui.msgline('');

  const editor = ui.textarea({
    rows: 8,
    placeholder: '从浏览器 DevTools 的 Network 里随便点一个 www.lofter.com/dwr/... 请求,把 Request Headers 里的 Cookie 整段粘进来。',
  });

  const saveBtn = ui.button('保存并探活', { variant: 'primary' });
  const probeBtn = ui.button('只探活', { size: 'md' });
  const clearBtn = ui.button('清除 Cookie', { size: 'md', variant: 'plain' });

  const bar = ui.rowbar();
  bar.append(saveBtn, probeBtn, clearBtn);

  card.body.append(
    loginLine,
    ui.field('Cookie', editor),
    bar,
    note,
    abilityLine,
    dirLine,
    fileLine,
  );
  ctx.root.appendChild(card.el);

  let state: PanelState | null = null;

  function paintLogin(next: PanelState): void {
    loginLine.classList.toggle('bad', !next.loggedIn);
    loginLine.textContent = next.loggedIn
      ? '已登录' + (next.nickname === '' ? '' : ':' + next.nickname) + '(本机存的是 ' + next.cookieHint + ')'
      : '还没登录:本机没有任何 Cookie,模型现在只能问你要链接。';
  }

  function paintAbilities(next: PanelState): void {
    const skills = next.abilities;
    const off = [
      skills.tagStream ? '' : '标签流',
      skills.search ? '' : '站内搜索',
      skills.download ? '' : '存图',
      skills.watch ? '' : '订阅',
    ].filter((item) => item !== '');
    abilityLine.textContent =
      '能力:标签流 ' +
      onOff(skills.tagStream) +
      ' · 站内搜索 ' +
      onOff(skills.search) +
      ' · 存图 ' +
      onOff(skills.download) +
      ' · 订阅 ' +
      onOff(skills.watch) +
      (off.length === 0 ? '(全开)' : '(要开「' + off.join('、') + '」去配置页的 worlds.lofter 段)');
    dirLine.textContent = '存图目录:' + next.downloadDir;
    fileLine.textContent = '登录态文件:' + next.sessionFile + '(更新于 ' + stamp(next.updatedAt) + ')';
  }

  function apply(next: PanelState): void {
    state = next;
    paintLogin(next);
    paintAbilities(next);
  }

  const reload = (): Promise<void> =>
    ctx
      .invoke<PanelState>('state')
      .then(apply)
      .catch((error: unknown) => {
        loginLine.textContent = '读不到面板状态:' + errText(error);
        loginLine.classList.add('bad');
      });

  void reload();

  const busyFor = (title: string, text: string, button: HTMLElement, run: () => Promise<void>): void => {
    const busy = ui.busy(title, text);
    const off = ui.disable(saveBtn, probeBtn, clearBtn, editor);
    void run().finally(() => {
      off.dispose();
      busy.dispose();
      void button;
    });
  };

  saveBtn.addEventListener('click', () => {
    const raw = editor.value.trim();
    if (raw === '') {
      note.textContent = '先把 Cookie 粘进上面的框里。';
      note.classList.add('bad');
      return;
    }
    busyFor('保存并探活', '正在写入本地并试一次读取…', saveBtn, async () => {
      try {
        const result = await ctx.invoke<SaveResult>('save-cookie', [raw]);
        note.textContent = result.message;
        note.classList.toggle('bad', !result.loggedIn);
        ui.toast(result.loggedIn ? '登录态可用' : '存下了,但没探通', result.loggedIn ? 'ok' : 'bad');
        if (result.loggedIn) editor.value = '';
        await reload();
      } catch (error) {
        note.textContent = '保存失败:' + errText(error);
        note.classList.add('bad');
      }
    });
  });

  probeBtn.addEventListener('click', () => {
    busyFor('探活', '正在拿本机的 Cookie 试一次…', probeBtn, async () => {
      try {
        const result = await ctx.invoke<ProbeResult>('probe');
        note.textContent = result.message;
        note.classList.toggle('bad', !result.ok);
        ui.toast(result.ok ? '通的' : '没通', result.ok ? 'ok' : 'bad');
        await reload();
      } catch (error) {
        note.textContent = '探活失败:' + errText(error);
        note.classList.add('bad');
      }
    });
  });

  clearBtn.addEventListener('click', () => {
    if (state === null || !state.loggedIn) {
      note.textContent = '本来就没有存 Cookie。';
      note.classList.remove('bad');
      return;
    }
    const asked = ui.confirm({
      title: '清除本机的 Cookie?',
      body: '清掉之后模型就读不了博文,直到你再粘一次。形象包与配置不受影响。',
      danger: true,
    });
    void asked.then((agreed) => {
      if (!agreed) return;
      return ctx
        .invoke<{ ok: boolean; message: string }>('clear-cookie')
        .then((result) => {
          note.textContent = result.message;
          note.classList.remove('bad');
          ui.toast('已清除', 'ok');
          return reload();
        })
        .catch((error: unknown) => {
          note.textContent = '清除失败:' + errText(error);
          note.classList.add('bad');
        });
    });
  });
}

const bundle = { panels: { [PANEL]: { mount } } };

export default bundle;
