import { renderNav, updateNavActive } from './components/nav';
import { renderHomePage } from './pages/home';
import { renderMeetingPage } from './pages/meeting';
import { renderRecordPage } from './pages/record';
import { renderSettingsPage } from './pages/settings';
import { initStatusBar } from './components/statusBar';

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
    case 'settings':
      await renderSettingsPage(container);
      break;
    default:
      await renderHomePage(container);
  }
}

window.addEventListener('DOMContentLoaded', () => {
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
