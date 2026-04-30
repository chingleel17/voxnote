import type { SavedParticipant } from '../types';

export interface ParticipantEditorResult {
  el: HTMLElement;
  getParticipants: () => string[];
}

/**
 * 建立列表式參與者編輯器
 * @param initialParticipants 初始參與者清單
 * @param savedParticipants 全域常用參與者清單（用於下拉選取）
 */
export function buildParticipantEditor(
  initialParticipants: string[],
  savedParticipants: SavedParticipant[]
): ParticipantEditorResult {
  const wrapper = document.createElement('div');
  wrapper.className = 'participant-editor';

  // 標題列
  const header = document.createElement('div');
  header.className = 'participant-editor-header';
  const label = document.createElement('label');
  label.textContent = '參與者';
  header.appendChild(label);
  wrapper.appendChild(header);

  // 從常用清單選取的下拉列
  if (savedParticipants.length > 0) {
    const selectRow = document.createElement('div');
    selectRow.className = 'participant-select-row';

    const select = document.createElement('select');
    select.className = 'form-control participant-saved-select';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '── 從常用清單選取 ──';
    select.appendChild(placeholder);

    for (const sp of savedParticipants) {
      const opt = document.createElement('option');
      opt.value = sp.name;
      opt.textContent = sp.name;
      select.appendChild(opt);
    }

    const addFromSavedBtn = document.createElement('button');
    addFromSavedBtn.type = 'button';
    addFromSavedBtn.className = 'btn btn-secondary btn-sm';
    addFromSavedBtn.textContent = '加入';
    addFromSavedBtn.addEventListener('click', () => {
      const name = select.value.trim();
      if (!name) return;
      addParticipantRow(name);
      select.value = '';
    });

    selectRow.appendChild(select);
    selectRow.appendChild(addFromSavedBtn);
    wrapper.appendChild(selectRow);
  }

  // 列表容器
  const list = document.createElement('div');
  list.className = 'participant-list';
  wrapper.appendChild(list);

  // 新增空白行的按鈕
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn btn-ghost btn-sm participant-add-btn';
  addBtn.innerHTML = '＋ 新增參與者';
  addBtn.addEventListener('click', () => addParticipantRow(''));
  wrapper.appendChild(addBtn);

  function addParticipantRow(name: string): void {
    const row = document.createElement('div');
    row.className = 'participant-list-item';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-control participant-input';
    input.value = name;
    input.placeholder = '輸入姓名';

    // 按 Enter 自動新增下一行
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addParticipantRow('');
        // focus 新增的最後一個 input
        const inputs = list.querySelectorAll<HTMLInputElement>('.participant-input');
        inputs[inputs.length - 1]?.focus();
      }
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn-icon participant-delete-btn';
    deleteBtn.title = '刪除';
    deleteBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
    deleteBtn.addEventListener('click', () => {
      row.remove();
    });

    row.appendChild(input);
    row.appendChild(deleteBtn);
    list.appendChild(row);

    if (!name) {
      input.focus();
    }
  }

  // 初始化已有的參與者
  for (const p of initialParticipants) {
    addParticipantRow(p);
  }

  const getParticipants = (): string[] => {
    return Array.from(list.querySelectorAll<HTMLInputElement>('.participant-input'))
      .map((inp) => inp.value.trim())
      .filter((v) => v.length > 0);
  };

  return { el: wrapper, getParticipants };
}
