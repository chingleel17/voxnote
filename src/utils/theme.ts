/** 主題管理：dark / light，以 html[data-theme] 屬性切換，偏好存入 localStorage */

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'voxnote_theme';

function resolveInitialTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'dark' || stored === 'light') {
    return stored;
  }
  // 跟隨 OS 偏好
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

/** 初始化主題，應於 DOMContentLoaded 最前面呼叫 */
export function initTheme(): void {
  applyTheme(resolveInitialTheme());
}

/** 切換主題並儲存偏好 */
export function toggleTheme(): Theme {
  const current = getTheme();
  const next: Theme = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem(STORAGE_KEY, next);
  applyTheme(next);
  return next;
}

/** 取得目前套用的主題 */
export function getTheme(): Theme {
  const attr = document.documentElement.getAttribute('data-theme');
  return attr === 'light' ? 'light' : 'dark';
}
