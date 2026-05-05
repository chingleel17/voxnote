import { getActiveOps, registerStatusUpdater } from '../utils/processingState';

let rotateTimer: ReturnType<typeof setInterval> | null = null;
let rotateIndex = 0;

function getStatusBar(): HTMLElement | null {
  return document.getElementById('status-bar');
}

function update(): void {
  const bar = getStatusBar();
  if (!bar) return;

  const tasks = getActiveOps();

  if (tasks.length === 0) {
    bar.classList.add('hidden');
    if (rotateTimer) {
      clearInterval(rotateTimer);
      rotateTimer = null;
    }
    return;
  }

  bar.classList.remove('hidden');

  if (tasks.length === 1) {
    bar.textContent = `⏳ ${tasks[0].label}`;
    if (rotateTimer) {
      clearInterval(rotateTimer);
      rotateTimer = null;
    }
    return;
  }

  // 多任務輪播
  const render = () => {
    const current = getActiveOps();
    if (current.length === 0) return;
    rotateIndex = rotateIndex % current.length;
    bar.textContent = `⏳ ${current.length} 項執行中 · ${current[rotateIndex].label}`;
    rotateIndex = (rotateIndex + 1) % current.length;
  };

  render();
  if (!rotateTimer) {
    rotateTimer = setInterval(render, 3000);
  }
}

export function initStatusBar(): void {
  registerStatusUpdater(update);
  update();
}
