import type { MeetingWithDetails, Category, CreateMeetingRequest } from '../types';
import { getMeetings, getCategories, createMeeting, deleteMeeting } from '../api/meetings';
import { openModal } from '../components/modal';
import { showToast } from '../components/toast';

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function buildCreateMeetingForm(categories: Category[]): { el: HTMLElement; getData: () => CreateMeetingRequest | null } {
  const form = document.createElement('div');
  form.className = 'form-group-list';

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

  // 參與者輸入
  const partGroup = document.createElement('div');
  partGroup.className = 'form-group';
  const partLabel = document.createElement('label');
  partLabel.textContent = '參與者（以逗號分隔）';
  const partInput = document.createElement('input');
  partInput.type = 'text';
  partInput.className = 'form-control';
  partInput.placeholder = '例：張三, 李四';
  partGroup.appendChild(partLabel);
  partGroup.appendChild(partInput);

  form.appendChild(titleGroup);
  form.appendChild(catGroup);
  form.appendChild(partGroup);

  const getData = (): CreateMeetingRequest | null => {
    const title = titleInput.value.trim();
    if (!title) {
      titleInput.focus();
      return null;
    }
    const participants = partInput.value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return {
      title,
      categoryId: catSelect.value || null,
      participants,
    };
  };

  return { el: form, getData };
}

function renderMeetingCard(
  meeting: MeetingWithDetails,
  onDelete: (id: string) => void
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
  dateSpan.textContent = formatDate(meeting.createdAt);
  meta.appendChild(dateSpan);

  if (meeting.categoryName) {
    const catBadge = document.createElement('span');
    catBadge.className = 'badge badge-category';
    catBadge.textContent = meeting.categoryName;
    meta.appendChild(catBadge);
  }

  const badges = document.createElement('div');
  badges.className = 'meeting-card-badges';
  if (meeting.hasTranscript) {
    const t = document.createElement('span');
    t.className = 'badge badge-transcript';
    t.textContent = '逐字稿';
    badges.appendChild(t);
  }
  if (meeting.hasSummary) {
    const s = document.createElement('span');
    s.className = 'badge badge-summary';
    s.textContent = '摘要';
    badges.appendChild(s);
  }

  info.appendChild(title);
  info.appendChild(meta);
  info.appendChild(badges);

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
  let activeCategory = '';

  try {
    [meetings, categories] = await Promise.all([getMeetings(), getCategories()]);
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

    // 會議列表
    const filtered = activeCategory
      ? meetings.filter((m) => m.categoryId === activeCategory)
      : meetings;

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = '<p>目前沒有會議記錄</p><p>點擊「+ 新增會議」開始建立</p>';
      container.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'meeting-list';
      for (const m of filtered) {
        list.appendChild(renderMeetingCard(m, handleDelete));
      }
      container.appendChild(list);
    }
  }

  function openAddModal(): void {
    const { el, getData } = buildCreateMeetingForm(categories);
    openModal({
      title: '新增會議',
      content: el,
      confirmText: '建立',
      cancelText: '取消',
      onConfirm: async () => {
        const data = getData();
        if (!data) return;
        try {
          const newMeeting = await createMeeting(data);
          meetings.unshift(newMeeting);
          showToast('會議已建立', 'success');
          buildPage();
        } catch (err) {
          showToast(`建立失敗：${String(err)}`, 'error');
        }
      },
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
