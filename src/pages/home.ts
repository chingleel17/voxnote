import type { MeetingWithDetails, Category, CreateMeetingRequest, SavedParticipant, MeetingTemplate, CreateTemplateRequest, Tag } from '../types';
import { getMeetings, getCategories, createMeeting, deleteMeeting } from '../api/meetings';
import { getSavedParticipants, upsertSavedParticipant } from '../api/participants';
import { getTemplates, createTemplate, deleteTemplate, updateTemplate } from '../api/templates';
import { getTags, createTag, deleteTag } from '../api/tags';
import { openModal } from '../components/modal';
import { showToast } from '../components/toast';
import { buildParticipantEditor } from '../components/participantEditor';

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function buildCreateMeetingForm(
  categories: Category[],
  savedParticipants: SavedParticipant[],
  templates: MeetingTemplate[],
  onSavedParticipantsChanged?: (participants: SavedParticipant[]) => void,
  onTemplatesChanged?: (templates: MeetingTemplate[]) => void
): {
  el: HTMLElement;
  getData: () => CreateMeetingRequest | null;
  getSaveAsTemplate: () => { save: boolean; name: string };
} {
  const form = document.createElement('div');
  form.className = 'form-group-list';
  let localTemplates = [...templates];

  // 套用範本下拉
  if (localTemplates.length > 0) {
    const tplGroup = document.createElement('div');
    tplGroup.className = 'form-group';
    const tplLabel = document.createElement('label');
    tplLabel.textContent = '套用範本（可選）';
    const tplRow = document.createElement('div');
    tplRow.className = 'template-select-row';
    const tplSelect = document.createElement('select');
    tplSelect.className = 'form-control';

    // 選擇後自動套用
    tplSelect.addEventListener('change', () => {
      const tpl = getSelectedTemplate();
      if (!tpl) return;
      titleInput.value = tpl.title;
      catSelect.value = tpl.category_id ?? '';
      // 重建參與者列表
      partEditorContainer.innerHTML = '';
      const newEditor = buildParticipantEditor(tpl.participants, savedParticipants, {
        allowManageSaved: true,
        onSavedParticipantsChanged,
      });
      partEditorContainer.appendChild(newEditor.el);
      getParticipantsRef = newEditor.getParticipants;
      updateTemplateActionButtons();
    });

    const editTplBtn = document.createElement('button');
    editTplBtn.type = 'button';
    editTplBtn.className = 'btn btn-secondary btn-sm';
    editTplBtn.textContent = '編輯';
    editTplBtn.addEventListener('click', () => {
      const tpl = getSelectedTemplate();
      if (!tpl) return;
      openTemplateEditModal(tpl);
    });

    const deleteTplBtn = document.createElement('button');
    deleteTplBtn.type = 'button';
    deleteTplBtn.className = 'btn btn-danger btn-sm';
    deleteTplBtn.textContent = '刪除';
    deleteTplBtn.addEventListener('click', async () => {
      const tpl = getSelectedTemplate();
      if (!tpl) return;
      if (!confirm(`確定要刪除範本「${tpl.name}」嗎？`)) return;
      try {
        await deleteTemplate(tpl.id);
        localTemplates = localTemplates.filter((t) => t.id !== tpl.id);
        onTemplatesChanged?.([...localTemplates]);
        renderTemplateOptions();
        showToast('範本已刪除', 'success');
      } catch (err) {
        showToast(`刪除失敗：${String(err)}`, 'error');
      }
    });

    tplGroup.appendChild(tplLabel);
    tplRow.appendChild(tplSelect);
    tplRow.appendChild(editTplBtn);
    tplRow.appendChild(deleteTplBtn);
    tplGroup.appendChild(tplRow);
    form.appendChild(tplGroup);
    renderTemplateOptions();

    function renderTemplateOptions(selectedId = tplSelect.value): void {
      tplSelect.innerHTML = '';
      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = '── 不套用 ──';
      tplSelect.appendChild(emptyOpt);
      for (const tpl of localTemplates) {
        const opt = document.createElement('option');
        opt.value = tpl.id;
        opt.textContent = tpl.name;
        tplSelect.appendChild(opt);
      }
      if (selectedId && localTemplates.some((tpl) => tpl.id === selectedId)) {
        tplSelect.value = selectedId;
      }
      updateTemplateActionButtons();
    }

    function getSelectedTemplate(): MeetingTemplate | undefined {
      return localTemplates.find((tpl) => tpl.id === tplSelect.value);
    }

    function updateTemplateActionButtons(): void {
      const hasSelected = Boolean(getSelectedTemplate());
      editTplBtn.disabled = !hasSelected;
      deleteTplBtn.disabled = !hasSelected;
    }

    function openTemplateEditModal(tpl: MeetingTemplate): void {
      const editForm = document.createElement('div');
      editForm.className = 'form-group-list';

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
      editForm.appendChild(nameGroup);

      const titleGroup = document.createElement('div');
      titleGroup.className = 'form-group';
      const titleLabel = document.createElement('label');
      titleLabel.textContent = '預設會議標題';
      const templateTitleInput = document.createElement('input');
      templateTitleInput.type = 'text';
      templateTitleInput.className = 'form-control';
      templateTitleInput.value = tpl.title;
      titleGroup.appendChild(titleLabel);
      titleGroup.appendChild(templateTitleInput);
      editForm.appendChild(titleGroup);

      const participantGroup = document.createElement('div');
      participantGroup.className = 'form-group';
      const participantLabel = document.createElement('label');
      participantLabel.textContent = '預設參與者（以逗號或頓號分隔）';
      const participantInput = document.createElement('input');
      participantInput.type = 'text';
      participantInput.className = 'form-control';
      participantInput.value = tpl.participants.join('、');
      participantGroup.appendChild(participantLabel);
      participantGroup.appendChild(participantInput);
      editForm.appendChild(participantGroup);

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay modal-visible';
      overlay.style.zIndex = '1100';

      const modal = document.createElement('div');
      modal.className = 'modal';

      const header = document.createElement('div');
      header.className = 'modal-header';
      const modalTitle = document.createElement('h3');
      modalTitle.className = 'modal-title';
      modalTitle.textContent = '編輯會議範本';
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'modal-close';
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', () => overlay.remove());
      header.appendChild(modalTitle);
      header.appendChild(closeBtn);

      const body = document.createElement('div');
      body.className = 'modal-body';
      body.appendChild(editForm);

      const footer = document.createElement('div');
      footer.className = 'modal-footer';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn btn-secondary';
      cancelBtn.textContent = '取消';
      cancelBtn.addEventListener('click', () => overlay.remove());
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn btn-primary';
      saveBtn.textContent = '儲存';
      saveBtn.addEventListener('click', async () => {
          const name = nameInput.value.trim();
          const templateTitle = templateTitleInput.value.trim();
          if (!name || !templateTitle) {
            showToast('範本名稱與會議標題不可為空', 'error');
            return;
          }
          const participants = participantInput.value
            .split(/[,，、]/)
            .map((p) => p.trim())
            .filter(Boolean);
          saveBtn.disabled = true;
          try {
            const updated = await updateTemplate(tpl.id, {
              name,
              title: templateTitle,
              participants,
            });
            const idx = localTemplates.findIndex((item) => item.id === tpl.id);
            if (idx >= 0) localTemplates[idx] = updated;
            onTemplatesChanged?.([...localTemplates]);
            renderTemplateOptions(updated.id);
            showToast('範本已更新', 'success');
            overlay.remove();
          } catch (err) {
            showToast(`儲存失敗：${String(err)}`, 'error');
            saveBtn.disabled = false;
          }
        });

      footer.appendChild(cancelBtn);
      footer.appendChild(saveBtn);
      modal.appendChild(header);
      modal.appendChild(body);
      modal.appendChild(footer);
      overlay.appendChild(modal);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
      });
      document.body.appendChild(overlay);
      setTimeout(() => {
        nameInput.focus();
        nameInput.select();
      }, 0);
    }
  }

  // 標題輸入
  const titleGroup = document.createElement('div');
  titleGroup.className = 'form-group';
  const titleLabel = document.createElement('label');
  titleLabel.textContent = '會議標題';
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'form-control';
  titleInput.placeholder = '請輸入會議標題';
  titleGroup.appendChild(titleLabel);
  titleGroup.appendChild(titleInput);

  // 分類選擇
  const catGroup = document.createElement('div');
  catGroup.className = 'form-group';
  const catLabel = document.createElement('label');
  catLabel.textContent = '分類（可選）';
  const catSelect = document.createElement('select');
  catSelect.className = 'form-control';
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '-- 無分類 --';
  catSelect.appendChild(noneOpt);
  for (const cat of categories) {
    const opt = document.createElement('option');
    opt.value = cat.id;
    opt.textContent = cat.name;
    catSelect.appendChild(opt);
  }
  catGroup.appendChild(catLabel);
  catGroup.appendChild(catSelect);

  // 參與者列表編輯器
  const partEditorContainer = document.createElement('div');
  const initialEditor = buildParticipantEditor([], savedParticipants, {
    allowManageSaved: true,
    onSavedParticipantsChanged,
  });
  partEditorContainer.appendChild(initialEditor.el);
  let getParticipantsRef = initialEditor.getParticipants;

  // 儲存為範本
  const tplSaveGroup = document.createElement('div');
  tplSaveGroup.className = 'form-group save-as-template-row';
  const tplSaveCheckbox = document.createElement('input');
  tplSaveCheckbox.type = 'checkbox';
  tplSaveCheckbox.id = 'save-as-template-checkbox';
  const tplSaveLabel = document.createElement('label');
  tplSaveLabel.htmlFor = 'save-as-template-checkbox';
  tplSaveLabel.textContent = '建立後儲存為範本';
  const tplSaveNameInput = document.createElement('input');
  tplSaveNameInput.type = 'text';
  tplSaveNameInput.className = 'form-control';
  tplSaveNameInput.placeholder = '範本名稱';
  tplSaveNameInput.style.display = 'none';
  tplSaveCheckbox.addEventListener('change', () => {
    tplSaveNameInput.style.display = tplSaveCheckbox.checked ? '' : 'none';
    if (tplSaveCheckbox.checked) {
      tplSaveNameInput.value = titleInput.value.trim();
      tplSaveNameInput.focus();
    }
  });
  titleInput.addEventListener('input', () => {
    if (tplSaveCheckbox.checked && !tplSaveNameInput.value) {
      tplSaveNameInput.value = titleInput.value.trim();
    }
  });
  tplSaveGroup.appendChild(tplSaveCheckbox);
  tplSaveGroup.appendChild(tplSaveLabel);
  tplSaveGroup.appendChild(tplSaveNameInput);

  form.appendChild(titleGroup);
  form.appendChild(catGroup);
  form.appendChild(partEditorContainer);
  form.appendChild(tplSaveGroup);

  const getData = (): CreateMeetingRequest | null => {
    const title = titleInput.value.trim();
    if (!title) {
      titleInput.focus();
      return null;
    }
    return {
      title,
      category_id: catSelect.value || null,
      participants: getParticipantsRef(),
    };
  };

  const getSaveAsTemplate = () => ({
    save: tplSaveCheckbox.checked,
    name: tplSaveNameInput.value.trim() || titleInput.value.trim(),
  });

  return { el: form, getData, getSaveAsTemplate };
}

function renderMeetingCard(
  meeting: MeetingWithDetails,
  onDelete: (id: string) => void,
  onTagClick: (tagId: string) => void
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'meeting-card';
  card.dataset['id'] = meeting.id;

  const info = document.createElement('div');
  info.className = 'meeting-card-info';

  const title = document.createElement('h3');
  title.className = 'meeting-card-title';
  title.textContent = meeting.title;

  const meta = document.createElement('div');
  meta.className = 'meeting-card-meta';

  const dateSpan = document.createElement('span');
  dateSpan.className = 'meeting-card-date';
  dateSpan.textContent = formatDate(meeting.created_at);
  meta.appendChild(dateSpan);

  if (meeting.category_name) {
    const catBadge = document.createElement('span');
    catBadge.className = 'badge badge-category';
    catBadge.textContent = meeting.category_name;
    meta.appendChild(catBadge);
  }

  const badges = document.createElement('div');
  badges.className = 'meeting-card-badges';
  if (meeting.has_transcript) {
    const t = document.createElement('span');
    t.className = 'badge badge-transcript';
    t.textContent = '逐字稿';
    badges.appendChild(t);
  }
  if (meeting.has_summary) {
    const s = document.createElement('span');
    s.className = 'badge badge-summary';
    s.textContent = '摘要';
    badges.appendChild(s);
  }

  // 標籤 chips
  if (meeting.tags && meeting.tags.length > 0) {
    const tagsRow = document.createElement('div');
    tagsRow.className = 'meeting-card-tags';
    for (const tag of meeting.tags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.style.backgroundColor = tag.color;
      chip.textContent = tag.name;
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        onTagClick(tag.id);
      });
      tagsRow.appendChild(chip);
    }
    info.appendChild(title);
    info.appendChild(meta);
    info.appendChild(badges);
    info.appendChild(tagsRow);
  } else {
    info.appendChild(title);
    info.appendChild(meta);
    info.appendChild(badges);
  }

  const actions = document.createElement('div');
  actions.className = 'meeting-card-actions';

  const delBtn = document.createElement('button');
  delBtn.className = 'btn btn-danger btn-sm';
  delBtn.textContent = '刪除';
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onDelete(meeting.id);
  });
  actions.appendChild(delBtn);

  card.appendChild(info);
  card.appendChild(actions);

  card.addEventListener('click', () => {
    window.location.hash = `#meeting/${meeting.id}`;
  });

  return card;
}

export async function renderHomePage(container: HTMLElement): Promise<void> {
  container.innerHTML = '<div class="loading">載入中...</div>';

  let meetings: MeetingWithDetails[] = [];
  let categories: Category[] = [];
  let savedParticipants: SavedParticipant[] = [];
  let templates: MeetingTemplate[] = [];
  let allTags: Tag[] = [];
  let activeCategory = '';
  let activeTagId = '';

  try {
    [meetings, categories, savedParticipants, templates, allTags] = await Promise.all([
      getMeetings(),
      getCategories(),
      getSavedParticipants(),
      getTemplates(),
      getTags(),
    ]);
  } catch (err) {
    container.innerHTML = `<div class="error-state">載入失敗：${String(err)}</div>`;
    return;
  }

  function buildPage(): void {
    container.innerHTML = '';

    // 工具列
    const toolbar = document.createElement('div');
    toolbar.className = 'page-toolbar';

    const pageTitle = document.createElement('h2');
    pageTitle.className = 'page-title';
    pageTitle.textContent = '我的會議';
    toolbar.appendChild(pageTitle);

    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-primary';
    addBtn.textContent = '+ 新增會議';
    addBtn.addEventListener('click', () => openAddModal());
    toolbar.appendChild(addBtn);

    container.appendChild(toolbar);

    // 分類 Tab
    const tabs = document.createElement('div');
    tabs.className = 'category-tabs';

    const allTab = document.createElement('button');
    allTab.className = `tab-btn${activeCategory === '' ? ' active' : ''}`;
    allTab.textContent = '全部';
    allTab.addEventListener('click', () => {
      activeCategory = '';
      buildPage();
    });
    tabs.appendChild(allTab);

    for (const cat of categories) {
      const tabBtn = document.createElement('button');
      tabBtn.className = `tab-btn${activeCategory === cat.id ? ' active' : ''}`;
      tabBtn.textContent = cat.name;
      tabBtn.addEventListener('click', () => {
        activeCategory = cat.id;
        buildPage();
      });
      tabs.appendChild(tabBtn);
    }

    container.appendChild(tabs);

    // 標籤篩選列
    if (allTags.length > 0) {
      const tagBar = document.createElement('div');
      tagBar.className = 'tag-filter-bar';

      const clearTagBtn = document.createElement('button');
      clearTagBtn.className = `tag-filter-chip${activeTagId === '' ? ' active' : ''}`;
      clearTagBtn.textContent = '全部標籤';
      clearTagBtn.addEventListener('click', () => { activeTagId = ''; buildPage(); });
      tagBar.appendChild(clearTagBtn);

      for (const tag of allTags) {
        const chip = document.createElement('button');
        chip.className = `tag-filter-chip${activeTagId === tag.id ? ' active' : ''}`;
        chip.style.setProperty('--tag-color', tag.color);
        chip.textContent = tag.name;
        chip.addEventListener('click', () => { activeTagId = tag.id; buildPage(); });
        tagBar.appendChild(chip);
      }

      const manageTagsBtn = document.createElement('button');
      manageTagsBtn.className = 'btn btn-ghost btn-sm tag-manage-btn';
      manageTagsBtn.textContent = '管理標籤';
      manageTagsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openTagManagerModal();
      });
      tagBar.appendChild(manageTagsBtn);

      container.appendChild(tagBar);
    }

    // 會議列表
    let filtered = activeCategory
      ? meetings.filter((m) => m.category_id === activeCategory)
      : meetings;

    if (activeTagId) {
      filtered = filtered.filter((m) => m.tags.some((t) => t.id === activeTagId));
    }

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = '<p>目前沒有會議記錄</p><p>點擊「+ 新增會議」開始建立</p>';
      container.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'meeting-list';
      for (const m of filtered) {
        list.appendChild(renderMeetingCard(m, handleDelete, (tagId) => {
          activeTagId = tagId;
          buildPage();
        }));
      }
      container.appendChild(list);
    }
  }

  function openAddModal(): void {
    const { el, getData, getSaveAsTemplate } = buildCreateMeetingForm(
      categories,
      savedParticipants,
      templates,
      (updated) => {
        savedParticipants.splice(0, savedParticipants.length, ...updated);
      },
      (updated) => {
        templates.splice(0, templates.length, ...updated);
      }
    );
    openModal({
      title: '新增會議',
      content: el,
      confirmText: '建立',
      cancelText: '取消',
      onConfirm: async () => {
        const data = getData();
        if (!data) return false;
        try {
          const newMeeting = await createMeeting(data);
          meetings.unshift(newMeeting);

          // 將參與者加入常用清單
          await Promise.all(data.participants.map((name) => upsertSavedParticipant(name)));
          // 更新本地 savedParticipants 快取
          const refreshed = await getSavedParticipants();
          savedParticipants.splice(0, savedParticipants.length, ...refreshed);

          // 若勾選「儲存為範本」
          const tplOpt = getSaveAsTemplate();
          if (tplOpt.save && tplOpt.name) {
            const req: CreateTemplateRequest = {
              name: tplOpt.name,
              title: data.title,
              category_id: data.category_id,
              participants: data.participants,
            };
            const newTpl = await createTemplate(req);
            templates.unshift(newTpl);
          }

          showToast('會議已建立', 'success');
          buildPage();
        } catch (err) {
          showToast(`建立失敗：${String(err)}`, 'error');
          return false;
        }
      },
    });
  }

  function openTagManagerModal(): void {
    const tagColors = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'];

    function buildTagManager(): HTMLElement {
      const wrap = document.createElement('div');
      wrap.className = 'tag-manager';

      // 現有標籤列表
      const list = document.createElement('div');
      list.className = 'tag-manager-list';
      const renderList = () => {
        list.innerHTML = '';
        for (const tag of allTags) {
          const row = document.createElement('div');
          row.className = 'tag-manager-row';
          const swatch = document.createElement('span');
          swatch.className = 'tag-swatch';
          swatch.style.backgroundColor = tag.color;
          const nameTxt = document.createElement('span');
          nameTxt.textContent = tag.name;
          nameTxt.style.flex = '1';
          const delBtn = document.createElement('button');
          delBtn.className = 'btn btn-danger btn-sm';
          delBtn.textContent = '刪除';
          delBtn.addEventListener('click', async () => {
            if (!confirm(`確定要刪除標籤「${tag.name}」嗎？`)) return;
            try {
              await deleteTag(tag.id);
              allTags = allTags.filter((t) => t.id !== tag.id);
              meetings.forEach((m) => { m.tags = m.tags.filter((t) => t.id !== tag.id); });
              renderList();
            } catch (err) {
              showToast(`刪除失敗：${String(err)}`, 'error');
            }
          });
          row.appendChild(swatch);
          row.appendChild(nameTxt);
          row.appendChild(delBtn);
          list.appendChild(row);
        }
      };
      renderList();

      // 新增標籤
      const addRow = document.createElement('div');
      addRow.className = 'tag-manager-add-row';
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'form-control';
      nameInput.placeholder = '新標籤名稱';
      let selectedColor = tagColors[0];
      const colorPicker = document.createElement('div');
      colorPicker.className = 'tag-color-picker';
      for (const c of tagColors) {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = `color-dot${c === selectedColor ? ' selected' : ''}`;
        dot.style.backgroundColor = c;
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
          allTags.push(newTag);
          nameInput.value = '';
          renderList();
          buildPage();
        } catch (err) {
          showToast(`新增失敗：${String(err)}`, 'error');
        }
      });
      addRow.appendChild(nameInput);
      addRow.appendChild(colorPicker);
      addRow.appendChild(addBtn);

      wrap.appendChild(list);
      wrap.appendChild(addRow);
      return wrap;
    }

    openModal({
      title: '管理標籤',
      content: buildTagManager(),
      confirmText: '完成',
      cancelText: '',
      onConfirm: () => { buildPage(); },
    });
  }

  function handleDelete(id: string): void {
    const meeting = meetings.find((m) => m.id === id);
    if (!meeting) return;
    openModal({
      title: '刪除確認',
      content: `確定要刪除「${meeting.title}」嗎？此操作無法復原。`,
      confirmText: '刪除',
      cancelText: '取消',
      onConfirm: async () => {
        try {
          await deleteMeeting(id);
          meetings = meetings.filter((m) => m.id !== id);
          showToast('已刪除', 'success');
          buildPage();
        } catch (err) {
          showToast(`刪除失敗：${String(err)}`, 'error');
        }
      },
    });
  }

  buildPage();
}
