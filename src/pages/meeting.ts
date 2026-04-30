import type { MeetingWithDetails, Transcript, Summary, Recording, SavedParticipant, CreateTemplateRequest, Tag } from '../types';
import { getMeeting, updateMeeting } from '../api/meetings';
import { getTranscript, switchTranscriptVersion } from '../api/transcripts';
import { getSummary } from '../api/summaries';
import { getRecording } from '../api/recordings';
import { startTranscription } from '../api/settings';
import { getSavedParticipants, upsertSavedParticipant } from '../api/participants';
import { createTemplate } from '../api/templates';
import { getTags } from '../api/tags';
import { openModal } from '../components/modal';
import { showToast } from '../components/toast';
import { createWaveformPlayer } from '../components/audioPlayer';
import { buildParticipantEditor } from '../components/participantEditor';
import { convertFileSrc } from '@tauri-apps/api/core';

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
  onRefresh: () => void,
  recording: Recording | null = null
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'detail-section';

  const header = document.createElement('div');
  header.className = 'section-header';
  const heading = document.createElement('h3');
  heading.textContent = '逐字稿';
  header.appendChild(heading);
  section.appendChild(header);

  if (!transcript || (!transcript.original_content && !transcript.proofread_content)) {
    const empty = document.createElement('p');
    empty.className = 'empty-hint';
    empty.textContent = recording?.file_path
      ? '尚無逐字稿，點擊下方按鈕開始轉譯錄音。'
      : '尚無逐字稿，請先完成錄音並轉譯。';
    section.appendChild(empty);

    if (recording?.file_path) {
      const filePath = recording.file_path;
      const transcribeBtn = document.createElement('button');
      transcribeBtn.className = 'btn btn-primary btn-sm';
      transcribeBtn.textContent = '產生逐字稿';
      transcribeBtn.addEventListener('click', async () => {
        transcribeBtn.disabled = true;
        transcribeBtn.textContent = '轉譯中…';
        try {
          await startTranscription(meetingId, filePath);
          showToast('逐字稿已生成', 'success');
          onRefresh();
        } catch (err) {
          showToast(`轉譯失敗：${String(err)}`, 'error');
          transcribeBtn.disabled = false;
          transcribeBtn.textContent = '產生逐字稿';
        }
      });
      section.appendChild(transcribeBtn);
    }
    return section;
  }

  // 版本切換 Tab
  const tabs = document.createElement('div');
  tabs.className = 'version-tabs';

  const originalBtn = document.createElement('button');
  originalBtn.className = `tab-btn${transcript.active_version === 'original' ? ' active' : ''}`;
  originalBtn.textContent = '原始版';

  const proofreadBtn = document.createElement('button');
  proofreadBtn.className = `tab-btn${transcript.active_version === 'proofread' ? ' active' : ''}`;
  proofreadBtn.textContent = '校稿版';
  if (!transcript.proofread_content) {
    proofreadBtn.disabled = true;
    proofreadBtn.title = '尚未校稿';
  }

  tabs.appendChild(originalBtn);
  tabs.appendChild(proofreadBtn);
  section.appendChild(tabs);

  // 內容顯示
  const content = document.createElement('div');
  content.className = 'transcript-content';

  function renderTranscriptText(text: string): void {
    content.innerHTML = '';
    // 偵測是否有時間軸格式：[MM:SS 講者X] 或 [MM:SS]
    const utteranceRe = /^\[(\d{2}:\d{2})(?:\s+(講者\w+))?\]\s+(.*)$/;
    const lines = text.split('\n');
    const hasTimestamps = lines.some((l) => utteranceRe.test(l.trim()));

    if (hasTimestamps) {
      for (const line of lines) {
        const m = line.trim().match(utteranceRe);
        if (m) {
          const [, time, speaker, body] = m;
          const row = document.createElement('div');
          row.className = 'transcript-row';

          const timeEl = document.createElement('span');
          timeEl.className = 'transcript-time';
          timeEl.textContent = time;

          const textEl = document.createElement('span');
          textEl.className = 'transcript-text';
          if (speaker) {
            const speakerEl = document.createElement('span');
            speakerEl.className = `transcript-speaker speaker-${speaker.replace('講者', '')}`;
            speakerEl.textContent = speaker + '：';
            textEl.appendChild(speakerEl);
            textEl.appendChild(document.createTextNode(body));
          } else {
            textEl.textContent = body;
          }
          row.appendChild(timeEl);
          row.appendChild(textEl);
          content.appendChild(row);
        } else if (line.trim()) {
          const p = document.createElement('p');
          p.textContent = line;
          content.appendChild(p);
        }
      }
    } else {
      content.textContent = text;
    }
  }

  function showVersion(version: 'original' | 'proofread'): void {
    const text = version === 'original' ? transcript?.original_content : transcript?.proofread_content;
    renderTranscriptText(text ?? '');
    originalBtn.classList.toggle('active', version === 'original');
    proofreadBtn.classList.toggle('active', version === 'proofread');
  }

  showVersion(transcript.active_version);

  originalBtn.addEventListener('click', async () => {
    try {
      await switchTranscriptVersion(meetingId, 'original');
      showVersion('original');
    } catch {
      showToast('切換失敗', 'error');
    }
  });

  proofreadBtn.addEventListener('click', async () => {
    if (!transcript.proofread_content) return;
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
    const text = transcript.active_version === 'original'
      ? (transcript.original_content ?? '')
      : (transcript.proofread_content ?? transcript.original_content ?? '');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'transcript.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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

  // 重新生成按鈕（需要有錄音檔才能重新轉譯）
  if (recording?.file_path) {
    const filePath = recording.file_path;
    const regenBtn = document.createElement('button');
    regenBtn.className = 'btn btn-secondary btn-sm';
    regenBtn.textContent = '重新生成';
    regenBtn.addEventListener('click', async () => {
      if (!confirm('確定要重新生成逐字稿嗎？原始版本將被覆蓋。')) return;
      regenBtn.disabled = true;
      regenBtn.textContent = '轉譯中…';
      try {
        await startTranscription(meetingId, filePath);
        showToast('逐字稿已重新生成', 'success');
        onRefresh();
      } catch (err) {
        showToast(`轉譯失敗：${String(err)}`, 'error');
        regenBtn.disabled = false;
        regenBtn.textContent = '重新生成';
      }
    });
    actions.appendChild(regenBtn);
  }

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

  if (!recording || !recording.file_path) {
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
    if (recording.duration_seconds !== null) {
      const dur = document.createElement('p');
      dur.className = 'audio-duration';
      const minutes = Math.floor(recording.duration_seconds / 60);
      const seconds = recording.duration_seconds % 60;
      dur.textContent = `時長：${minutes}:${String(seconds).padStart(2, '0')}`;
      section.appendChild(dur);
    }

    const audioEl = document.createElement('audio');
    audioEl.preload = 'metadata';
    audioEl.style.display = 'none';
    audioEl.src = recording.file_path.startsWith('blob:')
      ? recording.file_path
      : convertFileSrc(recording.file_path);

    const playerEl = createWaveformPlayer(audioEl);
    section.appendChild(audioEl);
    section.appendChild(playerEl);
  }

  return section;
}

export async function renderMeetingPage(container: HTMLElement, meetingId: string): Promise<void> {
  container.innerHTML = '<div class="loading">載入中...</div>';

  let meeting: MeetingWithDetails | null = null;
  let transcript: Transcript | null = null;
  let summary: Summary | null = null;
  let recording: Recording | null = null;
  let savedParticipants: SavedParticipant[] = [];
  let allTags: Tag[] = [];

  try {
    [meeting, transcript, summary, recording, savedParticipants, allTags] = await Promise.all([
      getMeeting(meetingId),
      getTranscript(meetingId),
      getSummary(meetingId),
      getRecording(meetingId),
      getSavedParticipants(),
      getTags(),
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

    const saveAsTplBtn = document.createElement('button');
    saveAsTplBtn.className = 'btn btn-ghost btn-sm';
    saveAsTplBtn.textContent = '儲存為範本';
    saveAsTplBtn.addEventListener('click', () => openSaveTemplateModal());

    topBar.appendChild(backBtn);
    topBar.appendChild(titleArea);
    topBar.appendChild(editBtn);
    topBar.appendChild(saveAsTplBtn);
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

    // 標籤顯示
    if (meeting.tags && meeting.tags.length > 0) {
      const tagsBar = document.createElement('div');
      tagsBar.className = 'participants-bar';
      const tagsLabel = document.createElement('span');
      tagsLabel.className = 'participants-label';
      tagsLabel.textContent = '標籤：';
      tagsBar.appendChild(tagsLabel);
      for (const tag of meeting.tags) {
        const chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.style.backgroundColor = tag.color;
        chip.textContent = tag.name;
        tagsBar.appendChild(chip);
      }
      container.appendChild(tagsBar);
    }

    // 錄音區塊
    container.appendChild(buildRecordingSection(recording));

    // 逐字稿區塊
    container.appendChild(buildTranscriptSection(transcript, meetingId, () => build(), recording));

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

    // 參與者列表編輯器
    const { el: partEditorEl, getParticipants } = buildParticipantEditor(
      meeting.participants,
      savedParticipants
    );

    // 標籤選擇
    const currentTagIds = new Set(meeting.tags.map((t) => t.id));
    let selectedTagIds: Set<string> = new Set(currentTagIds);
    const tagGroup = document.createElement('div');
    tagGroup.className = 'form-group';
    const tagLabel = document.createElement('label');
    tagLabel.textContent = '標籤';
    tagGroup.appendChild(tagLabel);
    if (allTags.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'empty-hint';
      hint.textContent = '尚無標籤，請先在首頁管理標籤。';
      tagGroup.appendChild(hint);
    } else {
      const tagCheckboxes = document.createElement('div');
      tagCheckboxes.className = 'tag-checkbox-list';
      for (const tag of allTags) {
        const row = document.createElement('label');
        row.className = 'tag-checkbox-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selectedTagIds.has(tag.id);
        cb.addEventListener('change', () => {
          if (cb.checked) selectedTagIds.add(tag.id);
          else selectedTagIds.delete(tag.id);
        });
        const swatch = document.createElement('span');
        swatch.className = 'tag-swatch';
        swatch.style.backgroundColor = tag.color;
        row.appendChild(cb);
        row.appendChild(swatch);
        row.appendChild(document.createTextNode(tag.name));
        tagCheckboxes.appendChild(row);
      }
      tagGroup.appendChild(tagCheckboxes);
    }

    form.appendChild(titleGroup);
    form.appendChild(partEditorEl);
    form.appendChild(tagGroup);

    openModal({
      title: '編輯會議',
      content: form,
      confirmText: '儲存',
      cancelText: '取消',
      onConfirm: async () => {
        const title = titleInput.value.trim();
        if (!title || !meeting) return false;
        const participants = getParticipants();
        try {
          const updated = await updateMeeting(meeting.id, {
            title,
            category_id: meeting.category_id,
            participants,
            tag_ids: Array.from(selectedTagIds),
          });
          meeting = updated;
          // 將參與者加入常用清單
          await Promise.all(participants.map((name) => upsertSavedParticipant(name)));
          showToast('已儲存', 'success');
          build();
        } catch (err) {
          showToast(`儲存失敗：${String(err)}`, 'error');
          return false;
        }
      },
    });
  }

  function openSaveTemplateModal(): void {
    if (!meeting) return;

    const form = document.createElement('div');
    form.className = 'form-group-list';

    const nameGroup = document.createElement('div');
    nameGroup.className = 'form-group';
    const nameLabel = document.createElement('label');
    nameLabel.textContent = '範本名稱';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'form-control';
    nameInput.value = meeting.title;
    nameInput.placeholder = '請輸入範本名稱';
    nameGroup.appendChild(nameLabel);
    nameGroup.appendChild(nameInput);
    form.appendChild(nameGroup);

    openModal({
      title: '儲存為範本',
      content: form,
      confirmText: '儲存',
      cancelText: '取消',
      onConfirm: async () => {
        const name = nameInput.value.trim();
        if (!name || !meeting) return false;
        const req: CreateTemplateRequest = {
          name,
          title: meeting.title,
          category_id: meeting.category_id,
          participants: meeting.participants,
        };
        try {
          await createTemplate(req);
          showToast('已儲存為範本', 'success');
        } catch (err) {
          showToast(`儲存失敗：${String(err)}`, 'error');
          return false;
        }
      },
    });
  }

  build();
}