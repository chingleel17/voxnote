import { getTheme, toggleTheme } from '../utils/theme';
import { getVersion } from '@tauri-apps/api/app';

interface NavItem {
  icon: string;
  label: string;
  route: string;
}

const NAV_ITEMS: NavItem[] = [
  { icon: '🏠', label: '首頁', route: '#home' },
  { icon: '🎙️', label: '錄音', route: '#record' },
  { icon: '🗂️', label: '管理', route: '#manage' },
  { icon: '⚙️', label: '設定', route: '#settings' },
];

let navContainer: HTMLElement | null = null;

function getThemeIcon(theme: 'dark' | 'light'): string {
  return theme === 'dark' ? '☀️' : '🌙';
}

function getThemeLabel(theme: 'dark' | 'light'): string {
  return theme === 'dark' ? '切換淺色系' : '切換暗色系';
}

export function renderNav(container: HTMLElement): void {
  navContainer = container;
  container.innerHTML = '';

  const brand = document.createElement('div');
  brand.className = 'nav-brand';

  const brandLogo = document.createElement('img');
  brandLogo.className = 'nav-brand-logo';
  brandLogo.src = '/logo.png';
  brandLogo.alt = 'VoxNote';

  brand.appendChild(brandLogo);
  container.appendChild(brand);

  const list = document.createElement('ul');
  list.className = 'nav-list';

  for (const item of NAV_ITEMS) {
    const li = document.createElement('li');
    li.className = 'nav-item';

    const a = document.createElement('a');
    a.className = 'nav-link';
    a.href = item.route;
    a.dataset['route'] = item.route;

    const icon = document.createElement('span');
    icon.className = 'nav-icon';
    icon.textContent = item.icon;

    const label = document.createElement('span');
    label.className = 'nav-label';
    label.textContent = item.label;

    a.appendChild(icon);
    a.appendChild(label);
    li.appendChild(a);
    list.appendChild(li);
  }

  container.appendChild(list);

  // Sidebar footer：主題切換 + 版本
  const footer = document.createElement('div');
  footer.className = 'sidebar-footer';

  const themeBtn = document.createElement('button');
  themeBtn.className = 'sidebar-theme-btn';
  themeBtn.setAttribute('aria-label', '切換主題');

  const themeIcon = document.createElement('span');
  themeIcon.className = 'sidebar-theme-icon';

  const themeLabel = document.createElement('span');

  const currentTheme = getTheme();
  themeIcon.textContent = getThemeIcon(currentTheme);
  themeLabel.textContent = getThemeLabel(currentTheme);

  themeBtn.appendChild(themeIcon);
  themeBtn.appendChild(themeLabel);
  themeBtn.addEventListener('click', () => {
    const next = toggleTheme();
    themeIcon.textContent = getThemeIcon(next);
    themeLabel.textContent = getThemeLabel(next);
  });

  const versionEl = document.createElement('div');
  versionEl.className = 'sidebar-version';
  versionEl.textContent = '';

  getVersion().then((v) => {
    versionEl.textContent = `v${v}`;
  }).catch(() => {
    versionEl.textContent = '';
  });

  footer.appendChild(themeBtn);
  footer.appendChild(versionEl);
  container.appendChild(footer);

  const currentHash = window.location.hash || '#home';
  updateNavActive(currentHash);
}

export function updateNavActive(route: string): void {
  if (!navContainer) return;

  // 取得基礎路由（移除 id 部分，如 #meeting/123 → #meeting）
  const baseRoute = route.split('/')[0];

  navContainer.querySelectorAll('.nav-link').forEach((link) => {
    const el = link as HTMLElement;
    const linkRoute = el.dataset['route'] ?? '';
    const isActive = linkRoute === baseRoute || (baseRoute === '#meeting' && linkRoute === '#home');
    el.classList.toggle('active', isActive);
  });
}
