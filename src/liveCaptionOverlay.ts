import { LogicalSize } from '@tauri-apps/api/dpi';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  listenLiveCaption,
  listenLiveCaptionInteractive,
  listenLiveCaptionSettings,
  setLiveCaptionClickThrough,
  stopLiveCaption,
} from './api/liveCaption';
import type { LiveCaptionPayload } from './types';
import './liveCaptionOverlay.css';

/** 游標距離視窗邊緣多少像素內視為互動區（可調整大小）。 */
const EDGE_ZONE = 10;
/** 無新字幕時的清空檢查間隔。 */
const CLEAR_CHECK_INTERVAL = 500;

const overlayWindow = getCurrentWindow();
const overlayRoot = document.getElementById('caption-overlay');
const captionList = document.getElementById('caption-list');
const dragHandle = document.getElementById('caption-drag-handle');
const closeButton = document.getElementById('caption-close');
const lockButton = document.getElementById('caption-lock');

let captions: LiveCaptionPayload[] = [];
let maxLines = 5;
let clearSeconds = 8;
let lastCaptionAt = 0;
let locked = false;

function renderLockButton(): void {
  if (!lockButton) return;
  lockButton.textContent = locked ? '解除鎖定' : '鎖定';
  lockButton.classList.toggle('is-locked', locked);
}

function renderCaptions(): void {
  if (!captionList) return;
  captionList.innerHTML = '';
  if (captions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'caption-line caption-empty';
    empty.textContent = '等待語音…';
    captionList.appendChild(empty);
    return;
  }

  for (const caption of captions) {
    const line = document.createElement('p');
    line.className = 'caption-line';
    line.textContent = caption.display_text;
    captionList.appendChild(line);
  }
  // 新字幕在最下方，保持捲動至底部。
  captionList.scrollTop = captionList.scrollHeight;
}

void listenLiveCaption((payload) => {
  const existingIndex = captions.findIndex((caption) => caption.sequence === payload.sequence);
  if (existingIndex >= 0) {
    captions[existingIndex] = payload;
  } else {
    const latestSequence = captions[captions.length - 1]?.sequence ?? 0;
    if (payload.translation !== null && payload.sequence < latestSequence) return;
    captions = [...captions, payload].slice(-maxLines);
  }
  lastCaptionAt = Date.now();
  renderCaptions();
});

void listenLiveCaptionSettings((settings) => {
  maxLines = Math.max(1, settings.max_lines);
  clearSeconds = Math.max(0, settings.clear_seconds);
  document.documentElement.style.setProperty('--caption-font-size', `${settings.font_size}px`);
  // 未啟用穿透時整窗恆為可互動狀態，直接套用視覺提示。
  overlayRoot?.classList.toggle('is-interactive', !settings.click_through);
  // session 啟動時的鎖定狀態沿用設定檔，之後僅由使用者點擊鎖定鈕改變。
  locked = settings.click_through;
  renderLockButton();
  captions = captions.slice(-maxLines);
  renderCaptions();
});

// 超過設定秒數沒有新字幕即清空，避免舊字幕永遠停留在畫面上。
window.setInterval(() => {
  if (clearSeconds <= 0 || captions.length === 0 || lastCaptionAt === 0) return;
  if (Date.now() - lastCaptionAt >= clearSeconds * 1000) {
    captions = [];
    renderCaptions();
  }
}, CLEAR_CHECK_INTERVAL);

// 穿透狀態下視窗收不到任何滑鼠事件（含 mousemove），故游標位置的偵測與穿透切換
// 一律由後端輪詢處理；前端只負責依後端通知更新視覺提示。
void listenLiveCaptionInteractive((isInteractive) => {
  overlayRoot?.classList.toggle('is-interactive', isInteractive);
});

closeButton?.addEventListener('click', () => {
  void stopLiveCaption().catch(() => undefined);
});

// 鎖定＝穿透：開啟後滑鼠事件穿透至下層視窗，游標移回標題列或邊框時仍會暫時恢復互動，
// 因此這顆按鈕在鎖定狀態下依然點得到，不會把使用者鎖在穿透狀態。
lockButton?.addEventListener('click', () => {
  const next = !locked;
  void setLiveCaptionClickThrough(next)
    .then(() => {
      locked = next;
      renderLockButton();
    })
    .catch((error: unknown) => {
      console.error('無法切換字幕視窗鎖定', error);
    });
});

dragHandle?.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  if (event.target instanceof Element && event.target.closest('button')) return;
  void overlayWindow.startDragging().catch((error: unknown) => {
    console.error('無法拖曳即時字幕視窗', error);
  });
});

// 沿視窗邊框調整大小：改用 pointer capture，游標移出感應區也不會中斷。
type ResizeEdge = { horizontal: 'left' | 'right' | null; vertical: 'top' | 'bottom' | null };

function resolveResizeEdge(x: number, y: number): ResizeEdge | null {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const horizontal = x <= EDGE_ZONE ? 'left' : x >= width - EDGE_ZONE ? 'right' : null;
  const vertical = y <= EDGE_ZONE ? 'top' : y >= height - EDGE_ZONE ? 'bottom' : null;
  if (!horizontal && !vertical) return null;
  return { horizontal, vertical };
}

document.addEventListener('pointermove', (event) => {
  const edge = resolveResizeEdge(event.clientX, event.clientY);
  if (!overlayRoot) return;
  if (!edge) {
    overlayRoot.style.cursor = '';
    return;
  }
  if (edge.horizontal && edge.vertical) {
    const nwse =
      (edge.horizontal === 'left' && edge.vertical === 'top') ||
      (edge.horizontal === 'right' && edge.vertical === 'bottom');
    overlayRoot.style.cursor = nwse ? 'nwse-resize' : 'nesw-resize';
  } else if (edge.horizontal) {
    overlayRoot.style.cursor = 'ew-resize';
  } else {
    overlayRoot.style.cursor = 'ns-resize';
  }
});

document.addEventListener('pointerdown', (event) => {
  const edge = resolveResizeEdge(event.clientX, event.clientY);
  if (!edge) return;
  event.preventDefault();
  const startX = event.screenX;
  const startY = event.screenY;
  const startWidth = window.innerWidth;
  const startHeight = window.innerHeight;
  const target = event.target as Element;
  target.setPointerCapture?.(event.pointerId);

  const onMove = (moveEvent: PointerEvent): void => {
    const deltaX = moveEvent.screenX - startX;
    const deltaY = moveEvent.screenY - startY;
    let width = startWidth;
    let height = startHeight;
    if (edge.horizontal === 'right') width = startWidth + deltaX;
    else if (edge.horizontal === 'left') width = startWidth - deltaX;
    if (edge.vertical === 'bottom') height = startHeight + deltaY;
    else if (edge.vertical === 'top') height = startHeight - deltaY;
    void overlayWindow.setSize(
      new LogicalSize(Math.max(360, Math.round(width)), Math.max(100, Math.round(height))),
    );
  };
  const onUp = (upEvent: PointerEvent): void => {
    target.releasePointerCapture?.(upEvent.pointerId);
    window.removeEventListener('pointermove', onMove);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp, { once: true });
});

renderCaptions();
renderLockButton();
