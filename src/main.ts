import { renderNav, updateNavActive } from './components/nav';
import { renderHomePage } from './pages/home';
import { renderManagePage } from './pages/manage';
import { renderMeetingPage } from './pages/meeting';
import { renderRecordPage } from './pages/record';
import { renderSettingsPage } from './pages/settings';
import { renderLiveCaptionPage } from './pages/liveCaption';
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
  switch (route.page) {
    case 'home':
      await renderHomePage(container);
      break;
    case 'meeting':
      if (route.id) {
        await renderMeetingPage(container, route.id);
      } else {
        await renderHomePage(container);
      }
      break;
    case 'record':
      await renderRecordPage(container, route.id);
      break;
    case 'manage':
      await renderManagePage(container);
      break;
    case 'settings':
      await renderSettingsPage(container);
      break;
    case 'live-caption':
      await renderLiveCaptionPage(container);
      break;
    default:
      await renderHomePage(container);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initNotificationFocusTracking();
  void initConfigStore();

  const sidebar = document.getElementById('sidebar');
  const content = document.getElementById('content');
  if (!sidebar || !content) return;

  renderNav(sidebar);
  initStatusBar();

  const initialHash = window.location.hash || '#home';
  if (!window.location.hash) {
    window.location.hash = '#home';
  }

  const initialRoute = parseRoute(initialHash);
  updateNavActive(initialHash);
  renderPage(content, initialRoute);
});

window.addEventListener('hashchange', () => {
  const content = document.getElementById('content');
  if (!content) return;

  const hash = window.location.hash;
  const route = parseRoute(hash);
  updateNavActive(hash);
  renderPage(content, route);
});
