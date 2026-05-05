import type { SavedParticipant, MeetingTemplate, Tag, Category } from '../types';
import { getSavedParticipants, deleteSavedParticipant, updateSavedParticipant, upsertSavedParticipant } from '../api/participants';
import { getTemplates, deleteTemplate, updateTemplate } from '../api/templates';
import { getTags, createTag, deleteTag } from '../api/tags';
import { getCategories, createCategory, deleteCategory } from '../api/meetings';
import { openModal } from '../components/modal';
import { showToast } from '../components/toast';

type TabKey = 'participants' | 'templates' | 'tags' | 'categories';

const TAB_LABELS: Record<TabKey, string> = {
  participants: '常用參與者',
  templates: '會議範本',
  tags: '標籤',
  categories: '分類',
};

const TAG_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'];

export async function renderManagePage(container: HTMLElement): Promise<void> {
  container.innerHTML = '<div class="loading">載入中...</div>';

  let savedParticipants: SavedParticipant[] = [];
  let templates: MeetingTemplate[] = [];
  let tags: Tag[] = [];
  let categories: Category[] = [];

  try {
    [savedParticipants, templates, tags, categories] = await Promise.all([
      getSavedParticipants(),
      getTemplates(),
      getTags(),
      getCategories(),
    ]);
  } catch (err) {
    container.innerHTML = `<div class="error-state">載入失敗：${String(err)}</div>`;
    return;
  }

  let activeTab: TabKey = 'participants';

  function build(): void {
    container.innerHTML = '';

    // 標題
    const header = document.createElement('div');
    header.className = 'page-toolbar';
    const title = document.createElement('h2');
    title.className = 'page-title';
    title.textContent = '管理';
    header.appendChild(title);
    container.appendChild(header);

    // Tab 列
    const tabs = document.createElement('div');
    tabs.className = 'manage-tabs';
    for (const key of Object.keys(TAB_LABELS) as TabKey[]) {
      const btn = document.createElement('button');
      btn.className = `manage-tab-btn${activeTab === key ? ' active' : ''}`;
      btn.textContent = TAB_LABELS[key];
      btn.addEventListener('click', () => { activeTab = key; build(); });
      tabs.appendChild(btn);
    }
    container.appendChild(tabs);

    // 內容區
    const content = document.createElement('div');
    content.className = 'manage-content';

    switch (activeTab) {
      case 'participants':
        content.appendChild(buildParticipantsTab());
        break;
      case 'templates':
        content.appendChild(buildTemplatesTab());
        break;
      case 'tags':
        content.appendChild(buildTagsTab());
        break;
      case 'categories':
        content.appendChild(buildCategoriesTab());
        break;
    }

    container.appendChild(content);
  }

  // ─────────────── 常用參與者 ───────────────
  function buildParticipantsTab(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'manage-section';

    // 新增列
    const addRow = document.createElement('div');
    addRow.className = 'manage-add-row';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'form-control';
    nameInput.placeholder = '輸入姓名後按 Enter 或點新增';
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-primary btn-sm';
    addBtn.textContent = '新增';
    const doAdd = async () => {
      const name = nameInput.value.trim();
      if (!name) return;
      try {
        const p = await upsertSavedParticipant(name);
        const existing = savedParticipants.findIndex((x) => x.id === p.id);
        if (existing >= 0) savedParticipants[existing] = p;
        else savedParticipants.unshift(p);
        nameInput.value = '';
        build();
      } catch (err) {
        showToast(`新增失敗：${String(err)}`, 'error');
      }
    };
    addBtn.addEventListener('click', doAdd);
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
    addRow.appendChild(nameInput);
    addRow.appendChild(addBtn);
    wrap.appendChild(addRow);

    if (savedParticipants.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'manage-empty';
      empty.textContent = '尚無常用參與者';
      wrap.appendChild(empty);
      return wrap;
    }

    // 排序：使用次數高 → 低
    const sorted = [...savedParticipants].sort((a, b) => b.usage_count - a.usage_count);
    const list = document.createElement('div');
    list.className = 'manage-list';
    for (const p of sorted) {
      const row = document.createElement('div');
      row.className = 'manage-list-row';

      const avatar = document.createElement('span');
      avatar.className = 'manage-avatar';
      avatar.textContent = p.name.charAt(0).toUpperCase();

      const info = document.createElement('div');
      info.className = 'manage-row-info';
      const nameEl = document.createElement('span');
      nameEl.className = 'manage-row-name';
      nameEl.textContent = p.name;
      const meta = document.createElement('span');
      meta.className = 'manage-row-meta';
      meta.textContent = `使用 ${p.usage_count} 次`;
      info.appendChild(nameEl);
      info.appendChild(meta);

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-danger btn-sm';
      delBtn.textContent = '刪除';
      delBtn.addEventListener('click', async () => {
        try {
          await deleteSavedParticipant(p.id);
          savedParticipants = savedParticipants.filter((x) => x.id !== p.id);
          build();
        } catch (err) {
          showToast(`刪除失敗：${String(err)}`, 'error');
        }
      });

      // 重新命名：點「重新命名」後切換成 inline input
      const renameBtn = document.createElement('button');
      renameBtn.className = 'btn btn-secondary btn-sm';
      renameBtn.textContent = '重新命名';
      renameBtn.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'form-control manage-rename-input';
        input.value = p.name;
        nameEl.replaceWith(input);
        renameBtn.style.display = 'none';
        input.focus();
        input.select();

        const doRename = async () => {
          const newName = input.value.trim();
          if (!newName || newName === p.name) { build(); return; }
          try {
            const updated = await updateSavedParticipant(p.id, newName);
            const idx = savedParticipants.findIndex((x) => x.id === p.id);
            if (idx >= 0) savedParticipants[idx] = updated;
            build();
          } catch (err) {
            showToast(`重新命名失敗：${String(err)}`, 'error');
            build();
          }
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void doRename(); if (e.key === 'Escape') build(); });
        input.addEventListener('blur', () => void doRename());
      });

      row.appendChild(avatar);
      row.appendChild(info);
      row.appendChild(renameBtn);
      row.appendChild(delBtn);
      list.appendChild(row);
    }
    wrap.appendChild(list);
    return wrap;
  }

  // ─────────────── 會議範本 ───────────────
  function buildTemplatesTab(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'manage-section';

    if (templates.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'manage-empty';
      empty.textContent = '尚無會議範本。可在新增會議時勾選「儲存為範本」，或在會議詳情頁點擊「儲存為範本」。';
      wrap.appendChild(empty);
      return wrap;
    }

    const list = document.createElement('div');
    list.className = 'manage-list';
    for (const tpl of templates) {
      const row = document.createElement('div');
      row.className = 'manage-list-row manage-template-row';

      const icon = document.createElement('span');
      icon.className = 'manage-template-icon';
      icon.textContent = '📋';

      const info = document.createElement('div');
      info.className = 'manage-row-info';
      const nameEl = document.createElement('span');
      nameEl.className = 'manage-row-name';
      nameEl.textContent = tpl.name;
      const meta = document.createElement('span');
      meta.className = 'manage-row-meta';
      const parts: string[] = [];
      if (tpl.title !== tpl.name) parts.push(`標題：${tpl.title}`);
      if (tpl.participants.length > 0) parts.push(`參與者：${tpl.participants.join('、')}`);
      meta.textContent = parts.length > 0 ? parts.join('　') : '無額外資訊';
      info.appendChild(nameEl);
      info.appendChild(meta);

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-danger btn-sm';
      delBtn.textContent = '刪除';
      delBtn.addEventListener('click', async () => {
        if (!confirm(`確定要刪除範本「${tpl.name}」嗎？`)) return;
        try {
          await deleteTemplate(tpl.id);
          templates = templates.filter((x) => x.id !== tpl.id);
          build();
        } catch (err) {
          showToast(`刪除失敗：${String(err)}`, 'error');
        }
      });

      // 編輯按鈕：開啟 modal 修改範本
      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-secondary btn-sm';
      editBtn.textContent = '編輯';
      editBtn.addEventListener('click', () => openTemplateEditModal(tpl));

      row.appendChild(icon);
      row.appendChild(info);
      row.appendChild(editBtn);
      row.appendChild(delBtn);
      list.appendChild(row);
    }
    wrap.appendChild(list);
    return wrap;
  }

  // ─────────────── 模板編輯 Modal ───────────────
  function openTemplateEditModal(tpl: MeetingTemplate): void {
    const form = document.createElement('div');
    form.className = 'form-group-list';

    // 範本名稱
    const nameGroup = document.createElement('div');
    nameGroup.className = 'form-group';
    const nameLabel = document.createElement('label');
    nameLabel.textContent = '範本名稱';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'form-control';
    nameInput.value = tpl.name;
    nameGroup.appendChild(nameLabel);
    nameGroup.appendChild(nameInput);
    form.appendChild(nameGroup);

    // 預設會議標題
    const titleGroup = document.createElement('div');
    titleGroup.className = 'form-group';
    const titleLabel = document.createElement('label');
    titleLabel.textContent = '預設會議標題';
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'form-control';
    titleInput.value = tpl.title;
    titleGroup.appendChild(titleLabel);
    titleGroup.appendChild(titleInput);
    form.appendChild(titleGroup);

    // 預設參與者（逗號/頓號分隔）
    const partGroup = document.createElement('div');
    partGroup.className = 'form-group';
    const partLabel = document.createElement('label');
    partLabel.textContent = '預設參與者（以逗號或頓號分隔）';
    const partInput = document.createElement('input');
    partInput.type = 'text';
    partInput.className = 'form-control';
    partInput.value = tpl.participants.join('、');
    partInput.placeholder = '例如：王小明、李大華';
    partGroup.appendChild(partLabel);
    partGroup.appendChild(partInput);
    form.appendChild(partGroup);

    openModal({
      title: '編輯範本',
      content: form,
      confirmText: '儲存',
      cancelText: '取消',
      onConfirm: async () => {
        const newName = nameInput.value.trim();
        const newTitle = titleInput.value.trim();
        if (!newName || !newTitle) {
          showToast('範本名稱與會議標題不可為空', 'error');
          return false;
        }
        const newParticipants = partInput.value
          .split(/[,，、]/)
          .map((s) => s.trim())
          .filter(Boolean);
        try {
          const updated = await updateTemplate(tpl.id, {
            name: newName,
            title: newTitle,
            participants: newParticipants,
          });
          const idx = templates.findIndex((x) => x.id === tpl.id);
          if (idx >= 0) templates[idx] = updated;
          build();
        } catch (err) {
          showToast(`儲存失敗：${String(err)}`, 'error');
          return false;
        }
      },
    });
    nameInput.focus();
  }

  // ─────────────── 標籤 ───────────────
  function buildTagsTab(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'manage-section';

    // 新增列
    const addSection = document.createElement('div');
    addSection.className = 'manage-tag-add';
    const addTitle = document.createElement('p');
    addTitle.className = 'manage-subsection-title';
    addTitle.textContent = '新增標籤';
    addSection.appendChild(addTitle);

    const addRow = document.createElement('div');
    addRow.className = 'manage-add-row';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'form-control';
    nameInput.placeholder = '標籤名稱';

    let selectedColor = TAG_COLORS[0];
    const colorPicker = document.createElement('div');
    colorPicker.className = 'tag-color-picker';
    for (const c of TAG_COLORS) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = `color-dot${c === selectedColor ? ' selected' : ''}`;
      dot.style.backgroundColor = c;
      dot.title = c;
      dot.addEventListener('click', () => {
        selectedColor = c;
        colorPicker.querySelectorAll<HTMLElement>('.color-dot').forEach((d) => d.classList.remove('selected'));
        dot.classList.add('selected');
      });
      colorPicker.appendChild(dot);
    }

    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-primary btn-sm';
    addBtn.textContent = '新增';
    addBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) return;
      try {
        const newTag = await createTag(name, selectedColor);
        tags.push(newTag);
        nameInput.value = '';
        build();
      } catch (err) {
        showToast(`新增失敗：${String(err)}`, 'error');
      }
    });

    addRow.appendChild(nameInput);
    addRow.appendChild(addBtn);
    addSection.appendChild(addRow);
    addSection.appendChild(colorPicker);
    wrap.appendChild(addSection);

    // 現有標籤列表
    if (tags.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'manage-empty';
      empty.textContent = '尚無標籤';
      wrap.appendChild(empty);
      return wrap;
    }

    const listTitle = document.createElement('p');
    listTitle.className = 'manage-subsection-title';
    listTitle.style.marginTop = '20px';
    listTitle.textContent = '現有標籤';
    wrap.appendChild(listTitle);

    const list = document.createElement('div');
    list.className = 'manage-list';
    for (const tag of tags) {
      const row = document.createElement('div');
      row.className = 'manage-list-row';

      const swatch = document.createElement('span');
      swatch.className = 'manage-tag-swatch';
      swatch.style.backgroundColor = tag.color;

      const info = document.createElement('div');
      info.className = 'manage-row-info';
      const nameEl = document.createElement('span');
      nameEl.className = 'manage-row-name';
      nameEl.textContent = tag.name;
      const meta = document.createElement('span');
      meta.className = 'manage-row-meta';
      meta.textContent = tag.color;
      info.appendChild(nameEl);
      info.appendChild(meta);

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-danger btn-sm';
      delBtn.textContent = '刪除';
      delBtn.addEventListener('click', async () => {
        if (!confirm(`確定要刪除標籤「${tag.name}」嗎？相關會議的標籤指派也會一併移除。`)) return;
        try {
          await deleteTag(tag.id);
          tags = tags.filter((x) => x.id !== tag.id);
          build();
        } catch (err) {
          showToast(`刪除失敗：${String(err)}`, 'error');
        }
      });

      row.appendChild(swatch);
      row.appendChild(info);
      row.appendChild(delBtn);
      list.appendChild(row);
    }
    wrap.appendChild(list);
    return wrap;
  }

  // ─────────────── 分類 ───────────────
  function buildCategoriesTab(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'manage-section';

    // 新增列
    const addRow = document.createElement('div');
    addRow.className = 'manage-add-row';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'form-control';
    nameInput.placeholder = '輸入分類名稱後按 Enter 或點新增';
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-primary btn-sm';
    addBtn.textContent = '新增';
    const doAdd = async () => {
      const name = nameInput.value.trim();
      if (!name) return;
      try {
        const cat = await createCategory(name);
        categories.unshift(cat);
        nameInput.value = '';
        build();
      } catch (err) {
        showToast(`新增失敗：${String(err)}`, 'error');
      }
    };
    addBtn.addEventListener('click', doAdd);
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
    addRow.appendChild(nameInput);
    addRow.appendChild(addBtn);
    wrap.appendChild(addRow);

    if (categories.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'manage-empty';
      empty.textContent = '尚無分類';
      wrap.appendChild(empty);
      return wrap;
    }

    const list = document.createElement('div');
    list.className = 'manage-list';
    for (const cat of categories) {
      const row = document.createElement('div');
      row.className = 'manage-list-row';

      const icon = document.createElement('span');
      icon.className = 'manage-category-icon';
      icon.textContent = '📁';

      const info = document.createElement('div');
      info.className = 'manage-row-info';
      const nameEl = document.createElement('span');
      nameEl.className = 'manage-row-name';
      nameEl.textContent = cat.name;
      info.appendChild(nameEl);

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-danger btn-sm';
      delBtn.textContent = '刪除';
      delBtn.addEventListener('click', async () => {
        if (!confirm(`確定要刪除分類「${cat.name}」嗎？相關會議將變為無分類。`)) return;
        try {
          await deleteCategory(cat.id);
          categories = categories.filter((x) => x.id !== cat.id);
          build();
        } catch (err) {
          showToast(`刪除失敗：${String(err)}`, 'error');
        }
      });

      row.appendChild(icon);
      row.appendChild(info);
      row.appendChild(delBtn);
      list.appendChild(row);
    }
    wrap.appendChild(list);
    return wrap;
  }

  build();
}
