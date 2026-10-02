import type { LiveCaptionPayload, LiveCaptionSettingsPayload, LiveCaptionStatus } from '../src/types';

// 假 Tauri 事件匯流排只在測試頁內運作，不讀取設定或呼叫桌面／網路服務。
const callbacks = new Map<number, (event: { payload: unknown }) => void>();
const listeners = new Map<string, number>();
let nextId = 0;
Object.assign(window, {
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: 'caption-overlay' } },
    transformCallback: (callback: (event: { payload: unknown }) => void): number => {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback: (id: number): void => { callbacks.delete(id); },
    invoke: async (command: string, args?: { event?: string; handler?: number }): Promise<unknown> => {
      if (command === 'plugin:event|listen' && args?.event && args.handler) {
        listeners.set(args.event, args.handler);
        return args.handler;
      }
      throw new Error(`測試不應呼叫 ${command}`);
    },
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
});

const results: string[] = [];
const overlay = document.querySelector<HTMLElement>('#caption-overlay')!;
const list = document.querySelector<HTMLElement>('#caption-list')!;
const header = document.querySelector<HTMLElement>('#caption-drag-handle')!;
const pause = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function emit(event: string, payload: unknown): void {
  const callback = callbacks.get(listeners.get(event) ?? -1);
  assert(callback, `未註冊事件 ${event}`);
  callback({ payload });
}

function status(sessionId: string | null, active: boolean): void {
  const payload: LiveCaptionStatus = { active, session_id: sessionId, backend: active ? 'assemblyai_streaming' : null, audio_source: active ? 'system' : null };
  emit('live-caption-status', payload);
}

function settings(fontSize = 28, clearSeconds = 0): void {
  const payload: LiveCaptionSettingsPayload = { font_size: fontSize, clear_seconds: clearSeconds, click_through: false };
  emit('live-caption-settings', payload);
}

function caption(sessionId: string, sequence: number, revision = 1, phase: LiveCaptionPayload['phase'] = 'partial', text = `第${sequence}段`): LiveCaptionPayload {
  return {
    session_id: sessionId, sequence, revision, phase, original: text,
    translation: phase === 'postprocessed' ? '翻譯內容' : null,
    display_text: phase === 'postprocessed' ? `${text}\n翻譯內容` : text,
    confirmed_text: phase === 'partial' ? '' : text,
    tentative_text: phase === 'partial' ? text : '',
    is_tentative: phase === 'partial',
  };
}

function lines(): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>('[data-sequence]'));
}

function check(message: string, condition: unknown): void {
  assert(condition, message);
  results.push(message);
}

async function run(): Promise<void> {
  await import('../src/liveCaptionOverlay');
  check('事件監聽已註冊', ['live-caption', 'live-caption-status', 'live-caption-settings'].every((name) => listeners.has(name)));
  settings();
  status('A', true);
  const first = caption('A', 1);
  emit('live-caption', first);
  const node = lines()[0];
  check('暫定段有明確視覺區分', node.classList.contains('caption-tentative'));
  emit('live-caption', caption('A', 1, 2, 'partial', '修正後'));
  check('同段修正保留原 DOM 節點', lines().length === 1 && lines()[0] === node && node.textContent === '修正後');
  emit('live-caption', caption('A', 1, 1, 'partial', '舊版本'));
  emit('live-caption', caption('A', 1, 2, 'partial', '重送'));
  check('拒絕重送與較舊修訂', node.textContent === '修正後');
  const confirmedPartial = caption('A', 1, 3, 'partial', '段內已確定');
  confirmedPartial.is_tentative = false;
  confirmedPartial.confirmed_text = '段內已確定';
  confirmedPartial.tentative_text = '';
  emit('live-caption', confirmedPartial);
  check('段內 confirmed 維持穩定樣式但尚非整段 final', node.dataset.phase === 'partial' && !node.classList.contains('caption-tentative'));
  emit('live-caption', caption('A', 1, 4, 'final', '完成文字'));
  emit('live-caption', caption('A', 1, 5, 'partial', '完成後暫定'));
  check('final 後 partial 不退回暫定', node.textContent === '完成文字' && !node.classList.contains('caption-tentative'));
  emit('live-caption', caption('A', 2, 1, 'final', '完成文字'));
  check('不同段相同短句仍保留', lines().length === 2);
  emit('live-caption', caption('A', 1, 6, 'postprocessed', '完成文字'));
  check('晚到譯文只更新保留的原段', lines().length === 2 && lines()[0] === node && node.textContent?.includes('翻譯內容'));
  emit('live-caption', caption('A', 1, 7, 'postprocessed', '不應修改完成原文'));
  check('後處理不能改寫已完成原文', node.textContent?.startsWith('完成文字'));

  status('A', false);
  status('B', true);
  emit('live-caption', caption('A', 3, 1, 'final', '舊 session'));
  emit('live-caption', caption('B', 1, 1, 'final', '新 session'));
  status('A', true);
  status('A', false);
  emit('live-caption', caption('A', 1, 9, 'postprocessed', '完成文字'));
  check('停止再開始拒絕舊 session 狀態及譯文', lines().length === 1 && lines()[0].textContent === '新 session');
  status('B', false);
  check('停止清除畫面', lines().length === 0 && list.textContent?.includes('等待語音'));

  status('C', true);
  settings(28, 0.1);
  emit('live-caption', caption('C', 1, 1, 'final', '待清空'));
  await pause(300);
  emit('live-caption', caption('C', 1, 2, 'postprocessed', '待清空'));
  emit('live-caption', caption('C', 1, 2, 'postprocessed', '待清空'));
  await pause(300);
  check('譯文與相同事件不重設無語音計時', lines().length === 0);
  emit('live-caption', caption('C', 1, 3, 'final', '舊段復活'));
  emit('live-caption', caption('C', 1, 4, 'postprocessed', '舊段復活'));
  check('自動清空後較新修訂也不得復活', lines().length === 0);
  emit('live-caption', caption('C', 2, 1, 'final', '新語音'));
  check('清空後較新序列可顯示', lines().length === 1 && lines()[0].textContent === '新語音');
  status('C', false);
  status('D', true);
  settings(28, 0);
  emit('live-caption', caption('D', 1, 1, 'final', '不自動清空'));
  await pause(600);
  check('零秒停用自動清空但開始仍清空', lines().length === 1 && lines()[0].textContent === '不自動清空');

  overlay.style.height = '800px';
  settings(14);
  for (let sequence = 2; sequence <= 22; sequence += 1) {
    emit('live-caption', caption('D', sequence, 1, 'final', `短段${sequence}`));
  }
  await pause(50);
  check('容量上限 20 段含當前段', lines().length === 20 && lines()[0].dataset.sequence === '3' && lines()[lines().length - 1].dataset.sequence === '22');
  emit('live-caption', caption('D', 1, 9, 'postprocessed', '不自動清空'));
  emit('live-caption', caption('D', 2, 9, 'final', '移出段復活'));
  check('已移出段不因譯文或亂序修訂復活', lines().length === 20 && lines()[0].dataset.sequence === '3');
  overlay.style.height = '150px';
  await pause(50);
  check('縮小高度仍顯示最近歷史與當前段', lines().length >= 2 && lines().length < 20);
  overlay.style.height = '360px';
  await pause(50);
  const tallerCount = lines().length;
  check('增加高度顯示更多仍保留的歷史', tallerCount > 2);
  settings(36);
  await pause(50);
  check('字級變大減少可見歷史但仍保留兩段', lines().length >= 2 && lines().length < tallerCount);
  settings(14);
  await pause(50);
  check('字級變小恢復可見歷史', lines().length > 2);

  status('D', false);
  status('E', true);
  overlay.style.height = '130px';
  settings(28);
  const longText = `起點${'跨行字幕沒有空白也必須完整顯示'.repeat(28)}終點`;
  emit('live-caption', caption('E', 1, 1, 'final', longText));
  emit('live-caption', caption('E', 2, 1, 'partial', '接續的短段'));
  await pause(50);
  const maxScroll = list.scrollHeight - list.clientHeight;
  check('超長 turn 與短段並存且內容區可捲動', lines().length === 2 && maxScroll > 0);
  list.scrollTop = 0;
  check('捲到頂端可閱讀長段開頭且不遮標題', lines()[0].getBoundingClientRect().top >= header.getBoundingClientRect().bottom - 1 && lines()[0].textContent?.startsWith('起點'));
  list.scrollTop = list.scrollHeight;
  check('捲到底端可閱讀短段且不溢出視窗', lines()[1].getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom + 1 && list.getBoundingClientRect().bottom <= overlay.getBoundingClientRect().bottom);
  check('無空白長文字換行而不水平裁切', list.scrollWidth <= list.clientWidth + 1 && lines()[0].textContent?.endsWith('終點'));
  list.scrollTop = 0;
  emit('live-caption', caption('E', 1, 2, 'postprocessed', longText));
  check('長段晚到譯文仍保留頂部閱讀與當前段', lines().length === 2 && list.scrollHeight > list.clientHeight && list.scrollTop === 0 && lines()[1].textContent === '接續的短段');
}

void run().then(() => {
  const result = { passed: results.length, checks: results };
  Object.assign(window, { __liveCaptionOverlayResult: result });
  document.querySelector('#result')!.textContent = JSON.stringify(result, null, 2);
}).catch((error: unknown) => {
  const result = { failed: String(error), completed: results };
  Object.assign(window, { __liveCaptionOverlayResult: result });
  document.querySelector('#result')!.textContent = JSON.stringify(result, null, 2);
});
