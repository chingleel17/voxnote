import type { SelectGroup, SelectOption } from '../types';

const ICON_SEARCH = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>';
let elementIdSeq = 0;

/** 共用原生下拉：篩選不修改選值，手動輸入與選項更新使用相同契約。 */
export function buildSelectGroup(
  labelText: string,
  options: SelectOption[],
  selected: string,
  onChange: (value: string) => void,
  settings: { filterable?: boolean; allowCustom?: boolean } = {},
): SelectGroup {
  const group = document.createElement('div');
  group.className = 'form-group';
  const label = document.createElement('label');
  label.textContent = labelText;
  const select = document.createElement('select');
  select.className = 'form-control';
  select.id = `shared-select-${++elementIdSeq}`;
  label.htmlFor = select.id;

  const filter = document.createElement('input');
  filter.type = 'search';
  filter.className = 'form-control';
  filter.placeholder = '輸入關鍵字篩選（不會變更已選項目）';
  filter.setAttribute('aria-label', `篩選${labelText}`);
  filter.id = `${select.id}-filter`;
  filter.hidden = true;
  filter.style.marginTop = '8px';

  const custom = document.createElement('input');
  custom.type = 'text';
  custom.className = 'form-control';
  custom.placeholder = '輸入模型 ID';
  custom.setAttribute('aria-label', `手動輸入${labelText}`);
  custom.hidden = true;
  custom.style.marginTop = '8px';
  custom.value = selected;
  const customValue = '__manual_model__';
  let manual = false;

  const renderOptions = (): void => {
    const query = filter.value.trim().toLowerCase();
    const visible = options.filter((option) => !query ||
      option.value.toLowerCase().includes(query) || option.label.toLowerCase().includes(query));
    if (selected && !visible.some((option) => option.value === selected)) {
      visible.unshift(options.find((option) => option.value === selected) ?? { value: selected, label: selected });
    }
    select.replaceChildren();
    if (!selected) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = `請選擇${labelText}`;
      placeholder.disabled = true;
      select.appendChild(placeholder);
    }
    for (const option of visible) {
      const element = document.createElement('option');
      element.value = option.value;
      element.textContent = option.label;
      element.disabled = option.disabled === true;
      select.appendChild(element);
    }
    if (settings.allowCustom) {
      const element = document.createElement('option');
      element.value = customValue;
      element.textContent = '手動輸入模型 ID…';
      select.appendChild(element);
    }
    select.value = manual ? customValue : selected;
  };
  select.addEventListener('change', () => {
    manual = settings.allowCustom === true && select.value === customValue;
    custom.hidden = !manual;
    if (manual) {
      custom.value = selected;
      custom.focus();
      custom.select();
    } else {
      selected = select.value;
      onChange(selected);
    }
  });
  custom.addEventListener('input', () => {
    selected = custom.value;
    onChange(selected);
  });
  filter.addEventListener('input', renderOptions);
  group.appendChild(label);
  if (settings.filterable || settings.allowCustom) {
    const row = document.createElement('div');
    row.className = 'input-row';
    row.appendChild(select);
    if (settings.filterable) {
      const filterButton = document.createElement('button');
      filterButton.type = 'button';
      filterButton.className = 'btn btn-secondary btn-sm settings-icon-btn';
      filterButton.innerHTML = ICON_SEARCH;
      filterButton.title = '篩選選項';
      filterButton.setAttribute('aria-label', `篩選${labelText}`);
      filterButton.setAttribute('aria-controls', filter.id);
      filterButton.setAttribute('aria-expanded', 'false');
      filterButton.addEventListener('click', () => {
        filter.hidden = !filter.hidden;
        filterButton.setAttribute('aria-expanded', String(!filter.hidden));
        filterButton.setAttribute('aria-pressed', String(!filter.hidden));
        filterButton.setAttribute('aria-label', filter.hidden ? `篩選${labelText}` : `取消篩選${labelText}`);
        if (filter.hidden) {
          filter.value = '';
          renderOptions();
        } else {
          filter.focus();
        }
      });
      row.appendChild(filterButton);
    }
    group.appendChild(row);
    if (settings.filterable) group.appendChild(filter);
    if (settings.allowCustom) group.appendChild(custom);
  } else {
    group.appendChild(select);
  }
  renderOptions();
  return Object.assign(group, {
    select,
    setOptions(nextOptions: SelectOption[]): void {
      options = nextOptions;
      renderOptions();
    },
    setValue(value: string): void {
      selected = value;
      custom.value = value;
      renderOptions();
    },
  });
}
