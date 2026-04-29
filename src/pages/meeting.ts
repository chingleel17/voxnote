import type { MeetingWithDetails, Transcript, Summary, Recording } from '../types';
import { getMeeting, updateMeeting } from '../api/meetings';
import { getTranscript, switchTranscriptVersion } from '../api/transcripts';
import { getSummary } from '../api/summaries';
import { getRecording } from '../api/recordings';
import { openModal } from '../components/modal';
import { showToast } from '../components/toast';

/** 簡易 Markdown → HTML 轉換（僅支援 h1-h3、粗體、清單） */
function renderMarkdown(md: string): string {
  return md
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<[hul])/gm, '')
    .split('\n')
    .map((line) => (line && !line.startsWith('<') ? `<p>${line}</p>` : line))
    .join('\n');
}

function buildTranscriptSection(
  transcript: Transcript | null,
  meetingId: string,
  onRefresh: () => void
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'detail-section';

  const header = document.createElement('div');
  header.className = 'section-header';
  const heading = document.createElement('h3');
  heading.textContent = '逐字稿';
  header.appendChild(heading);
  section.appendChild(header);

  if (!transcript || (!transcript.originalContent && !transcript.proofreadContent)) {
    const empty = document.createElement('p');
    empty.className = 'empty-hint';
    empty.textContent = '尚無逐字稿，請先完成錄音並轉譯。';
    section.appendChild(empty);
    return section;
  }

  // 版本切換 Tab
  const tabs = document.createElement('div');
  tabs.className = 'version-tabs';

  const originalBtn = document.createElement('button');
  originalBtn.className = `tab-btn${transcript.activeVersion === 'original' ? ' active' : ''}`;
  originalBtn.textContent = '原始版';

  const proofreadBtn = document.createElement('button');
  proofreadBtn.className = `tab-btn${transcript.activeVersion === 'proofread' ? ' active' : ''}`;
  proofreadBtn.textContent = '校稿版';
  if (!transcript.proofreadContent) {
    proofreadBtn.disabled = true;
    proofreadBtn.title = '尚未校稿';
  }

  tabs.appendChild(originalBtn);
  tabs.appendChild(proofreadBtn);
  section.appendChild(tabs);

  // 內容顯示
  const content = document.createElement('div');
  content.className = 'transcript-content';

  function showVersion(version: 'original' | 'proofread'): void {
    const text = version === 'original' ? transcript?.originalContent : transcript?.proofreadContent;
    content.textContent = text ?? '';
    originalBtn.classList.toggle('active', version === 'original');
    proofreadBtn.classList.toggle('active', version === 'proofread');
  }

  showVersion(transcript.activeVersion);

  originalBtn.addEventListener('click', async () => {
    try {
      await switchTranscriptVersion(meetingId, 'original');
      showVersion('original');
    } catch {
      showToast('切換失敗', 'error');
    }
  });

  proofreadBtn.addEventListener('click', async () => {
    if (!transcript.proofreadContent) return;
    try {
      await switchTranscriptVersion(meetingId, 'proofread');
      showVersion('proofread');
    } catch {
      showToast('切換失敗', 'error');
    }
  });

  section.appendChild(content);

  // 操作按鈕列
  const actions = document.createElement('div');
  actions.className = 'section-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn btn-secondary btn-sm';
  copyBtn.textContent = '複製';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(content.textContent ?? '').then(() => {
      showToast('已複製到剪貼簿', 'success');
    });
  });

  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn btn-secondary btn-sm';
  exportBtn.textContent = '匯出 TXT';
  exportBtn.addEventListener('click', () => {
    const blob = new Blob([content.textContent ?? ''], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'transcript.txt';
    a.click();
    URL.revokeObjectURL(url);
  });

  const proofreadActionBtn = document.createElement('button');
  proofreadActionBtn.className = 'btn btn-primary btn-sm';
  proofreadActionBtn.textContent = 'AI 校稿';
  proofreadActionBtn.addEventListener('click', () => {
    showToast('AI 校稿功能開發中', 'info');
    onRefresh();
  });

  actions.appendChild(proofreadActionBtn);
  actions.appendChild(copyBtn);
  actions.appendChild(exportBtn);
  section.appendChild(actions);

  return section;
}

function buildSummarySection(
  summary: Summary | null,
  onRefresh: () => void
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'detail-section';

  const header = document.createElement('div');
  header.className = 'section-header';
  const heading = document.createElement('h3');
  heading.textContent = '摘要';
  header.appendChild(heading);
  section.appendChild(header);

  const contentDiv = document.createElement('div');
  contentDiv.className = 'summary-content markdown-body';

  if (summary) {
    contentDiv.innerHTML = renderMarkdown(summary.content);
  } else {
    contentDiv.innerHTML = '<p class="empty-hint">尚無摘要，點擊「生成摘要」按鈕建立。</p>';
  }
  section.appendChild(contentDiv);

  const actions = document.createElement('div');
  actions.className = 'section-actions';

  const generateBtn = document.createElement('button');
  generateBtn.className = 'btn btn-primary btn-sm';
  generateBtn.textContent = '生成摘要';
  generateBtn.addEventListener('click', () => {
    showToast('AI 摘要功能開發中', 'info');
    onRefresh();
  });

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn btn-secondary btn-sm';
  copyBtn.textContent = '複製';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(summary?.content ?? '').then(() => {
      showToast('已複製到剪貼簿', 'success');
    });
  });

  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn btn-secondary btn-sm';
  exportBtn.textContent = '匯出 MD';
  exportBtn.addEventListener('click', () => {
    const blob = new Blob([summary?.content ?? ''], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'summary.md';
    a.click();
    URL.revokeObjectURL(url);
  });

  actions.appendChild(generateBtn);
  if (summary) {
    actions.appendChild(copyBtn);
    actions.appendChild(exportBtn);
  }
  section.appendChild(actions);

  return section;
}

function buildRecordingSection(recording: Recording | null): HTMLElement {
  const section = document.createElement('section');
  section.className = 'detail-section';

  const header = document.createElement('div');
  header.className = 'section-header';
  const heading = document.createElement('h3');
  heading.textContent = '錄音';
  header.appendChild(heading);
  section.appendChild(header);

  if (!recording || !recording.filePath) {
    const hint = document.createElement('p');
    hint.className = 'empty-hint';
    hint.textContent = '尚無錄音檔案。';
    section.appendChild(hint);

    const goBtn = document.createElement('button');
    goBtn.className = 'btn btn-secondary btn-sm';
    goBtn.textContent = '前往錄音';
    goBtn.addEventListener('click', () => {
      window.location.hash = '#record';
    });
    section.appendChild(goBtn);
  } else {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.className = 'audio-player';
    // filePath 可能是本地路徑或 blob URL
    audio.src = recording.filePath.startsWith('blob:')
      ? recording.filePath
      : `asset://${recording.filePath}`;

    if (recording.durationSeconds !== null) {
      const dur = document.createElement('p');
      dur.className = 'audio-duration';
      const minutes = Math.floor(recording.durationSeconds / 60);
      const seconds = recording.durationSeconds % 60;
      dur.textContent = `時長：${minutes}:${String(seconds).padStart(2, '0')}`;
      section.appendChild(dur);
    }
    section.appendChild(audio);
  }

  return section;
}

export async function renderMeetingPage(container: HTMLElement, meetingId: string): Promise<void> {
  container.innerHTML = '<div class="loading">載入中...</div>';

  let meeting: MeetingWithDetails | null = null;
  let transcript: Transcript | null = null;
  let summary: Summary | null = null;
  let recording: Recording | null = null;

  try {
    [meeting, transcript, summary, recording] = await Promise.all([
      getMeeting(meetingId),
      getTranscript(meetingId),
      getSummary(meetingId),
      getRecording(meetingId),
    ]);
  } catch (err) {
    container.innerHTML = `<div class="error-state">載入失敗：${String(err)}</div>`;
    return;
  }

  if (!meeting) {
    container.innerHTML = '<div class="error-state">找不到此會議</div>';
    return;
  }

  function build(): void {
    if (!meeting) return;
    container.innerHTML = '';

    // 頂部導覽
    const topBar = document.createElement('div');
    topBar.className = 'page-toolbar';

    const backBtn = document.createElement('button');
    backBtn.className = 'btn btn-ghost btn-sm';
    backBtn.textContent = '← 返回';
    backBtn.addEventListener('click', () => {
      window.location.hash = '#home';
    });

    const titleArea = document.createElement('div');
    titleArea.className = 'meeting-detail-title';

    const titleEl = document.createElement('h2');
    titleEl.className = 'page-title';
    titleEl.textContent = meeting.title;
    titleArea.appendChild(titleEl);

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-secondary btn-sm';
    editBtn.textContent = '編輯';
    editBtn.addEventListener('click', () => openEditModal());

    const printBtn = document.createElement('button');
    printBtn.className = 'btn btn-ghost btn-sm';
    printBtn.textContent = '匯出 PDF';
    printBtn.addEventListener('click', () => window.print());

    topBar.appendChild(backBtn);
    topBar.appendChild(titleArea);
    topBar.appendChild(editBtn);
    topBar.appendChild(printBtn);
    container.appendChild(topBar);

    // 參與者
    if (meeting.participants.length > 0) {
      const partSection = document.createElement('div');
      partSection.className = 'participants-bar';
      const label = document.createElement('span');
      label.className = 'participants-label';
      label.textContent = '參與者：';
      partSection.appendChild(label);
      for (const p of meeting.participants) {
        const chip = document.createElement('span');
        chip.className = 'participant-chip';
        chip.textContent = p;
        partSection.appendChild(chip);
      }
      container.appendChild(partSection);
    }

    // 錄音區塊
    container.appendChild(buildRecordingSection(recording));

    // 逐字稿區塊
    container.appendChild(buildTranscriptSection(transcript, meetingId, () => build()));

    // 摘要區塊
    container.appendChild(buildSummarySection(summary, () => build()));
  }

  function openEditModal(): void {
    if (!meeting) return;

    const form = document.createElement('div');
    form.className = 'form-group-list';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'form-group';
    const titleLabel = document.createElement('label');
    titleLabel.textContent = '會議標題';
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'form-control';
    titleInput.value = meeting.title;
    titleGroup.appendChild(titleLabel);
    titleGroup.appendChild(titleInput);

    const partGroup = document.createElement('div');
    partGroup.className = 'form-group';
    const partLabel = document.createElement('label');
    partLabel.textContent = '參與者（以逗號分隔）';
    const partInput = document.createElement('input');
    partInput.type = 'text';
    partInput.className = 'form-control';
    partInput.value = meeting.participants.join(', ');
    partGroup.appendChild(partLabel);
    partGroup.appendChild(partInput);

    form.appendChild(titleGroup);
    form.appendChild(partGroup);

    openModal({
      title: '編輯會議',
      content: form,
      confirmText: '儲存',
      cancelText: '取消',
      onConfirm: async () => {
        const title = titleInput.value.trim();
        if (!title || !meeting) return;
        const participants = partInput.value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        try {
          const updated = await updateMeeting(meeting.id, {
            title,
            categoryId: meeting.categoryId,
            participants,
          });
          meeting = updated;
          showToast('已儲存', 'success');
          build();
        } catch (err) {
          showToast(`儲存失敗：${String(err)}`, 'error');
        }
      },
    });
  }

  build();
}
