import { convertFileSrc } from '@tauri-apps/api/core';
import type { MeetingWithDetails, Transcript, Summary, Recording, SavedParticipant, CreateTemplateRequest, Tag, SpeakerMapping, Category, ExportTextFile } from '../types';
import { getMeeting, getCategories, updateMeeting, archiveMeeting, unarchiveMeeting } from '../api/meetings';
import { exportTextFileToPath, getTranscript, saveTranscriptManual, saveTranscriptProofread, switchTranscriptVersion } from '../api/transcripts';
import { getSummary } from '../api/summaries';
import { getRecordings, deleteRecording, setNoBreakBefore, reorderRecordings, remergeSegments } from '../api/recordings';
import { startTranscription, proofreadRecordingSegment, proofreadTranscript, generateSummary } from '../api/settings';
import { getSavedParticipants, upsertSavedParticipant } from '../api/participants';
import { deleteSpeakerMapping, getSpeakerMappings, upsertSpeakerMapping } from '../api/speakerMappings';
import { createTemplate } from '../api/templates';
import { getTags } from '../api/tags';
import { openModal } from '../components/modal';
import { showToast } from '../components/toast';
import { applyMediaCrossOrigin, createWaveformPlayer } from '../components/audioPlayer';
import { buildParticipantEditor } from '../components/participantEditor';
import { save as saveDialog, open as openDialog } from '@tauri-apps/plugin-dialog';
import { exportMeetingBundle } from '../api/meetingExport';
import { isProcessing, startProcessing, finishProcessing, onProcessingComplete } from '../utils/processingState';
import { notifyCompletion } from '../utils/notifications';

type TranscriptVersion = 'original' | 'proofread' | 'manual';
type ManualBaseVersion = 'original' | 'proofread';

interface TranscriptExportContent {
  fileName: string;
  content: string;
  version: TranscriptVersion;
}

interface TranscriptSectionResult {
  el: HTMLElement;
  refreshMappings: (newMappings: SpeakerMapping[]) => void;
  /// 供整包匯出取得當下顯示版本的逐字稿；無逐字稿時回傳 null
  getExportContent: () => TranscriptExportContent | null;
}

const transcriptUtteranceRe = /^\[(\d+:\d{2})(?:\s+([^\]]+))?\]\s+(.*)$/;
const MERGED_BREAK_SEPARATOR = '\n\n--- ☕ 中場休息 ---\n\n';

function parseTimeToSeconds(timeStr: string): number {
  const [minutesPart, secondsPart] = timeStr.split(':');
  return parseInt(minutesPart ?? '0', 10) * 60 + parseInt(secondsPart ?? '0', 10);
}

function getTranscriptVersionText(transcript: Transcript, version: TranscriptVersion): string {
  switch (version) {
    case 'original':
      return transcript.original_content ?? '';
    case 'proofread':
      return transcript.proofread_content ?? transcript.original_content ?? '';
    case 'manual':
      return transcript.manual_content ?? '';
  }
}

function getTranscriptVersionLabel(version: TranscriptVersion): string {
  switch (version) {
    case 'original':
      return '原始版';
    case 'proofread':
      return '校稿版';
    case 'manual':
      return '手動編輯版';
  }
}

function extractSpeakerLabels(...texts: Array<string | null | undefined>): string[] {
  const speakers = new Set<string>();

  for (const text of texts) {
    if (!text) continue;
    for (const line of text.split('\n')) {
      const match = line.trim().match(transcriptUtteranceRe);
      const speaker = match?.[2];
      if (speaker?.startsWith('講者')) speakers.add(speaker);
    }
  }

  return Array.from(speakers).sort((a, b) => a.localeCompare(b));
}

function getSpeakerMappingKey(recordingId: string, speakerLabel: string): string {
  return `${recordingId}::${speakerLabel}`;
}

function buildSpeakerMappingLookup(speakerMappings: SpeakerMapping[]): Map<string, string> {
  return new Map(
    speakerMappings
      .filter((mapping) => Boolean(mapping.recording_id))
      .map((mapping) => [getSpeakerMappingKey(mapping.recording_id!, mapping.speaker_label), mapping.participant_name]),
  );
}

function getMappedSpeakerName(
  mappingBySpeaker: Map<string, string>,
  recordingId: string,
  speakerLabel: string,
): string {
  return mappingBySpeaker.get(getSpeakerMappingKey(recordingId, speakerLabel)) ?? speakerLabel;
}

function getSpeakerClassName(speakerLabel: string): string {
  return `speaker-${speakerLabel.replace('講者', '').replace(/[^A-Za-z0-9_-]/g, '')}`;
}

function getRecordingTranscriptText(recording: Recording, version: TranscriptVersion): string | null {
  switch (version) {
    case 'original':
      return recording.segment_transcript;
    case 'proofread':
      return recording.segment_proofread ?? recording.segment_transcript;
    case 'manual':
      return null;
  }
}

function hasScopedTranscriptText(recordings: Recording[], version: TranscriptVersion): boolean {
  if (version === 'original') {
    return recordings.some((recording) => Boolean(recording.segment_transcript));
  }

  if (version === 'proofread') {
    return recordings.some((recording) => Boolean(recording.segment_proofread));
  }

  return false;
}

function getGeneratedTranscriptSegments(recordings: Recording[], version: TranscriptVersion): Array<{
  recording: Recording;
  segmentIndex: number;
  text: string;
}> {
  return recordings
    .filter((recording) => Boolean(recording.file_path))
    .map((recording, index) => ({
      recording,
      segmentIndex: index + 1,
      text: getRecordingTranscriptText(recording, version) ?? '',
    }))
    .filter((segment) => Boolean(segment.text.trim()));
}

function mapSpeakerLabelsInText(
  text: string,
  mapSpeakerLabel: (speakerLabel: string) => string,
): string {
  return text.split('\n').map((line) => {
    const match = line.trim().match(transcriptUtteranceRe);
    if (!match) return line;

    const [, time, speaker, body] = match;
    if (!speaker) return line;

    return `[${time} ${mapSpeakerLabel(speaker)}] ${body}`;
  }).join('\n');
}

function buildGeneratedTranscriptText(
  recordings: Recording[],
  version: TranscriptVersion,
  speakerMappings: SpeakerMapping[],
): string {
  const mappingBySpeaker = buildSpeakerMappingLookup(speakerMappings);
  const segments = getGeneratedTranscriptSegments(recordings, version);

  return segments.map(({ recording, text }, index) => {
    const mappedText = mapSpeakerLabelsInText(
      text,
      (speakerLabel) => getMappedSpeakerName(mappingBySpeaker, recording.id, speakerLabel),
    );
    if (index === 0) return mappedText;
    return `${recording.no_break_before ? '\n\n' : MERGED_BREAK_SEPARATOR}${mappedText}`;
  }).join('');
}

function buildSpeakerReferenceLines(recordings: Recording[], speakerMappings: SpeakerMapping[]): string[] {
  const segmentIndexByRecordingId = new Map(recordings.map((recording, index) => [recording.id, index + 1]));
  const grouped = new Map<string, Array<{ segmentIndex: number | null; participantName: string }>>();

  for (const mapping of speakerMappings) {
    const recordingId = mapping.recording_id;
    const speakerLabel = mapping.speaker_label.trim();
    const participantName = mapping.participant_name.trim();
    if (!recordingId || !speakerLabel || !participantName) continue;

    const entries = grouped.get(speakerLabel) ?? [];
    entries.push({
      segmentIndex: segmentIndexByRecordingId.get(recordingId) ?? null,
      participantName,
    });
    grouped.set(speakerLabel, entries);
  }

  return Array.from(grouped.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([speakerLabel, entries]) => {
      const participantNames = Array.from(new Set(entries.map((entry) => entry.participantName)));
      if (participantNames.length === 1) {
        return [`${speakerLabel}代表 ${participantNames[0]}`];
      }

      const seen = new Set<string>();
      return [...entries]
        .sort((left, right) => {
          const leftIndex = left.segmentIndex ?? Number.MAX_SAFE_INTEGER;
          const rightIndex = right.segmentIndex ?? Number.MAX_SAFE_INTEGER;
          if (leftIndex !== rightIndex) return leftIndex - rightIndex;
          return left.participantName.localeCompare(right.participantName);
        })
        .flatMap((entry) => {
          const key = `${entry.segmentIndex ?? 'unknown'}::${entry.participantName}`;
          if (seen.has(key)) return [];
          seen.add(key);
          const segmentPrefix = entry.segmentIndex ? `第${entry.segmentIndex}段 ` : '';
          return [`${segmentPrefix}${speakerLabel}代表 ${entry.participantName}`];
        });
    });
}

function buildTranscriptSpeakerReference(recordings: Recording[], speakerMappings: SpeakerMapping[]): string {
  const lines = buildSpeakerReferenceLines(recordings, speakerMappings);
  if (lines.length === 0) {
    return '';
  }

  return [
    '【這裡是講者對應的人員】',
    '',
    ...lines,
    '',
    '【以下是會議逐字稿】',
    '',
  ].join('\n');
}

function prependTranscriptSpeakerReference(
  text: string,
  recordings: Recording[],
  speakerMappings: SpeakerMapping[],
): string {
  const reference = buildTranscriptSpeakerReference(recordings, speakerMappings);
  if (!reference) {
    return text;
  }

  return `${reference}${text.trim()}`;
}

function buildGlobalSpeakerLabelMapper(
  recordings: Recording[],
  speakerMappings: SpeakerMapping[],
): (speakerLabel: string) => string {
  const recIdsWithLabel = new Map<string, Set<string>>();
  for (const recording of recordings) {
    const text = recording.segment_transcript ?? '';
    for (const line of text.split('\n')) {
      const match = line.trim().match(transcriptUtteranceRe);
      const label = match?.[2];
      if (label?.startsWith('講者')) {
        if (!recIdsWithLabel.has(label)) recIdsWithLabel.set(label, new Set());
        recIdsWithLabel.get(label)!.add(recording.id);
      }
    }
  }

  const mappingMap = new Map<string, string>();
  for (const mapping of speakerMappings) {
    if (mapping.recording_id) {
      mappingMap.set(
        `${mapping.recording_id}::${mapping.speaker_label}`,
        mapping.participant_name?.trim() ?? '',
      );
    }
  }

  const lookup = new Map<string, string>();
  for (const [label, recIds] of recIdsWithLabel) {
    const names = new Set([...recIds].map((id) => mappingMap.get(`${id}::${label}`) ?? ''));
    const nonEmpty = [...names].filter((name) => name !== '');
    if (nonEmpty.length === 1 && names.size === 1) {
      lookup.set(label, nonEmpty[0]);
    }
  }

  return (speakerLabel) => lookup.get(speakerLabel) ?? speakerLabel;
}

function getTranscriptBaseText(
  transcript: Transcript,
  recordings: Recording[],
  version: Exclude<TranscriptVersion, 'manual'>,
): string {
  if (hasScopedTranscriptText(recordings, version)) {
    return buildGeneratedTranscriptText(recordings, version, []);
  }

  return getTranscriptVersionText(transcript, version);
}

function normalizeTranscriptStructure(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      const match = trimmed.match(transcriptUtteranceRe);
      if (!match) return trimmed;
      const [, time, , body] = match;
      return `[${time}] ${body}`;
    })
    .join('\n')
    .trim();
}

function sanitizeFileNamePart(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatExportDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return sanitizeFileNamePart(value) || '未指定日期';
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function formatMeetingDisplayDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value.trim() || '未指定日期';
  }

  return date.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

async function resolveRecordingSource(filePath: string): Promise<string> {
  if (filePath.startsWith('blob:')) {
    return filePath;
  }

  return convertFileSrc(filePath);
}

function buildCodeFence(text: string, language = ''): string {
  const fenceLength = Array.from(text.matchAll(/`+/g)).reduce((max, match) => Math.max(max, match[0].length + 1), 3);
  const fence = '`'.repeat(fenceLength);
  return `${fence}${language}\n${text}\n${fence}`;
}

function buildTranscriptExportFileName(meetingTitle: string, meetingDate: string, extension: 'txt' | 'md'): string {
  const safeTitle = sanitizeFileNamePart(meetingTitle) || '未命名會議';
  const safeDate = formatExportDate(meetingDate);
  return `${safeTitle}_${safeDate}_逐字稿.${extension}`;
}

function buildSummaryExportFileName(meetingTitle: string, meetingDate: string): string {
  const safeTitle = sanitizeFileNamePart(meetingTitle) || '未命名會議';
  const safeDate = formatExportDate(meetingDate);
  return `${safeTitle}_${safeDate}_摘要.md`;
}

const EXPORT_FOLDER_TITLE_MAX_LENGTH = 80;

/// 匯出子資料夾名稱：YYYYMMDD_會議名稱
function buildExportFolderName(
  meetingTitle: string,
  meetingDate: string | null,
  createdAt: string,
): string {
  // formatExportDate 無法解析時回傳「未指定日期」而非退回 createdAt，故先在此判斷可解析性
  const hasUsableDate = Boolean(meetingDate) && !Number.isNaN(new Date(meetingDate as string).getTime());
  const safeDate = formatExportDate(hasUsableDate ? (meetingDate as string) : createdAt);
  const safeTitle = (sanitizeFileNamePart(meetingTitle) || '未命名會議')
    .slice(0, EXPORT_FOLDER_TITLE_MAX_LENGTH)
    .trim();
  return `${safeDate}_${safeTitle}`;
}

function buildMeetingInfoContent(
  meeting: MeetingWithDetails,
  recordings: Recording[],
  transcriptVersion: TranscriptVersion | null,
  hasSummary: boolean,
  exportedAt: Date,
): string {
  const participants = meeting.participants.length ? meeting.participants.join('、') : '（未指定）';
  const tags = meeting.tags.length ? meeting.tags.map((tag) => tag.name).join('、') : '（無）';
  return [
    `# ${meeting.title.trim() || '未命名會議'}`,
    '',
    `- 會議日期：${meeting.meeting_date ? formatMeetingDisplayDate(meeting.meeting_date) : '（未指定）'}`,
    `- 分類：${meeting.category_name || '（未分類）'}`,
    `- 與會者：${participants}`,
    `- 標籤：${tags}`,
    `- 錄音段數：${recordings.length}`,
    `- 逐字稿版本：${transcriptVersion ? getTranscriptVersionLabel(transcriptVersion) : '無'}`,
    `- 會議摘要：${hasSummary ? '有' : '無'}`,
    `- 匯出時間：${exportedAt.toLocaleString('zh-TW')}`,
    '',
  ].join('\n');
}

function buildTranscriptMarkdownContent(
  meetingTitle: string,
  meetingDate: string,
  version: TranscriptVersion,
  text: string,
  recordings: Recording[],
  speakerMappings: SpeakerMapping[],
): string {
  const normalizedTitle = meetingTitle.trim() || '未命名會議';
  const transcriptText = text.trim() || '（無逐字稿內容）';
  const speakerReference = buildTranscriptSpeakerReference(recordings, speakerMappings);
  return [
    `# ${normalizedTitle} 逐字稿`,
    '',
    `- 會議日期：${formatMeetingDisplayDate(meetingDate)}`,
    `- 版本：${getTranscriptVersionLabel(version)}`,
    '',
    ...(speakerReference ? [speakerReference] : ['## 內容', '']),
    buildCodeFence(transcriptText, 'text'),
    '',
  ].join('\n');
}

function shouldFollowManualBase(
  transcript: Transcript,
  recordings: Recording[],
): transcript is Transcript & { manual_content: string; manual_base_version: ManualBaseVersion } {
  if (!transcript.manual_content || !transcript.manual_base_version) {
    return false;
  }

  const baseText = getTranscriptBaseText(transcript, recordings, transcript.manual_base_version);
  if (!baseText.trim()) {
    return false;
  }

  return normalizeTranscriptStructure(transcript.manual_content) === normalizeTranscriptStructure(baseText);
}

function getTranscriptDisplayText(
  transcript: Transcript,
  recordings: Recording[],
  version: TranscriptVersion,
  speakerMappings: SpeakerMapping[],
): string {
  if (version !== 'manual' && hasScopedTranscriptText(recordings, version)) {
    return buildGeneratedTranscriptText(recordings, version, speakerMappings);
  }

  if (version === 'manual') {
    if (!transcript.manual_content) {
      return '';
    }

    if (shouldFollowManualBase(transcript, recordings)) {
      return getTranscriptDisplayText(
        transcript,
        recordings,
        transcript.manual_base_version,
        speakerMappings,
      );
    }

    return mapSpeakerLabelsInText(
      transcript.manual_content,
      buildGlobalSpeakerLabelMapper(recordings, speakerMappings),
    );
  }

  return getTranscriptVersionText(transcript, version);
}

function getTranscriptRenderText(
  transcript: Transcript,
  recordings: Recording[],
  version: TranscriptVersion,
): string {
  if (version === 'manual') {
    if (!transcript.manual_content) return '';
    if (shouldFollowManualBase(transcript, recordings)) {
      return getTranscriptVersionText(transcript, transcript.manual_base_version);
    }
    return transcript.manual_content;
  }

  return getTranscriptVersionText(transcript, version);
}

async function exportTextFile(
  text: string,
  defaultPath: string,
  filterName: string,
  extension: string,
): Promise<boolean> {
  const path = await saveDialog({
    defaultPath,
    filters: [{ name: filterName, extensions: [extension] }],
  });

  if (!path) {
    return false;
  }

  await exportTextFileToPath(path, text);
  return true;
}

function getSegmentProofreadProgress(recordings: Recording[]): { proofreadCount: number; transcribedCount: number } {
  const transcribedCount = recordings.filter((recording) => Boolean(recording.segment_transcript)).length;
  const proofreadCount = recordings.filter((recording) => Boolean(recording.segment_proofread)).length;
  return { proofreadCount, transcribedCount };
}

function buildProcessingLabel(meetingTitle: string, actionLabel: string, segmentIndex?: number): string {
  const parts = [meetingTitle.trim() || '未命名會議'];
  if (segmentIndex !== undefined) {
    parts.push(`段落${segmentIndex}`);
  }
  parts.push(actionLabel);
  return parts.join('-');
}

function getNotificationMeetingTitle(meetingTitle: string): string {
  return meetingTitle.trim() || '未命名會議';
}

function notifyTranscriptionCompleted(meetingTitle: string, segmentIndex: number, hasMultipleSegments: boolean): void {
  const title = 'VoxNote 轉譯完成';
  const body = hasMultipleSegments
    ? `${getNotificationMeetingTitle(meetingTitle)} 的段落 ${segmentIndex} 已完成轉譯`
    : `${getNotificationMeetingTitle(meetingTitle)} 已完成轉譯`;
  void notifyCompletion({ title, body });
}

function notifyFullProofreadCompleted(meetingTitle: string, warning: string | null): void {
  void notifyCompletion({
    title: 'VoxNote AI 校稿完成',
    body: warning
      ? `${getNotificationMeetingTitle(meetingTitle)} 的 AI 校稿已完成，但結果可能不完整`
      : `${getNotificationMeetingTitle(meetingTitle)} 的 AI 校稿已完成`,
  });
}

function notifySegmentProofreadCompleted(meetingTitle: string, segmentIndex: number, warning: string | null): void {
  void notifyCompletion({
    title: 'VoxNote 段落校稿完成',
    body: warning
      ? `${getNotificationMeetingTitle(meetingTitle)} 的段落 ${segmentIndex} 已完成校稿，但結果可能不完整`
      : `${getNotificationMeetingTitle(meetingTitle)} 的段落 ${segmentIndex} 已完成校稿`,
  });
}

function notifySummaryCompleted(meetingTitle: string): void {
  void notifyCompletion({
    title: 'VoxNote 摘要完成',
    body: `${getNotificationMeetingTitle(meetingTitle)} 的會議摘要已生成`,
  });
}

function normalizeWarningMessage(warning: string): string {
  return warning.replace(/\s+/g, ' ').trim();
}

function renderTranscriptSegmentInto(
  container: HTMLElement,
  text: string,
  mapSpeakerLabel: (speakerLabel: string) => string = (speakerLabel) => speakerLabel,
  onTimeClick?: (timeInSeconds: number) => void,
): void {
  const lines = text.split('\n');
  const hasTimestamps = lines.some((line) => transcriptUtteranceRe.test(line.trim()));

  if (!hasTimestamps) {
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    container.appendChild(paragraph);
    return;
  }

  for (const line of lines) {
    const match = line.trim().match(transcriptUtteranceRe);
    if (match) {
      const [, time, speaker, body] = match;
      const row = document.createElement('div');
      row.className = 'transcript-row';

      const timeEl = document.createElement('span');
      timeEl.className = 'transcript-time';
      timeEl.textContent = time;
      if (onTimeClick) {
        timeEl.title = '點擊跳轉至此時間點播放';
        timeEl.addEventListener('click', () => onTimeClick(parseTimeToSeconds(time)));
      }

      const textEl = document.createElement('span');
      textEl.className = 'transcript-text';
      if (speaker) {
        const displaySpeaker = mapSpeakerLabel(speaker);
        const speakerEl = document.createElement('span');
        speakerEl.className = `transcript-speaker ${getSpeakerClassName(speaker)}`;
        speakerEl.textContent = `${displaySpeaker}：`;
        textEl.appendChild(speakerEl);
        textEl.appendChild(document.createTextNode(body));
      } else {
        textEl.textContent = body;
      }

      row.appendChild(timeEl);
      row.appendChild(textEl);
      container.appendChild(row);
    } else if (line.trim()) {
      const p = document.createElement('p');
      p.textContent = line;
      container.appendChild(p);
    }
  }
}

function renderTranscriptTextInto(
  container: HTMLElement,
  text: string,
  mapSpeakerLabel: (speakerLabel: string) => string = (speakerLabel) => speakerLabel,
  onTimeClick?: (timeInSeconds: number) => void,
): void {
  container.innerHTML = '';
  renderTranscriptSegmentInto(container, text, mapSpeakerLabel, onTimeClick);
}

function renderGeneratedTranscriptInto(
  container: HTMLElement,
  recordings: Recording[],
  version: TranscriptVersion,
  speakerMappings: SpeakerMapping[],
  getTimeClickHandler?: (recordingId: string) => (timeInSeconds: number) => void,
): void {
  container.innerHTML = '';

  const mappingBySpeaker = buildSpeakerMappingLookup(speakerMappings);
  const segments = getGeneratedTranscriptSegments(recordings, version);

  for (const [index, { recording, text }] of segments.entries()) {
    if (index > 0 && !recording.no_break_before) {
      const divider = document.createElement('div');
      divider.className = 'recording-break-divider';
      divider.textContent = '☕ 中場休息';
      container.appendChild(divider);
    }

    renderTranscriptSegmentInto(
      container,
      text,
      (speakerLabel) => getMappedSpeakerName(mappingBySpeaker, recording.id, speakerLabel),
      getTimeClickHandler?.(recording.id),
    );
  }
}

function getRecordingToggleLabel(recordingCount: number, isCollapsed: boolean): string {
  return `${isCollapsed ? '▼ 展開' : '▲ 收折'}（${recordingCount} 個錄音檔）`;
}

function moveRecording<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex < 0
    || toIndex < 0
    || fromIndex >= items.length
    || toIndex >= items.length
    || fromIndex === toIndex
  ) {
    return items;
  }

  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function chooseManualBaseVersion(
  transcript: Transcript,
  preferred: ManualBaseVersion,
  canUseProofread = Boolean(transcript.proofread_content),
): Promise<ManualBaseVersion | null> {
  return new Promise((resolve) => {
    const content = document.createElement('div');
    content.className = 'form-group-list';

    const group = document.createElement('div');
    group.className = 'form-group';
    const label = document.createElement('label');
    label.textContent = '從哪個版本建立手動編輯版';
    group.appendChild(label);

    const options = document.createElement('div');
    options.className = 'transcript-base-options';

    let selected: ManualBaseVersion = preferred;

    const buildOption = (
      value: ManualBaseVersion,
      title: string,
      description: string,
      disabled = false,
    ): HTMLElement => {
      const optionLabel = document.createElement('label');
      optionLabel.className = 'transcript-base-option';

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'manual-base-version';
      radio.value = value;
      radio.checked = selected === value;
      radio.disabled = disabled;
      radio.addEventListener('change', () => {
        if (radio.checked) selected = value;
      });

      const textWrap = document.createElement('div');
      const titleEl = document.createElement('div');
      titleEl.className = 'transcript-base-option-title';
      titleEl.textContent = title;
      const descEl = document.createElement('small');
      descEl.className = 'form-hint';
      descEl.textContent = description;

      textWrap.appendChild(titleEl);
      textWrap.appendChild(descEl);
      optionLabel.appendChild(radio);
      optionLabel.appendChild(textWrap);
      return optionLabel;
    };

    options.appendChild(buildOption('original', '原始版', '保留 ASR 原始內容作為手動編輯起點'));
    options.appendChild(buildOption(
      'proofread',
      '校稿版',
      canUseProofread ? '以 AI 校稿後內容作為手動編輯起點' : '尚未有校稿版內容',
      !canUseProofread,
    ));

    if (!canUseProofread) {
      selected = 'original';
    }

    group.appendChild(options);
    content.appendChild(group);

    let settled = false;
    const finish = (value: ManualBaseVersion | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    openModal({
      title: '建立手動編輯版',
      content,
      confirmText: '建立',
      cancelText: '取消',
      onConfirm: () => finish(selected),
      onCancel: () => finish(null),
    });
  });
}

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
  recordings: Recording[],
  meetingId: string,
  meetingTitle: string,
  meetingDate: string,
  participants: string[],
  speakerMappings: SpeakerMapping[],
  onSpeakerMappingChanged: (recordingId: string, speakerLabel: string, participantName: string | null) => Promise<void>,
  onSaveManualTranscript: (content: string, baseVersion: ManualBaseVersion) => Promise<Transcript>,
  onRefresh: () => void,
): TranscriptSectionResult {
  const proofreadKey = `proofread:${meetingId}`;
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
    empty.textContent = '尚無逐字稿，請在上方錄音區塊點擊「產生逐字稿」。';
    section.appendChild(empty);
    return { el: section, refreshMappings: () => {}, getExportContent: () => null };
  }

  const loadedTranscript = transcript;
  const hasPersistedProofreadVersion = (): boolean => Boolean(loadedTranscript.proofread_content);
  const mappingBySpeaker = buildSpeakerMappingLookup(speakerMappings);
  let localMappings: SpeakerMapping[] = speakerMappings;
  const mapTranscriptSpeakerLabel = (): ((speakerLabel: string) => string) =>
    buildGlobalSpeakerLabelMapper(recordings, localMappings);

  // 優先使用 DB 記錄的 active_version，但需確認對應內容確實存在
  const dbVersion = loadedTranscript.active_version as TranscriptVersion;
  const initialVersion: TranscriptVersion =
    (dbVersion === 'manual' && loadedTranscript.manual_content) ? 'manual' :
    (dbVersion === 'proofread' && hasPersistedProofreadVersion()) ? 'proofread' :
    loadedTranscript.manual_content ? 'manual' :
    hasPersistedProofreadVersion() ? 'proofread' :
    'original';
  let currentVersion: TranscriptVersion = initialVersion;
  const proofreadProgress = getSegmentProofreadProgress(recordings);
  const hasPartialProofread = proofreadProgress.proofreadCount > 0
    && proofreadProgress.transcribedCount > proofreadProgress.proofreadCount;
  const recordingSpeakerGroups = recordings
    .filter((recording) => Boolean(recording.file_path))
    .map((recording, index) => ({
      recording,
      segmentIndex: index + 1,
      speakerLabels: extractSpeakerLabels(recording.segment_transcript, recording.segment_proofread),
    }))
    .filter((group) => group.speakerLabels.length > 0);

  // 版本切換 Tab
  const tabs = document.createElement('div');
  tabs.className = 'version-tabs';

  const tabButtons = new Map<TranscriptVersion, HTMLButtonElement>();
  const buildTabButton = (
    version: TranscriptVersion,
    label: string,
    disabled = false,
    title?: string,
  ): HTMLButtonElement => {
    const button = document.createElement('button');
    button.className = `tab-btn${currentVersion === version ? ' active' : ''}`;
    button.textContent = label;
    button.disabled = disabled;
    if (title) button.title = title;
    tabButtons.set(version, button);
    tabs.appendChild(button);
    return button;
  };

  const originalBtn = buildTabButton('original', '原始版');
  const proofreadBtn = buildTabButton(
    'proofread',
    '校稿版',
    !hasPersistedProofreadVersion(),
    !hasPersistedProofreadVersion() ? '尚未校稿' : undefined,
  );
  const manualBtn = buildTabButton(
    'manual',
    '手動編輯版',
    !loadedTranscript.manual_content,
    !loadedTranscript.manual_content ? '尚未建立手動編輯版' : undefined,
  );
  section.appendChild(tabs);

  // 內容顯示
  const content = document.createElement('div');
  content.className = 'transcript-content';

  const replaceTranscript = (updated: Transcript): void => {
    Object.assign(loadedTranscript, updated);
    if (hasPersistedProofreadVersion()) {
      proofreadBtn.disabled = false;
      proofreadBtn.title = '';
    } else {
      proofreadBtn.disabled = true;
      proofreadBtn.title = '尚未校稿';
    }
    if (loadedTranscript.manual_content) {
      manualBtn.disabled = false;
      manualBtn.title = '';
    } else {
      manualBtn.disabled = true;
      manualBtn.title = '尚未建立手動編輯版';
    }
  };

  if (recordingSpeakerGroups.length > 0) {
    const mappingPanel = document.createElement('div');
    mappingPanel.className = 'speaker-mapping-panel';

    const mappingTitle = document.createElement('div');
    mappingTitle.className = 'speaker-mapping-title';
    mappingTitle.textContent = '講者對應';
    mappingPanel.appendChild(mappingTitle);

    if (participants.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'empty-hint';
      hint.textContent = '請先在編輯會議新增參與者後，再設定講者對應。';
      mappingPanel.appendChild(hint);
    } else {
      for (const { recording, segmentIndex, speakerLabels } of recordingSpeakerGroups) {
        const groupTitle = document.createElement('div');
        groupTitle.className = 'speaker-mapping-title';
        groupTitle.textContent = recording.original_file_name
          ? `段落 ${segmentIndex}（${recording.original_file_name}）`
          : `段落 ${segmentIndex}`;
        mappingPanel.appendChild(groupTitle);

        const mappingList = document.createElement('div');
        mappingList.className = 'speaker-mapping-list';

        for (const speakerLabel of speakerLabels) {
          const row = document.createElement('label');
          row.className = 'speaker-mapping-row';

          const label = document.createElement('span');
          label.className = `transcript-speaker ${getSpeakerClassName(speakerLabel)}`;
          label.textContent = speakerLabel;

          const select = document.createElement('select');
          select.className = 'form-control speaker-mapping-select';
          let currentParticipant = mappingBySpeaker.get(getSpeakerMappingKey(recording.id, speakerLabel)) ?? '';

          const emptyOption = document.createElement('option');
          emptyOption.value = '';
          emptyOption.textContent = '未指定';
          select.appendChild(emptyOption);

          for (const participant of participants) {
            const option = document.createElement('option');
            option.value = participant;
            option.textContent = participant;
            select.appendChild(option);
          }

          if (currentParticipant && !participants.includes(currentParticipant)) {
            const staleOption = document.createElement('option');
            staleOption.value = currentParticipant;
            staleOption.textContent = `${currentParticipant}（不在參與者）`;
            select.appendChild(staleOption);
          }

          select.value = currentParticipant;
          select.addEventListener('change', async () => {
            const nextParticipant = select.value || null;
            select.disabled = true;
            try {
              await onSpeakerMappingChanged(recording.id, speakerLabel, nextParticipant);
              currentParticipant = nextParticipant ?? '';
              showToast('講者對應已更新', 'success');
            } catch (err) {
              select.value = currentParticipant;
              showToast(`講者對應儲存失敗：${String(err)}`, 'error');
            } finally {
              select.disabled = false;
            }
          });

          row.appendChild(label);
          row.appendChild(select);
          mappingList.appendChild(row);
        }

        mappingPanel.appendChild(mappingList);
      }
    }

    section.appendChild(mappingPanel);
  }

  const getTimeClickHandler = (recordingId: string): (timeInSeconds: number) => void => {
    return (timeInSeconds: number) => {
      const audioEl = document.querySelector<HTMLAudioElement>(
        `audio[data-recording-id="${CSS.escape(recordingId)}"]`,
      );
      if (!audioEl) return;
      const target = isFinite(audioEl.duration) ? Math.min(timeInSeconds, audioEl.duration) : timeInSeconds;
      audioEl.currentTime = target;
      void audioEl.play().catch(() => { /* 忽略播放中斷 */ });
    };
  };

  const getFallbackTimeClickHandler = (): ((timeInSeconds: number) => void) | undefined => {
    const firstRec = recordings.find((r) => r.file_path);
    return firstRec ? getTimeClickHandler(firstRec.id) : undefined;
  };

  function showVersion(version: TranscriptVersion): void {
    currentVersion = version;
    if (version !== 'manual' && hasScopedTranscriptText(recordings, version)) {
      renderGeneratedTranscriptInto(content, recordings, version, localMappings, getTimeClickHandler);
    } else if (
      version === 'manual'
      && shouldFollowManualBase(loadedTranscript, recordings)
      && hasScopedTranscriptText(recordings, loadedTranscript.manual_base_version)
    ) {
      renderGeneratedTranscriptInto(
        content,
        recordings,
        loadedTranscript.manual_base_version,
        localMappings,
        getTimeClickHandler,
      );
    } else {
      renderTranscriptTextInto(
        content,
        getTranscriptRenderText(loadedTranscript, recordings, version),
        mapTranscriptSpeakerLabel(),
        getFallbackTimeClickHandler(),
      );
    }
    for (const [tabVersion, button] of tabButtons) {
      button.classList.toggle('active', tabVersion === version);
    }
  }

  async function ensureManualVersion(
    preferredBaseVersion: ManualBaseVersion,
    openEditorAfterSave = false,
  ): Promise<boolean> {
    const chosenBaseVersion = await chooseManualBaseVersion(
      loadedTranscript,
      preferredBaseVersion,
      hasPersistedProofreadVersion(),
    );
    if (!chosenBaseVersion) return false;

    const baseText = getTranscriptBaseText(loadedTranscript, recordings, chosenBaseVersion);
    if (!baseText) {
      showToast('所選版本目前沒有可建立的逐字稿內容', 'error');
      return false;
    }

    try {
      const updated = await onSaveManualTranscript(baseText, chosenBaseVersion);
      replaceTranscript(updated);
      currentVersion = 'manual';
      showVersion('manual');
      showToast('已建立手動編輯版', 'success');
      if (openEditorAfterSave) {
        openFullscreenViewer('manual', true);
      }
      return true;
    } catch (err) {
      showToast(`建立手動編輯版失敗：${String(err)}`, 'error');
      return false;
    }
  }

  function openFullscreenViewer(initialVersion: TranscriptVersion, startEditing = false): void {
    const overlay = document.createElement('div');
    overlay.className = 'transcript-fullscreen-overlay';

    const panel = document.createElement('div');
    panel.className = 'transcript-fullscreen-panel';

    const topBar = document.createElement('div');
    topBar.className = 'transcript-fullscreen-header';

    const titleWrap = document.createElement('div');
    const title = document.createElement('h3');
    title.className = 'transcript-fullscreen-title';
    title.textContent = '逐字稿全螢幕';
    const meta = document.createElement('div');
    meta.className = 'transcript-fullscreen-meta';
    titleWrap.appendChild(title);
    titleWrap.appendChild(meta);

    const headerActions = document.createElement('div');
    headerActions.className = 'transcript-fullscreen-header-actions';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-ghost btn-sm transcript-icon-btn';
    closeBtn.textContent = '✕';
    closeBtn.title = '關閉全螢幕';
    closeBtn.setAttribute('aria-label', '關閉全螢幕');
    closeBtn.addEventListener('click', () => overlay.remove());
    headerActions.appendChild(closeBtn);

    topBar.appendChild(titleWrap);
    topBar.appendChild(headerActions);

    const versionTabs = document.createElement('div');
    versionTabs.className = 'version-tabs transcript-fullscreen-tabs';

    const body = document.createElement('div');
    body.className = 'transcript-fullscreen-body';

    const footer = document.createElement('div');
    footer.className = 'transcript-fullscreen-footer';

    let overlayVersion: TranscriptVersion = initialVersion;
    let isEditing = startEditing;
    let editorValue = getTranscriptDisplayText(loadedTranscript, recordings, 'manual', localMappings);

    const renderFullscreen = (): void => {
      body.innerHTML = '';
      footer.innerHTML = '';
      versionTabs.innerHTML = '';

      const manualExists = Boolean(loadedTranscript.manual_content);
      const canUseProofread = hasPersistedProofreadVersion();
      const versions: Array<{ version: TranscriptVersion; enabled: boolean; title?: string }> = [
        { version: 'original', enabled: true },
        { version: 'proofread', enabled: canUseProofread, title: canUseProofread ? undefined : '尚未校稿' },
        { version: 'manual', enabled: manualExists, title: manualExists ? undefined : '尚未建立手動編輯版' },
      ];

      for (const item of versions) {
        const btn = document.createElement('button');
        btn.className = `tab-btn${overlayVersion === item.version ? ' active' : ''}`;
        btn.textContent = getTranscriptVersionLabel(item.version);
        btn.disabled = !item.enabled;
        if (item.title) btn.title = item.title;
        btn.addEventListener('click', () => {
          overlayVersion = item.version;
          isEditing = false;
          renderFullscreen();
        });
        versionTabs.appendChild(btn);
      }

      meta.textContent = loadedTranscript.manual_content && overlayVersion === 'manual' && loadedTranscript.manual_base_version
        ? `來源：${getTranscriptVersionLabel(loadedTranscript.manual_base_version)}`
        : getTranscriptVersionLabel(overlayVersion);

      if (isEditing) {
        const hint = document.createElement('p');
        hint.className = 'form-hint transcript-editor-hint';
        hint.textContent = '手動編輯版會獨立保存，不會覆蓋原始版或校稿版。';
        body.appendChild(hint);

        const textarea = document.createElement('textarea');
        textarea.className = 'transcript-editor';
        textarea.value = editorValue;
        textarea.addEventListener('input', () => {
          editorValue = textarea.value;
        });
        body.appendChild(textarea);

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn btn-secondary';
        cancelBtn.textContent = '取消';
        cancelBtn.addEventListener('click', () => {
          isEditing = false;
          editorValue = getTranscriptDisplayText(loadedTranscript, recordings, 'manual', localMappings);
          renderFullscreen();
        });

        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn btn-primary';
        saveBtn.textContent = '儲存手動編輯版';
        saveBtn.addEventListener('click', async () => {
          try {
            const baseVersion = (loadedTranscript.manual_base_version ?? 'original') as ManualBaseVersion;
            const updated = await onSaveManualTranscript(editorValue, baseVersion);
            replaceTranscript(updated);
            overlayVersion = 'manual';
            isEditing = false;
            editorValue = getTranscriptDisplayText(loadedTranscript, recordings, 'manual', localMappings);
            showVersion('manual');
            renderFullscreen();
            showToast('手動編輯版已儲存', 'success');
            onRefresh();
          } catch (err) {
            showToast(`儲存失敗：${String(err)}`, 'error');
          }
        });

        footer.appendChild(cancelBtn);
        footer.appendChild(saveBtn);
        return;
      }

      const viewer = document.createElement('div');
      viewer.className = 'transcript-content transcript-fullscreen-content';
      if (overlayVersion !== 'manual' && hasScopedTranscriptText(recordings, overlayVersion)) {
        renderGeneratedTranscriptInto(viewer, recordings, overlayVersion, localMappings, getTimeClickHandler);
      } else if (
        overlayVersion === 'manual'
        && shouldFollowManualBase(loadedTranscript, recordings)
        && hasScopedTranscriptText(recordings, loadedTranscript.manual_base_version)
      ) {
        renderGeneratedTranscriptInto(
          viewer,
          recordings,
          loadedTranscript.manual_base_version,
          localMappings,
          getTimeClickHandler,
        );
      } else {
        renderTranscriptTextInto(
          viewer,
          getTranscriptRenderText(loadedTranscript, recordings, overlayVersion),
          mapTranscriptSpeakerLabel(),
          getFallbackTimeClickHandler(),
        );
      }
      body.appendChild(viewer);

      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn btn-secondary';
      copyBtn.textContent = '複製目前版本';
      copyBtn.addEventListener('click', () => {
        const text = getTranscriptDisplayText(loadedTranscript, recordings, overlayVersion, localMappings);
        navigator.clipboard.writeText(text).then(() => showToast('已複製到剪貼簿', 'success'));
      });
      footer.appendChild(copyBtn);

      if (overlayVersion === 'manual' && loadedTranscript.manual_content) {
        const editBtn = document.createElement('button');
        editBtn.className = 'btn btn-primary';
        editBtn.textContent = '編輯手動版';
        editBtn.addEventListener('click', () => {
          editorValue = getTranscriptDisplayText(loadedTranscript, recordings, 'manual', localMappings);
          isEditing = true;
          renderFullscreen();
        });
        footer.appendChild(editBtn);
      } else {
        const createBtn = document.createElement('button');
        createBtn.className = 'btn btn-primary';
        createBtn.textContent = '建立手動編輯版';
        createBtn.addEventListener('click', async () => {
          const preferredBaseVersion: ManualBaseVersion = overlayVersion === 'proofread' && hasPersistedProofreadVersion()
            ? 'proofread'
            : 'original';
          const created = await ensureManualVersion(preferredBaseVersion);
          if (created) {
            overlayVersion = 'manual';
            editorValue = getTranscriptDisplayText(loadedTranscript, recordings, 'manual', localMappings);
            isEditing = true;
            renderFullscreen();
          }
        });
        footer.appendChild(createBtn);
      }
    };

    panel.appendChild(topBar);
    panel.appendChild(versionTabs);
    panel.appendChild(body);
    panel.appendChild(footer);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        overlay.remove();
      }
    });

    renderFullscreen();
  }

  showVersion(initialVersion);

  originalBtn.addEventListener('click', async () => {
    try {
      await switchTranscriptVersion(meetingId, 'original');
      showVersion('original');
    } catch {
      showToast('切換失敗', 'error');
    }
  });

  proofreadBtn.addEventListener('click', async () => {
    if (!hasPersistedProofreadVersion()) return;
    try {
      await switchTranscriptVersion(meetingId, 'proofread');
      showVersion('proofread');
    } catch {
      showToast('切換失敗', 'error');
    }
  });

  manualBtn.addEventListener('click', async () => {
    if (!loadedTranscript.manual_content) return;
    try {
      await switchTranscriptVersion(meetingId, 'manual');
      showVersion('manual');
    } catch {
      showToast('切換失敗', 'error');
    }
  });

  section.appendChild(content);

  // 操作按鈕列
  const actions = document.createElement('div');
  actions.className = 'section-actions';

  const fullscreenBtn = document.createElement('button');
  fullscreenBtn.className = 'btn btn-secondary btn-sm transcript-icon-btn';
  fullscreenBtn.textContent = '⛶';
  fullscreenBtn.title = '全螢幕瀏覽';
  fullscreenBtn.setAttribute('aria-label', '全螢幕瀏覽');
  fullscreenBtn.addEventListener('click', () => {
    openFullscreenViewer(currentVersion, false);
  });

  const manualActionBtn = document.createElement('button');
  manualActionBtn.className = 'btn btn-secondary btn-sm';
  manualActionBtn.textContent = loadedTranscript.manual_content ? '編輯手動版' : '建立手動編輯版';
  manualActionBtn.addEventListener('click', async () => {
    if (loadedTranscript.manual_content) {
      openFullscreenViewer('manual', true);
      return;
    }

    const preferredBaseVersion: ManualBaseVersion = hasPersistedProofreadVersion() ? 'proofread' : 'original';
    await ensureManualVersion(preferredBaseVersion, true);
  });

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn btn-secondary btn-sm';
  copyBtn.textContent = '複製';
  copyBtn.addEventListener('click', () => {
    const text = getTranscriptDisplayText(loadedTranscript, recordings, currentVersion, localMappings);
    navigator.clipboard.writeText(text).then(() => {
      showToast('已複製到剪貼簿', 'success');
    });
  });

  const exportMenu = document.createElement('details');
  exportMenu.className = 'export-menu';

  const exportTrigger = document.createElement('summary');
  exportTrigger.className = 'btn btn-secondary btn-sm export-menu-trigger';
  exportTrigger.textContent = '匯出';
  exportTrigger.setAttribute('role', 'button');
  exportTrigger.setAttribute('aria-label', '選擇逐字稿匯出格式');

  const exportOptions = document.createElement('div');
  exportOptions.className = 'export-menu-list';

  const createExportOptionButton = (
    label: string,
    action: () => Promise<void>,
  ): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'export-menu-item';
    button.textContent = label;
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      exportMenu.open = false;
      await action();
    });
    return button;
  };

  exportOptions.appendChild(createExportOptionButton('匯出 TXT', async () => {
    const text = getTranscriptDisplayText(loadedTranscript, recordings, currentVersion, localMappings);
    try {
      const exported = await exportTextFile(
        prependTranscriptSpeakerReference(text, recordings, localMappings),
        buildTranscriptExportFileName(meetingTitle, meetingDate, 'txt'),
        '文字檔',
        'txt',
      );
      if (exported) {
        showToast('逐字稿已匯出', 'success');
      }
    } catch (err) {
      showToast(`匯出失敗：${String(err)}`, 'error');
    }
  }));

  exportOptions.appendChild(createExportOptionButton('匯出 Markdown', async () => {
    const text = getTranscriptDisplayText(loadedTranscript, recordings, currentVersion, localMappings);
    try {
      const exported = await exportTextFile(
        buildTranscriptMarkdownContent(meetingTitle, meetingDate, currentVersion, text, recordings, localMappings),
        buildTranscriptExportFileName(meetingTitle, meetingDate, 'md'),
        'Markdown',
        'md',
      );
      if (exported) {
        showToast('逐字稿已匯出', 'success');
      }
    } catch (err) {
      showToast(`匯出失敗：${String(err)}`, 'error');
    }
  }));

  exportMenu.appendChild(exportTrigger);
  exportMenu.appendChild(exportOptions);

  const proofreadActionBtn = document.createElement('button');
  proofreadActionBtn.className = 'btn btn-primary btn-sm';
  const isProofreading = isProcessing(proofreadKey) || loadedTranscript.proofread_status === 'running';
  proofreadActionBtn.textContent = isProofreading ? '校稿中…' : (hasPersistedProofreadVersion() ? '重新校稿' : 'AI 校稿');
  proofreadActionBtn.disabled = isProofreading;

  if (isProofreading) {
    onProcessingComplete(proofreadKey, onRefresh);
  }

  proofreadActionBtn.addEventListener('click', async () => {
    if (isProcessing(proofreadKey)) return;
    startProcessing(proofreadKey, buildProcessingLabel(meetingTitle, 'AI校稿中'));
    proofreadActionBtn.disabled = true;
    proofreadActionBtn.textContent = '校稿中…';
    showToast('AI 校稿執行中，請稍候…', 'info');
    onProcessingComplete(proofreadKey, onRefresh);
    try {
      const result = await proofreadTranscript(meetingId);
      loadedTranscript.proofread_content = result.content;
      loadedTranscript.proofread_warning = result.warning ?? null;
      proofreadBtn.disabled = false;
      proofreadBtn.title = '';
      await switchTranscriptVersion(meetingId, 'proofread');
      loadedTranscript.active_version = 'proofread';
      showVersion('proofread');
      showToast(
        result.warning
          ? `AI 校稿已完成，但結果可能不完整：${normalizeWarningMessage(result.warning)}`
          : 'AI 校稿完成，已切換至校稿版',
        result.warning ? 'warning' : 'success',
      );
      notifyFullProofreadCompleted(meetingTitle, result.warning ?? null);
      finishProcessing(proofreadKey);
    } catch (err) {
      showToast(`AI 校稿失敗：${String(err)}`, 'error');
      proofreadActionBtn.textContent = hasPersistedProofreadVersion() ? '重新校稿' : 'AI 校稿';
      proofreadActionBtn.disabled = false;
      finishProcessing(proofreadKey, false);
    }
  });

  actions.appendChild(proofreadActionBtn);
  actions.appendChild(manualActionBtn);
  actions.appendChild(fullscreenBtn);
  actions.appendChild(copyBtn);
  actions.appendChild(exportMenu);
  section.appendChild(actions);

  if (hasPartialProofread) {
    const hint = document.createElement('p');
    hint.className = 'form-hint';
    hint.textContent = `目前已完成 ${proofreadProgress.proofreadCount}/${proofreadProgress.transcribedCount} 段校稿；未校稿段落會先顯示原始逐字稿。`;
    section.appendChild(hint);
  }

  if (loadedTranscript.proofread_status === 'interrupted') {
    const hint = document.createElement('p');
    hint.className = 'form-hint';
    hint.textContent = loadedTranscript.proofread_error ?? '上次校稿已中斷，請重新觸發校稿。';
    section.appendChild(hint);
  } else if (loadedTranscript.proofread_status === 'failed' && loadedTranscript.proofread_error) {
    const hint = document.createElement('p');
    hint.className = 'form-hint';
    hint.textContent = `上次校稿失敗：${loadedTranscript.proofread_error}`;
    section.appendChild(hint);
  }

  if (loadedTranscript.proofread_warning) {
    const hint = document.createElement('p');
    hint.className = 'form-hint';
    hint.textContent = `校稿結果可能不完整：${normalizeWarningMessage(loadedTranscript.proofread_warning)}`;
    section.appendChild(hint);
  }

  function refreshMappings(newMappings: SpeakerMapping[]): void {
    localMappings = newMappings;
    showVersion(currentVersion);
  }

  // 以閉包讀取當下的顯示版本與講者對照，確保匯出內容與畫面一致
  function getExportContent(): TranscriptExportContent | null {
    const text = getTranscriptDisplayText(loadedTranscript, recordings, currentVersion, localMappings);
    return {
      fileName: buildTranscriptExportFileName(meetingTitle, meetingDate, 'md'),
      content: buildTranscriptMarkdownContent(
        meetingTitle,
        meetingDate,
        currentVersion,
        text,
        recordings,
        localMappings,
      ),
      version: currentVersion,
    };
  }

  return { el: section, refreshMappings, getExportContent };
}

function buildSummarySection(
  summary: Summary | null,
  meetingId: string,
  meetingTitle: string,
  meetingDate: string,
  onRefresh: () => void,
): HTMLElement {
  const summaryKey = `summary:${meetingId}`;
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
  const isSummaryGenerating = isProcessing(summaryKey);
  generateBtn.textContent = isSummaryGenerating ? '生成中…' : (summary ? '重新生成摘要' : '生成摘要');
  generateBtn.disabled = isSummaryGenerating;

  if (isSummaryGenerating) {
    onProcessingComplete(summaryKey, onRefresh);
  }

  generateBtn.addEventListener('click', async () => {
    if (isProcessing(summaryKey)) return;
    startProcessing(summaryKey, buildProcessingLabel(meetingTitle, 'AI摘要生成中'));
    generateBtn.disabled = true;
    generateBtn.textContent = '生成中…';
    showToast('AI 摘要生成中，請稍候…', 'info');
    onProcessingComplete(summaryKey, onRefresh);
    try {
      const content = await generateSummary(meetingId);
      summary = { id: summary?.id ?? '', meeting_id: meetingId, content, provider: null, created_at: new Date().toISOString() };
      contentDiv.innerHTML = renderMarkdown(content);
      generateBtn.textContent = '重新生成摘要';
      if (!copyBtn.isConnected) actions.appendChild(copyBtn);
      if (!exportBtn.isConnected) actions.appendChild(exportBtn);
      showToast('會議摘要已生成', 'success');
      notifySummaryCompleted(meetingTitle);
      finishProcessing(summaryKey);
    } catch (err) {
      showToast(`摘要生成失敗：${String(err)}`, 'error');
      generateBtn.textContent = summary ? '重新生成摘要' : '生成摘要';
      generateBtn.disabled = false;
      finishProcessing(summaryKey, false);
    }
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
  exportBtn.textContent = '匯出 Markdown';
  exportBtn.addEventListener('click', async () => {
    try {
      const exported = await exportTextFile(
        summary?.content ?? '',
        buildSummaryExportFileName(meetingTitle, meetingDate),
        'Markdown',
        'md',
      );
      if (exported) {
        showToast('摘要已匯出', 'success');
      }
    } catch (err) {
      showToast(`匯出失敗：${String(err)}`, 'error');
    }
  });

  actions.appendChild(generateBtn);
  if (summary) {
    actions.appendChild(copyBtn);
    actions.appendChild(exportBtn);
  }
  section.appendChild(actions);

  return section;
}

function buildRecordingSection(
  recordings: Recording[],
  meetingId: string,
  meetingTitle: string,
  isCollapsed: boolean,
  onCollapseChanged: (collapsed: boolean) => void,
  onTranscribed: (recordingId: string) => void,
  onDeleted: (id: string) => Promise<void>,
  onReordered: (recordingId: string, direction: -1 | 1) => Promise<void>,
  onSegmentProofread: (recordingId: string) => Promise<{ warning: string | null }>,
  onBreakChanged: () => void,
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'detail-section';

  const header = document.createElement('div');
  header.className = 'section-header';
  const heading = document.createElement('h3');
  heading.textContent = '錄音';
  header.appendChild(heading);
  section.appendChild(header);

  const validRecordings = recordings.filter((r) => r.file_path);

  if (validRecordings.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'empty-hint';
    hint.textContent = '尚無錄音檔案。';
    section.appendChild(hint);

    const goBtn = document.createElement('button');
    goBtn.className = 'btn btn-secondary btn-sm';
    goBtn.textContent = '前往錄音';
    goBtn.addEventListener('click', () => {
      window.location.hash = `#record/${meetingId}`;
    });
    section.appendChild(goBtn);
    return section;
  }

  // 收折功能（2段以上才顯示）
  let collapsed = validRecordings.length >= 2 ? isCollapsed : false;
  const recordingList = document.createElement('div');
  recordingList.className = 'recording-list';
  recordingList.classList.toggle('hidden', collapsed);

  if (validRecordings.length >= 2) {
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn btn-ghost btn-sm recording-collapse-btn';
    toggleBtn.textContent = getRecordingToggleLabel(validRecordings.length, collapsed);
    toggleBtn.addEventListener('click', () => {
      collapsed = !collapsed;
      recordingList.classList.toggle('hidden', collapsed);
      toggleBtn.textContent = getRecordingToggleLabel(validRecordings.length, collapsed);
      onCollapseChanged(collapsed);
    });
    header.appendChild(toggleBtn);
  }

  for (let i = 0; i < validRecordings.length; i++) {
    const rec = validRecordings[i]!;
    const segIndex = i + 1;
    const transcribeKey = `transcribe:${rec.id}`;
    const segmentProofreadKey = `proofread-segment:${rec.id}`;

    const segWrap = document.createElement('div');
    segWrap.className = 'recording-segment';

    // 段落標題列
    const segHeader = document.createElement('div');
    segHeader.className = 'recording-segment-header';

    const segTitle = document.createElement('span');
    segTitle.className = 'recording-segment-title';
    segTitle.textContent = validRecordings.length > 1 ? `段落 ${segIndex}` : '錄音檔';
    segHeader.appendChild(segTitle);

    if (rec.duration_seconds !== null) {
      const dur = document.createElement('span');
      dur.className = 'recording-segment-duration';
      const m = Math.floor(rec.duration_seconds / 60);
      const s = rec.duration_seconds % 60;
      dur.textContent = `${m}:${String(s).padStart(2, '0')}`;
      segHeader.appendChild(dur);
    }

    // 轉譯狀態標籤
    const statusBadge = document.createElement('span');
    const isTranscribing = isProcessing(transcribeKey);
    statusBadge.className = `recording-segment-status ${isTranscribing ? 'processing' : rec.segment_transcript ? 'transcribed' : 'pending'}`;
    statusBadge.textContent = isTranscribing ? '轉譯中' : rec.segment_transcript ? '已轉譯' : '未轉譯';
    segHeader.appendChild(statusBadge);

    segWrap.appendChild(segHeader);

    if (rec.original_file_name) {
      const originalFileName = document.createElement('div');
      originalFileName.className = 'form-hint';
      originalFileName.textContent = `原始檔名：${rec.original_file_name}`;
      segWrap.appendChild(originalFileName);
    }

    // 播放器
    const audioEl = document.createElement('audio');
    audioEl.preload = 'metadata';
    audioEl.style.display = 'none';
    audioEl.dataset.recordingId = rec.id;
    void resolveRecordingSource(rec.file_path!).then((src) => {
      if (audioEl.dataset.recordingId === rec.id) {
        // crossOrigin 必須早於 src 設定才會生效。asset 協定與本頁不同源，
        // 未以 CORS 模式載入時播放增益會因規範限制而被消音。
        applyMediaCrossOrigin(audioEl, src);
        audioEl.src = src;
      }
    }).catch((err) => {
      showToast(`載入錄音失敗：${String(err)}`, 'error');
    });
    const playerEl = createWaveformPlayer(audioEl);
    segWrap.appendChild(audioEl);
    segWrap.appendChild(playerEl);

    // 操作列
    const segActions = document.createElement('div');
    segActions.className = 'recording-segment-actions';

    if (validRecordings.length > 1) {
      const moveUpBtn = document.createElement('button');
      moveUpBtn.className = 'btn btn-ghost btn-sm';
      moveUpBtn.textContent = '↑ 上移';
      moveUpBtn.disabled = i === 0;
      moveUpBtn.addEventListener('click', async () => {
        try {
          await onReordered(rec.id, -1);
          showToast(`已將段落 ${segIndex} 往前移動`, 'success');
        } catch (err) {
          showToast(`調整順序失敗：${String(err)}`, 'error');
        }
      });
      segActions.appendChild(moveUpBtn);

      const moveDownBtn = document.createElement('button');
      moveDownBtn.className = 'btn btn-ghost btn-sm';
      moveDownBtn.textContent = '↓ 下移';
      moveDownBtn.disabled = i === validRecordings.length - 1;
      moveDownBtn.addEventListener('click', async () => {
        try {
          await onReordered(rec.id, 1);
          showToast(`已將段落 ${segIndex} 往後移動`, 'success');
        } catch (err) {
          showToast(`調整順序失敗：${String(err)}`, 'error');
        }
      });
      segActions.appendChild(moveDownBtn);
    }

    const transcribeBtn = document.createElement('button');
    transcribeBtn.className = 'btn btn-primary btn-sm';
    if (isTranscribing) {
      transcribeBtn.textContent = '轉譯中…';
      transcribeBtn.disabled = true;
    } else {
      transcribeBtn.textContent = rec.segment_transcript ? '重新轉譯' : '產生逐字稿';
    }
    transcribeBtn.addEventListener('click', async () => {
      const key = `transcribe:${rec.id}`;
      if (isProcessing(key)) return;
      startProcessing(key, buildProcessingLabel(meetingTitle, '轉譯中', segIndex));
      transcribeBtn.disabled = true;
      transcribeBtn.textContent = '轉譯中…';
      statusBadge.className = 'recording-segment-status processing';
      statusBadge.textContent = '轉譯中';
      showToast(`段落 ${segIndex} 轉譯中，請稍候…`, 'info');
      try {
        await startTranscription(meetingId, rec.id, rec.file_path!);
        showToast(
          validRecordings.length > 1
            ? `段落 ${segIndex} 轉譯完成，逐字稿已更新（含中場休息分隔）`
            : '逐字稿已生成',
          'success'
        );
        notifyTranscriptionCompleted(meetingTitle, segIndex, validRecordings.length > 1);
        finishProcessing(key);
        onTranscribed(rec.id);
      } catch (err) {
        showToast(`轉譯失敗：${String(err)}`, 'error');
        finishProcessing(key, false);
        transcribeBtn.disabled = false;
        transcribeBtn.textContent = rec.segment_transcript ? '重新轉譯' : '產生逐字稿';
        statusBadge.className = `recording-segment-status ${rec.segment_transcript ? 'transcribed' : 'pending'}`;
        statusBadge.textContent = rec.segment_transcript ? '已轉譯' : '未轉譯';
      }
    });
    segActions.appendChild(transcribeBtn);

    if (rec.segment_transcript) {
      const segmentProofreadBtn = document.createElement('button');
      segmentProofreadBtn.className = 'btn btn-secondary btn-sm';
      const isSegmentProofreading = isProcessing(segmentProofreadKey);
      segmentProofreadBtn.textContent = isSegmentProofreading
        ? '校稿此段中…'
        : (rec.segment_proofread ? '重新校稿此段' : '校稿此段');
      segmentProofreadBtn.disabled = isSegmentProofreading;
      segmentProofreadBtn.addEventListener('click', async () => {
        if (isProcessing(segmentProofreadKey)) return;
        startProcessing(segmentProofreadKey, buildProcessingLabel(meetingTitle, 'AI校稿中', segIndex));
        segmentProofreadBtn.disabled = true;
        segmentProofreadBtn.textContent = '校稿此段中…';
        showToast(`段落 ${segIndex} 校稿中，請稍候…`, 'info');
        try {
          const result = await onSegmentProofread(rec.id);
          showToast(
            result.warning
              ? `段落 ${segIndex} 校稿已儲存，但結果可能不完整：${normalizeWarningMessage(result.warning)}`
              : `段落 ${segIndex} 校稿完成，已更新校稿版逐字稿`,
            result.warning ? 'warning' : 'success',
          );
          notifySegmentProofreadCompleted(meetingTitle, segIndex, result.warning);
        } catch (err) {
          showToast(`段落校稿失敗：${String(err)}`, 'error');
        }
      });
      segActions.appendChild(segmentProofreadBtn);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-danger btn-sm';
    deleteBtn.textContent = '刪除';
    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`確定要刪除段落 ${segIndex} 的錄音嗎？`)) return;
      try {
        await deleteRecording(rec.id);
        showToast('錄音段落已刪除', 'success');
        await onDeleted(rec.id);
      } catch (err) {
        showToast(`刪除失敗：${String(err)}`, 'error');
      }
    });
    segActions.appendChild(deleteBtn);

    segWrap.appendChild(segActions);
    recordingList.appendChild(segWrap);

    // 段落間的中場休息分隔符（可刪除）
    if (i < validRecordings.length - 1) {
      const nextRec = validRecordings[i + 1]!;
      const breakEl = document.createElement('div');
      breakEl.className = `recording-break-divider${nextRec.no_break_before ? ' removed' : ''}`;

      const breakLabel = document.createElement('span');
      breakLabel.textContent = nextRec.no_break_before ? '（已移除中場休息）' : '☕ 中場休息';
      breakEl.appendChild(breakLabel);

      const breakToggleBtn = document.createElement('button');
      breakToggleBtn.className = 'btn btn-ghost btn-xs break-toggle-btn';
      breakToggleBtn.textContent = nextRec.no_break_before ? '✚ 還原' : '✕ 移除';
      breakToggleBtn.addEventListener('click', async () => {
        const newVal = !nextRec.no_break_before;
        try {
          await setNoBreakBefore(nextRec.id, newVal);
          nextRec.no_break_before = newVal ? 1 : 0;
          breakEl.className = `recording-break-divider${newVal ? ' removed' : ''}`;
          breakLabel.textContent = newVal ? '（已移除中場休息）' : '☕ 中場休息';
          breakToggleBtn.textContent = newVal ? '✚ 還原' : '✕ 移除';
          // 重新合併逐字稿
          await remergeSegments(meetingId);
          showToast(newVal ? '已移除中場休息分隔' : '已還原中場休息分隔', 'success');
          onBreakChanged();
        } catch (err) {
          showToast(`操作失敗：${String(err)}`, 'error');
        }
      });
      breakEl.appendChild(breakToggleBtn);
      recordingList.appendChild(breakEl);
    }
  }

  section.appendChild(recordingList);

  // 前往錄音頁新增段落
  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn-secondary btn-sm recording-add-btn';
  addBtn.textContent = '+ 新增錄音段落';
  addBtn.addEventListener('click', () => {
    window.location.hash = `#record/${meetingId}`;
  });
  section.appendChild(addBtn);

  return section;
}

export async function renderMeetingPage(container: HTMLElement, meetingId: string): Promise<void> {
  container.innerHTML = '<div class="loading">載入中...</div>';

  let meeting: MeetingWithDetails | null = null;
  let categories: Category[] = [];
  let transcript: Transcript | null = null;
  let summary: Summary | null = null;
  let recordings: Recording[] = [];
  let savedParticipants: SavedParticipant[] = [];
  let allTags: Tag[] = [];
  let speakerMappings: SpeakerMapping[] = [];
  let isRecordingListCollapsed = false;
  let currentTranscriptSection: TranscriptSectionResult | null = null;

  try {
    [meeting, categories, transcript, summary, recordings, savedParticipants, allTags, speakerMappings] = await Promise.all([
      getMeeting(meetingId),
      getCategories(),
      getTranscript(meetingId),
      getSummary(meetingId),
      getRecordings(meetingId),
      getSavedParticipants(),
      getTags(),
      getSpeakerMappings(meetingId),
    ]);
  } catch (err) {
    container.innerHTML = `<div class="error-state">載入失敗：${String(err)}</div>`;
    return;
  }

  if (!meeting) {
    container.innerHTML = '<div class="error-state">找不到此會議</div>';
    return;
  }

  isRecordingListCollapsed = recordings.filter((recording) => recording.file_path).length >= 2;

  function build(): void {
    if (!meeting) return;
    if (recordings.filter((recording) => recording.file_path).length < 2) {
      isRecordingListCollapsed = false;
    }
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

    const bundleExportBtn = document.createElement('button');
    bundleExportBtn.className = 'btn btn-secondary btn-sm';
    bundleExportBtn.textContent = '匯出整包';
    bundleExportBtn.title = '將音訊、逐字稿與摘要匯出至指定資料夾';
    bundleExportBtn.addEventListener('click', () => runBundleExport(bundleExportBtn));

    const saveAsTplBtn = document.createElement('button');
    saveAsTplBtn.className = 'btn btn-ghost btn-sm';
    saveAsTplBtn.textContent = '儲存為範本';
    saveAsTplBtn.addEventListener('click', () => openSaveTemplateModal());

    const archiveBtn = document.createElement('button');
    archiveBtn.className = 'btn btn-secondary btn-sm';
    archiveBtn.textContent = meeting.archived_at ? '取消封存' : '封存';
    archiveBtn.addEventListener('click', async () => {
      if (!meeting) return;
      try {
        meeting = meeting.archived_at
          ? await unarchiveMeeting(meeting.id)
          : await archiveMeeting(meeting.id);
        recordings = await getRecordings(meetingId);
        showToast(meeting.archived_at ? '會議已封存' : '已取消封存', 'success');
        build();
      } catch (err) {
        showToast(`操作失敗：${String(err)}`, 'error');
      }
    });

    topBar.appendChild(backBtn);
    topBar.appendChild(titleArea);
    topBar.appendChild(editBtn);
    topBar.appendChild(saveAsTplBtn);
    topBar.appendChild(archiveBtn);
    topBar.appendChild(bundleExportBtn);
    topBar.appendChild(printBtn);
    container.appendChild(topBar);

    // 會議日期
    const displayDate = meeting.meeting_date ?? meeting.created_at;
    const dateBar = document.createElement('div');
    dateBar.className = 'participants-bar';
    const dateBarLabel = document.createElement('span');
    dateBarLabel.className = 'participants-label';
    dateBarLabel.textContent = '日期：';
    const dateChip = document.createElement('span');
    dateChip.className = 'participant-chip';
    dateChip.textContent = new Date(displayDate).toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' });
    dateBar.appendChild(dateBarLabel);
    dateBar.appendChild(dateChip);
    if (meeting.archived_at) {
      const archivedChip = document.createElement('span');
      archivedChip.className = 'participant-chip';
      archivedChip.textContent = `已封存於 ${formatMeetingDisplayDate(meeting.archived_at)}`;
      dateBar.appendChild(archivedChip);
    }
    container.appendChild(dateBar);

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
    container.appendChild(buildRecordingSection(
      recordings,
      meetingId,
      meeting.title,
      isRecordingListCollapsed,
      (collapsed) => {
        isRecordingListCollapsed = collapsed;
      },
      async (recordingId: string) => {
        // 轉譯完成後重新載入 recordings 與逐字稿，修復「未轉譯」badge 殘留的 bug
        if (window.location.hash !== `#meeting/${meetingId}`) return;
        const transcribeKey = `transcribe:${recordingId}`;
        onProcessingComplete(transcribeKey, async () => {
          if (window.location.hash !== `#meeting/${meetingId}`) return;
          try {
            [transcript, recordings] = await Promise.all([
              getTranscript(meetingId),
              getRecordings(meetingId),
            ]);
          } catch { /* ignore */ }
          build();
        });
        try {
          [transcript, recordings] = await Promise.all([
            getTranscript(meetingId),
            getRecordings(meetingId),
          ]);
        } catch { /* ignore */ }
        build();
      },
      async () => {
        [transcript, recordings] = await Promise.all([
          getTranscript(meetingId),
          getRecordings(meetingId),
        ]);
        build();
      },
      async (recordingId, direction) => {
        const visibleRecordings = recordings.filter((recording) => recording.file_path);
        const currentIndex = visibleRecordings.findIndex((recording) => recording.id === recordingId);
        const nextIndex = currentIndex + direction;
        if (currentIndex < 0 || nextIndex < 0 || nextIndex >= visibleRecordings.length) {
          return;
        }

        const reorderedVisible = moveRecording(visibleRecordings, currentIndex, nextIndex);
        const hiddenRecordingIds = recordings
          .filter((recording) => !recording.file_path)
          .map((recording) => recording.id);
        recordings = await reorderRecordings(
          meetingId,
          [...reorderedVisible.map((recording) => recording.id), ...hiddenRecordingIds],
        );
        transcript = await getTranscript(meetingId);
        build();
      },
      async (recordingId) => {
        try {
          const result = await proofreadRecordingSegment(meetingId, recordingId);
          [transcript, recordings] = await Promise.all([
            getTranscript(meetingId),
            getRecordings(meetingId),
          ]);
          if (
            transcript
            && !transcript.proofread_content
            && hasScopedTranscriptText(recordings, 'proofread')
          ) {
            const mergedProofread = buildGeneratedTranscriptText(recordings, 'proofread', []);
            if (mergedProofread.trim()) {
              transcript = await saveTranscriptProofread(meetingId, mergedProofread, 'segment-proofread');
            }
          }
          if (transcript?.proofread_content) {
            transcript = await switchTranscriptVersion(meetingId, 'proofread');
          }
          return { warning: result.warning ?? null };
        } finally {
          finishProcessing(`proofread-segment:${recordingId}`, false);
          try {
            [transcript, recordings] = await Promise.all([
              getTranscript(meetingId),
              getRecordings(meetingId),
            ]);
          } catch { /* ignore */ }
          if (window.location.hash === `#meeting/${meetingId}`) {
            build();
          }
        }
      },
      async () => {
        // 中場休息分隔變更後重新載入逐字稿
        if (window.location.hash !== `#meeting/${meetingId}`) return;
        try {
          transcript = await getTranscript(meetingId);
        } catch { /* ignore */ }
        build();
      },
    ));

    // 逐字稿區塊
    const transcriptSectionResult = buildTranscriptSection(
      transcript,
      recordings,
      meetingId,
      meeting.title,
      displayDate,
      meeting.participants,
      speakerMappings,
      async (recordingId, speakerLabel, participantName) => {
        if (participantName) {
          const saved = await upsertSpeakerMapping(meetingId, recordingId, speakerLabel, participantName);
          const existingIndex = speakerMappings.findIndex(
            (mapping) => mapping.recording_id === recordingId && mapping.speaker_label === speakerLabel,
          );
          if (existingIndex >= 0) {
            speakerMappings[existingIndex] = saved;
          } else {
            speakerMappings.push(saved);
          }
        } else {
          await deleteSpeakerMapping(meetingId, recordingId, speakerLabel);
          speakerMappings = speakerMappings.filter(
            (mapping) => !(mapping.recording_id === recordingId && mapping.speaker_label === speakerLabel),
          );
        }
        currentTranscriptSection?.refreshMappings(speakerMappings);
      },
      async (content, baseVersion) => {
        transcript = await saveTranscriptManual(meetingId, content, baseVersion);
        return transcript;
      },
      async () => {
        if (window.location.hash !== `#meeting/${meetingId}`) return;
        try {
          [transcript, recordings] = await Promise.all([
            getTranscript(meetingId),
            getRecordings(meetingId),
          ]);
        } catch { /* ignore */ }
        build();
      },
    );
    currentTranscriptSection = transcriptSectionResult;
    container.appendChild(transcriptSectionResult.el);

    // 摘要區塊
    container.appendChild(buildSummarySection(summary, meetingId, meeting.title, displayDate, async () => {
      if (window.location.hash !== `#meeting/${meetingId}`) return;
      try {
        summary = await getSummary(meetingId);
      } catch { /* ignore */ }
      build();
    }));
  }

  function confirmOverwrite(folderName: string): Promise<boolean> {
    return new Promise((resolve) => {
      let confirmed = false;
      openModal({
        title: '資料夾已存在',
        content: `「${folderName}」已存在於所選資料夾中。繼續匯出會覆寫其中的同名檔案，其餘檔案保留不動。`,
        confirmText: '覆寫',
        cancelText: '取消',
        onConfirm: () => {
          confirmed = true;
        },
        onCancel: () => resolve(false),
      });
      // modal 關閉後才回報結果，避免確認與取消時序交錯
      const observer = new MutationObserver(() => {
        if (!document.querySelector('.modal-overlay')) {
          observer.disconnect();
          resolve(confirmed);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  async function runBundleExport(button: HTMLButtonElement): Promise<void> {
    if (!meeting) return;

    const transcriptExport = currentTranscriptSection?.getExportContent() ?? null;
    const hasRecordingFile = recordings.some((recording) => recording.file_path);
    if (!hasRecordingFile && !transcriptExport && !summary) {
      showToast('這場會議尚無可匯出的內容', 'info');
      return;
    }

    const parentDir = await openDialog({ directory: true, title: '選擇匯出的目標資料夾' });
    if (typeof parentDir !== 'string') {
      return;
    }

    const folderName = buildExportFolderName(meeting.title, meeting.meeting_date, meeting.created_at);
    const textFiles: ExportTextFile[] = [];

    if (transcriptExport) {
      textFiles.push({ fileName: transcriptExport.fileName, content: transcriptExport.content });
    }

    if (summary) {
      textFiles.push({
        fileName: buildSummaryExportFileName(meeting.title, meeting.meeting_date ?? meeting.created_at),
        content: summary.content,
      });
    }

    textFiles.push({
      fileName: 'meeting-info.md',
      content: buildMeetingInfoContent(
        meeting,
        recordings,
        transcriptExport?.version ?? null,
        Boolean(summary),
        new Date(),
      ),
    });

    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = '匯出中…';

    try {
      let result = await exportMeetingBundle(meetingId, parentDir, folderName, textFiles, false);

      if (result.alreadyExists) {
        // 等待使用者決定期間不應停留在「匯出中…」
        button.textContent = originalLabel;
        const shouldOverwrite = await confirmOverwrite(folderName);
        button.textContent = '匯出中…';
        if (!shouldOverwrite) {
          return;
        }
        result = await exportMeetingBundle(meetingId, parentDir, folderName, textFiles, true);
      }

      if (result.skipped.length) {
        showToast(
          `匯出完成（${result.written} 個檔案）至「${folderName}」，但有項目被跳過：${result.skipped.join('；')}`,
          'warning',
          6000,
        );
      } else {
        showToast(`匯出完成：${result.written} 個檔案已寫入「${folderName}」`, 'success', 4000);
      }
    } catch (err) {
      showToast(`匯出失敗：${String(err)}`, 'error', 5000);
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
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

    // 會議日期
    const dateGroup = document.createElement('div');
    dateGroup.className = 'form-group';
    const dateLabel = document.createElement('label');
    dateLabel.textContent = '會議日期';
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'form-control';
    const currentDate = meeting.meeting_date ?? meeting.created_at;
    dateInput.value = currentDate.substring(0, 10);
    dateGroup.appendChild(dateLabel);
    dateGroup.appendChild(dateInput);

    const categoryGroup = document.createElement('div');
    categoryGroup.className = 'form-group';
    const categoryLabel = document.createElement('label');
    categoryLabel.textContent = '分類';
    const categorySelect = document.createElement('select');
    categorySelect.className = 'form-control';
    const emptyCategoryOption = document.createElement('option');
    emptyCategoryOption.value = '';
    emptyCategoryOption.textContent = '-- 無分類 --';
    categorySelect.appendChild(emptyCategoryOption);
    for (const category of categories) {
      const option = document.createElement('option');
      option.value = category.id;
      option.textContent = category.name;
      option.selected = category.id === (meeting.category_id ?? '');
      categorySelect.appendChild(option);
    }
    categoryGroup.appendChild(categoryLabel);
    categoryGroup.appendChild(categorySelect);

    // 參與者列表編輯器
    const { el: partEditorEl, getParticipants } = buildParticipantEditor(
      meeting.participants,
      savedParticipants,
      {
        allowManageSaved: true,
        onSavedParticipantsChanged: (updated) => {
          savedParticipants = updated;
        },
      }
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
      hint.textContent = '尚無標籤，請先至 ';
      const link = document.createElement('a');
      link.href = '#manage';
      link.textContent = '管理頁面';
      link.addEventListener('click', () => {
        window.location.hash = '#manage';
      });
      hint.appendChild(link);
      hint.appendChild(document.createTextNode(' 新增標籤。'));
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
    form.appendChild(dateGroup);
    form.appendChild(categoryGroup);
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
            category_id: categorySelect.value || null,
            participants,
            tag_ids: Array.from(selectedTagIds),
            meeting_date: dateInput.value || null,
          });
          meeting = updated;
          // 將參與者加入常用清單
          await Promise.all(participants.map((name) => upsertSavedParticipant(name)));
          savedParticipants = await getSavedParticipants();
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
