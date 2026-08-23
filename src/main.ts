import { renderNav, updateNavActive } from './components/nav';
import { initStatusBar } from './components/statusBar';
import { initConfigStore } from './utils/configStore';
import { initNotificationFocusTracking } from './utils/notifications';
import { initTheme } from './utils/theme';

interface ParsedRoute {
  page: string;
  id?: string;
}

function parseRoute(hash: string): ParsedRoute {
  const clean = hash.startsWith('#') ? hash.slice(1) : hash;
  const parts = clean.split('/');
  return { page: parts[0] || 'home', id: parts[1] };
}

async function renderPage(container: HTMLElement, route: ParsedRoute): Promise<void> {
  container.innerHTML = '<div class="loading">載入中...</div>';

  try {
    switch (route.page) {
      case 'home': {
        const { renderHomePage } = await import('./pages/home');
        await renderHomePage(container);
        break;
      }
      case 'meeting': {
        if (route.id) {
          const { renderMeetingPage } = await import('./pages/meeting');
          await renderMeetingPage(container, route.id);
        } else {
          const { renderHomePage } = await import('./pages/home');
          await renderHomePage(container);
        }
        break;
      }
      case 'record': {
        const { renderRecordPage } = await import('./pages/record');
        await renderRecordPage(container, route.id);
        break;
      }
      case 'manage': {
        const { renderManagePage } = await import('./pages/manage');
        await renderManagePage(container);
        break;
      }
      case 'settings': {
        const { renderSettingsPage } = await import('./pages/settings');
        await renderSettingsPage(container);
        break;
      }
      case 'live-caption': {
        const { renderLiveCaptionPage } = await import('./pages/liveCaption');
        await renderLiveCaptionPage(container);
        break;
      }
      default: {
        const { renderHomePage } = await import('./pages/home');
        await renderHomePage(container);
      }
    }
  } catch (error) {
    console.error('頁面載入失敗', error);
    container.innerHTML = `<div class="error-state">頁面載入失敗：${String(error)}</div>`;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initNotificationFocusTracking();
  void initConfigStore().catch((error) => {
    console.error('設定載入失敗', error);
  });

  const sidebar = document.getElementById('sidebar');
  const content = document.getElementById('content');
  if (!sidebar || !content) return;

  renderNav(sidebar);
  initStatusBar();

  const initialHash = window.location.hash || '#home';
  if (!window.location.hash) {
    window.history.replaceState(null, '', '#home');
  }

  const initialRoute = parseRoute(initialHash);
  updateNavActive(initialHash);
  void renderPage(content, initialRoute);
});

window.addEventListener('hashchange', () => {
  const content = document.getElementById('content');
  if (!content) return;

  const hash = window.location.hash;
  const route = parseRoute(hash);
  updateNavActive(hash);
  void renderPage(content, route);
});
