/** 背景任務狀態管理 */

interface OpEntry {
  label: string;
  callback: (() => void) | null;
}

const ops = new Map<string, OpEntry>();
let statusUpdater: (() => void) | null = null;

/** 由 statusBar 注冊更新函式（避免循環 import） */
export function registerStatusUpdater(fn: () => void): void {
  statusUpdater = fn;
}

/** 開始背景任務 */
export function startProcessing(key: string, label: string): void {
  ops.set(key, { label, callback: null });
  statusUpdater?.();
}

/** 結束背景任務，執行已登記的 callback（fireCallback 預設 true；error path 傳 false 可跳過 rebuild） */
export function finishProcessing(key: string, fireCallback = true): void {
  const entry = ops.get(key);
  ops.delete(key);
  statusUpdater?.();
  if (fireCallback) {
    entry?.callback?.();
  }
}

/** 是否正在處理中 */
export function isProcessing(key: string): boolean {
  return ops.has(key);
}

/** 登記完成後的 callback（每次渲染覆蓋上一個，避免 stale closure） */
export function onProcessingComplete(key: string, cb: () => void): void {
  const entry = ops.get(key);
  if (entry) {
    entry.callback = cb;
  }
}

/** 取得目前所有執行中任務 */
export function getActiveOps(): { key: string; label: string }[] {
  return Array.from(ops.entries()).map(([key, { label }]) => ({ key, label }));
}
