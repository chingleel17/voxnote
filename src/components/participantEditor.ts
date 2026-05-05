import type { SavedParticipant } from '../types';
import {
  deleteSavedParticipant,
  updateSavedParticipant,
  upsertSavedParticipant,
} from '../api/participants';
import { openModal } from './modal';
import { showToast } from './toast';

export interface ParticipantEditorOptions {
  allowManageSaved?: boolean;
  onSavedParticipantsChanged?: (participants: SavedParticipant[]) => void;
}

export interface ParticipantEditorResult {
  el: HTMLElement;
  getParticipants: () => string[];
}

/**
 * 建立列表式參與者編輯器
 * @param initialParticipants 初始參與者清單
 * @param savedParticipants 全域常用參與者清單（用於下拉選取）
 * @param options 是否允許在下拉選單旁管理常用參與者
 */
export function buildParticipantEditor(
  initialParticipants: string[],
  savedParticipants: SavedParticipant[],
  options: ParticipantEditorOptions = {}
): ParticipantEditorResult {
  const wrapper = document.createElement('div');
  wrapper.className = 'participant-editor';
  let saved = [...savedParticipants];

  // 標題列
  const header = document.createElement('div');
  header.className = 'participant-editor-header';
  const label = document.createElement('label');
  label.textContent = '參與者';
  header.appendChild(label);
  wrapper.appendChild(header);

  // 從常用清單選取的下拉列
  if (saved.length > 0 || options.allowManageSaved) {
    const selectRow = document.createElement('div');
    selectRow.className = 'participant-select-row';

    const select = document.createElement('select');
    select.className = 'form-control participant-saved-select';

    const addFromSavedBtn = document.createElement('button');
    addFromSavedBtn.type = 'button';
    addFromSavedBtn.className = 'btn btn-secondary btn-sm';
    addFromSavedBtn.textContent = '加入';
    addFromSavedBtn.addEventListener('click', () => {
      const selected = getSelectedSavedParticipant();
      if (!selected) return;
      addParticipantRow(selected.name);
      select.value = '';
      updateManageButtons();
    });

    const manageActions = document.createElement('div');
    manageActions.className = 'participant-select-actions';

    const addSavedBtn = document.createElement('button');
    addSavedBtn.type = 'button';
    addSavedBtn.className = 'btn btn-ghost btn-sm';
    addSavedBtn.textContent = '新增常用';
    addSavedBtn.addEventListener('click', () => openSavedParticipantNameModal({
      title: '新增常用參與者',
      initialName: '',
      onSave: async (name) => {
        const created = await upsertSavedParticipant(name);
        upsertLocalSaved(created);
        select.value = created.id;
      },
    }));

    const editSavedBtn = document.createElement('button');
    editSavedBtn.type = 'button';
    editSavedBtn.className = 'btn btn-ghost btn-sm';
    editSavedBtn.textContent = '編輯';
    editSavedBtn.addEventListener('click', () => {
      const selected = getSelectedSavedParticipant();
      if (!selected) return;
      openSavedParticipantNameModal({
        title: '編輯常用參與者',
        initialName: selected.name,
        onSave: async (name) => {
          const updated = await updateSavedParticipant(selected.id, name);
          upsertLocalSaved(updated);
          select.value = updated.id;
        },
      });
    });

    const deleteSavedBtn = document.createElement('button');
    deleteSavedBtn.type = 'button';
    deleteSavedBtn.className = 'btn btn-ghost btn-sm text-danger';
    deleteSavedBtn.textContent = '刪除';
    deleteSavedBtn.addEventListener('click', async () => {
      const selected = getSelectedSavedParticipant();
      if (!selected) return;
      if (!confirm(`確定要刪除常用參與者「${selected.name}」嗎？`)) return;
      try {
        await deleteSavedParticipant(selected.id);
        saved = saved.filter((p) => p.id !== selected.id);
        emitSavedChanged();
        renderOptions();
        showToast('常用參與者已刪除', 'success');
      } catch (err) {
        showToast(`刪除失敗：${String(err)}`, 'error');
      }
    });

    if (options.allowManageSaved) {
      manageActions.appendChild(addSavedBtn);
      manageActions.appendChild(editSavedBtn);
      manageActions.appendChild(deleteSavedBtn);
    }

    select.addEventListener('change', updateManageButtons);
    selectRow.appendChild(select);
    selectRow.appendChild(addFromSavedBtn);
    if (options.allowManageSaved) {
      selectRow.appendChild(manageActions);
    }
    wrapper.appendChild(selectRow);
    renderOptions();

    function renderOptions(): void {
      const selectedId = select.value;
      select.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = saved.length > 0 ? '── 從常用清單選取 ──' : '── 尚無常用參與者 ──';
      select.appendChild(placeholder);

      const sorted = [...saved].sort((a, b) => b.usage_count - a.usage_count || a.name.localeCompare(b.name));
      for (const sp of sorted) {
        const opt = document.createElement('option');
        opt.value = sp.id;
        opt.textContent = sp.name;
        select.appendChild(opt);
      }

      if (selectedId && saved.some((sp) => sp.id === selectedId)) {
        select.value = selectedId;
      }
      updateManageButtons();
    }

    function getSelectedSavedParticipant(): SavedParticipant | undefined {
      return saved.find((sp) => sp.id === select.value);
    }

    function updateManageButtons(): void {
      const hasSelected = Boolean(getSelectedSavedParticipant());
      addFromSavedBtn.disabled = !hasSelected;
      editSavedBtn.disabled = !hasSelected;
      deleteSavedBtn.disabled = !hasSelected;
    }

    function upsertLocalSaved(participant: SavedParticipant): void {
      const idx = saved.findIndex((p) => p.id === participant.id);
      if (idx >= 0) saved[idx] = participant;
      else saved.unshift(participant);
      emitSavedChanged();
      renderOptions();
      showToast('常用參與者已更新', 'success');
    }

    function emitSavedChanged(): void {
      options.onSavedParticipantsChanged?.([...saved]);
    }
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

  function openSavedParticipantNameModal(args: {
    title: string;
    initialName: string;
    onSave: (name: string) => Promise<void>;
  }): void {
    const form = document.createElement('div');
    form.className = 'form-group-list';

    const group = document.createElement('div');
    group.className = 'form-group';
    const inputLabel = document.createElement('label');
    inputLabel.textContent = '參與者名稱';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-control';
    input.value = args.initialName;
    input.placeholder = '請輸入姓名';
    group.appendChild(inputLabel);
    group.appendChild(input);
    form.appendChild(group);

    openModal({
      title: args.title,
      content: form,
      confirmText: '儲存',
      cancelText: '取消',
      onConfirm: async () => {
        const name = input.value.trim();
        if (!name) {
          input.focus();
          return false;
        }
        try {
          await args.onSave(name);
        } catch (err) {
          showToast(`儲存失敗：${String(err)}`, 'error');
          return false;
        }
      },
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
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
