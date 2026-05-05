interface NavItem {
  icon: string;
  label: string;
  route: string;
}

const NAV_ITEMS: NavItem[] = [
  { icon: '🏠', label: '首頁', route: '#home' },
  { icon: '🎙️', label: '錄音', route: '#record' },
  { icon: '⚙️', label: '設定', route: '#settings' },
];

let navContainer: HTMLElement | null = null;

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
