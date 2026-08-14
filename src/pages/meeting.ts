import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { MeetingWithDetails, Transcript, Summary, Recording, SavedParticipant, CreateTemplateRequest, Tag, SpeakerMapping, Category, ExportTextFile, PendingRecordingUpload } from '../types';
import { getMeeting, getCategories, updateMeeting, archiveMeeting, unarchiveMeeting } from '../api/meetings';
import { exportTextFileToPath, getTranscript, saveTranscriptManual, saveTranscriptProofread, switchTranscriptVersion } from '../api/transcripts';
import { getSummary } from '../api/summaries';
import { getRecordings, deleteRecording, setNoBreakBefore, reorderRecordings, remergeSegments, importRecordingFiles } from '../api/recordings';
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

interface TranscriptDraftRow {
  id: string;
  recordingId: string;
  segmentIndex: number;
  time: string;
  speakerLabel?: string;
  text: string;
  noBreakBefore: boolean;
  timeHint?: string;
}

interface TranscriptDraftParseResult {
  rows: TranscriptDraftRow[];
  reason?: string;
}

interface TranscriptSegmentSource {
  recording: Recording;
  segmentIndex: number;
  text: string;
}

const manualDraftParseCache = new Map<string, TranscriptDraftParseResult>();
const MANUAL_DRAFT_CACHE_LIMIT = 6;

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

function isSpeakerLabel(value: string | undefined): value is string {
  return Boolean(value?.trim().startsWith('講者'));
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
  recordingId?: string,
  recordings: Recording[] = [],
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
      if (recordingId) row.dataset.recordingId = recordingId;
      if (speaker) row.dataset.speakerLabel = speaker;

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
        speakerEl.className = `transcript-speaker ${recordingId
          ? getSpeakerScopeClassName(recordings, recordingId, speaker)
          : getSpeakerClassName(speaker)}`;
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
  recordingId?: string,
  recordings: Recording[] = [],
): void {
  container.innerHTML = '';
  renderTranscriptSegmentInto(container, text, mapSpeakerLabel, onTimeClick, recordingId, recordings);
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
    const segmentBadge = document.createElement('div');
    segmentBadge.className = 'transcript-segment-badge';
    segmentBadge.dataset.recordingId = recording.id;
    segmentBadge.dataset.segmentIndex = String(recordings.findIndex((item) => item.id === recording.id) + 1);
    segmentBadge.textContent = recordings.length > 1
      ? `段落 ${recordings.findIndex((item) => item.id === recording.id) + 1}`
      : '錄音內容';
    container.appendChild(segmentBadge);

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
      recording.id,
      recordings,
    );
  }
}

function renderDraftRowsInto(
  container: HTMLElement,
  rows: TranscriptDraftRow[],
  recordings: Recording[],
  speakerMappings: SpeakerMapping[],
  getTimeClickHandler: (recordingId: string) => (timeInSeconds: number) => void,
): void {
  container.innerHTML = '';
  const mappingBySpeaker = buildSpeakerMappingLookup(speakerMappings);
  let previousRecordingId = '';

  for (const rowData of rows) {
    if (rowData.recordingId !== previousRecordingId) {
      if (previousRecordingId && !rowData.noBreakBefore) {
        const divider = document.createElement('div');
        divider.className = 'recording-break-divider';
        divider.textContent = '☕ 中場休息';
        container.appendChild(divider);
      }
      const badge = document.createElement('div');
      badge.className = 'transcript-segment-badge';
      badge.dataset.recordingId = rowData.recordingId;
      badge.dataset.segmentIndex = String(rowData.segmentIndex);
      badge.textContent = recordings.length > 1 ? `段落 ${rowData.segmentIndex}` : '錄音內容';
      container.appendChild(badge);
      previousRecordingId = rowData.recordingId;
    }

    const row = document.createElement('div');
    row.className = 'transcript-row';
    row.dataset.recordingId = rowData.recordingId;
    if (rowData.speakerLabel) row.dataset.speakerLabel = rowData.speakerLabel;

    const time = document.createElement('span');
    time.className = 'transcript-time';
    time.textContent = rowData.time;
    time.title = '點擊跳轉至此時間點播放';
    time.addEventListener('click', () => {
      getTimeClickHandler(rowData.recordingId)(parseTimeToSeconds(rowData.time));
    });
    row.appendChild(time);

    const text = document.createElement('span');
    text.className = 'transcript-text';
    if (rowData.speakerLabel) {
      const speaker = document.createElement('span');
      speaker.className = `transcript-speaker ${getSpeakerScopeClassName(recordings, rowData.recordingId, rowData.speakerLabel)}`;
      speaker.textContent = `${getMappedSpeakerName(mappingBySpeaker, rowData.recordingId, rowData.speakerLabel)}：`;
      text.appendChild(speaker);
    }
    text.appendChild(document.createTextNode(rowData.text));
    row.appendChild(text);
    container.appendChild(row);
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

  const getBaseSegments = (baseVersion: ManualBaseVersion): TranscriptSegmentSource[] =>
    getGeneratedTranscriptSegments(recordings, baseVersion).map((segment) => ({
      recording: segment.recording,
      segmentIndex: segment.segmentIndex,
      text: segment.text,
    }));

  const getManualDraftParse = (): TranscriptDraftParseResult => {
    if (!loadedTranscript.manual_content || !loadedTranscript.manual_base_version) {
      return { rows: [], reason: '尚未建立手動版基底' };
    }
    return getCachedManualDraftParse(
      loadedTranscript.manual_content,
      getBaseSegments(loadedTranscript.manual_base_version),
    );
  };

  const getSpeakerLabelsForRecording = (recordingId: string): string[] => {
    const labels = new Set<string>();
    const recording = recordings.find((item) => item.id === recordingId);
    for (const label of extractSpeakerLabels(recording?.segment_transcript, recording?.segment_proofread)) labels.add(label);
    for (const row of getManualDraftParse().rows) {
      if (row.recordingId === recordingId && isSpeakerLabel(row.speakerLabel)) labels.add(row.speakerLabel);
    }
    for (const mapping of localMappings) {
      if (mapping.recording_id === recordingId && isSpeakerLabel(mapping.speaker_label)) labels.add(mapping.speaker_label);
    }
    return Array.from(labels).sort((left, right) => left.localeCompare(right));
  };

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

  const scrollTranscriptTo = (recordingId: string, speakerLabel?: string, root: HTMLElement = content): void => {
    const escapedRecordingId = CSS.escape(recordingId);
    const selector = speakerLabel
      ? `.transcript-row[data-recording-id="${escapedRecordingId}"][data-speaker-label="${CSS.escape(speakerLabel)}"], .structured-editor-row[data-recording-id="${escapedRecordingId}"][data-speaker-label="${CSS.escape(speakerLabel)}"]`
      : `.transcript-segment-badge[data-recording-id="${escapedRecordingId}"], .structured-editor-segment[data-recording-id="${escapedRecordingId}"]`;
    const target = root.querySelector<HTMLElement>(selector);
    if (!target) {
      showToast('目前逐字稿版本沒有可定位的錄音段落資訊', 'info');
      return;
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const buildSpeakerMappingPanel = (
    onJump: (recordingId: string, speakerLabel?: string) => void,
    open = true,
  ): HTMLElement | null => {
    if (recordingSpeakerGroups.length === 0) return null;
    const mappingPanel = document.createElement('details');
    mappingPanel.className = 'speaker-mapping-panel';
    mappingPanel.open = open;

    const mappingTitle = document.createElement('summary');
    mappingTitle.className = 'speaker-mapping-title speaker-mapping-summary';
    mappingTitle.textContent = '講者對應';
    mappingPanel.appendChild(mappingTitle);

    if (participants.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'empty-hint';
      hint.textContent = '請先在編輯會議新增參與者後，再設定講者對應。';
      mappingPanel.appendChild(hint);
    } else {
      for (const { recording, segmentIndex } of recordingSpeakerGroups) {
        const speakerLabels = getSpeakerLabelsForRecording(recording.id);
        const groupTitle = document.createElement('button');
        groupTitle.type = 'button';
        groupTitle.className = 'speaker-mapping-title speaker-mapping-segment-link';
        groupTitle.textContent = recording.original_file_name
          ? `段落 ${segmentIndex}（${recording.original_file_name}）`
          : `段落 ${segmentIndex}`;
        groupTitle.title = `跳至段落 ${segmentIndex} 開始`;
         groupTitle.addEventListener('click', () => onJump(recording.id));
        mappingPanel.appendChild(groupTitle);

        const mappingList = document.createElement('div');
        mappingList.className = 'speaker-mapping-list';

        for (const speakerLabel of speakerLabels) {
          const row = document.createElement('label');
          row.className = 'speaker-mapping-row';

          const label = document.createElement('span');
           label.className = `transcript-speaker ${getSpeakerScopeClassName(recordings, recording.id, speakerLabel, speakerLabels)}`;
           label.dataset.recordingId = recording.id;
           label.textContent = speakerLabel;
           label.title = `跳至段落 ${segmentIndex} 的${speakerLabel}首次發言`;
           label.tabIndex = 0;
           label.setAttribute('role', 'button');
           const jumpToSpeaker = (event: Event): void => {
             event.preventDefault();
             event.stopPropagation();
             onJump(recording.id, speakerLabel);
           };
           label.addEventListener('click', jumpToSpeaker);
           label.addEventListener('keydown', (event) => {
             if (event instanceof KeyboardEvent && (event.key === 'Enter' || event.key === ' ')) jumpToSpeaker(event);
           });

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

    return mappingPanel;
  };

  const mappingPanel = buildSpeakerMappingPanel((recordingId, speakerLabel) =>
    scrollTranscriptTo(recordingId, speakerLabel),
  );
  if (mappingPanel) section.appendChild(mappingPanel);

  const getTimeClickHandler = (recordingId: string): (timeInSeconds: number) => void => {
    return (timeInSeconds: number) => {
      const audioEl = document.querySelector<HTMLAudioElement>(
        `audio[data-recording-id="${CSS.escape(recordingId)}"]`,
      );
      if (!audioEl || !audioEl.src) {
        showToast('找不到此逐字稿列所屬的錄音', 'warning');
        return;
      }
      const target = isFinite(audioEl.duration) ? Math.min(Math.max(0, timeInSeconds), audioEl.duration) : Math.max(0, timeInSeconds);
      audioEl.currentTime = target;
      void audioEl.play().catch((error) => {
        showToast(`錄音播放失敗：${String(error)}`, 'warning');
      });
    };
  };

  const renderManualTranscript = (container: HTMLElement): boolean => {
    const parsed = getManualDraftParse();
    if (parsed.reason || parsed.rows.length === 0) return false;
    renderDraftRowsInto(container, parsed.rows, recordings, localMappings, getTimeClickHandler);
    return true;
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
    } else if (version === 'manual' && renderManualTranscript(content)) {
      // 可安全解析的手動版逐列保留錄音來源，時間戳可精確播放。
    } else {
      renderTranscriptTextInto(
          content,
          getTranscriptRenderText(loadedTranscript, recordings, version),
          mapTranscriptSpeakerLabel(),
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
    type ManualEditMode = 'structured' | 'text';
    let editMode: ManualEditMode = 'structured';
    let draftText = getTranscriptRenderText(loadedTranscript, recordings, 'manual');
    let draftRows: TranscriptDraftRow[] | null = null;
    let lastSavedText = draftText;
    let structuredError = '';

    const getDraftBaseSegments = (): TranscriptSegmentSource[] => {
      const baseVersion = loadedTranscript.manual_base_version ?? 'original';
      return getGeneratedTranscriptSegments(recordings, baseVersion).map((segment) => ({
        recording: segment.recording,
        segmentIndex: segment.segmentIndex,
        text: segment.text,
      }));
    };

    const initializeDraft = (): void => {
      draftText = getTranscriptRenderText(loadedTranscript, recordings, 'manual');
      lastSavedText = draftText;
      const result = getCachedManualDraftParse(draftText, getDraftBaseSegments());
      draftRows = result.reason ? null : result.rows;
      structuredError = result.reason ?? '';
      editMode = draftRows ? 'structured' : 'text';
    };

    const syncDraftTextFromRows = (): void => {
      if (draftRows) draftText = serializeDraftRows(draftRows, recordings);
    };

    const getDraftSpeakerLabels = (recordingId: string): string[] => {
      const labels = new Set(getSpeakerLabelsForRecording(recordingId));
      for (const row of draftRows ?? []) {
        if (row.recordingId === recordingId && isSpeakerLabel(row.speakerLabel)) labels.add(row.speakerLabel);
      }
      return Array.from(labels).sort((left, right) => left.localeCompare(right));
    };

    const getNextSpeakerLabel = (recordingId: string): string => {
      const used = new Set(getDraftSpeakerLabels(recordingId));
      for (let index = 0; index < 26; index += 1) {
        const label = `講者${String.fromCharCode(65 + index)}`;
        if (!used.has(label)) return label;
      }
      let index = 1;
      while (used.has(`講者${index}`)) index += 1;
      return `講者${index}`;
    };

    const getTimeError = (row: TranscriptDraftRow, value: string): string => {
      if (!/^\d+:\d{2}$/.test(value.trim())) return '格式須為分:秒，例如 02:05';
      const seconds = parseTimeToSeconds(value);
      if (!Number.isFinite(seconds) || seconds < 0) return '時間不可為負值';
      const recording = recordings.find((item) => item.id === row.recordingId);
      if (recording?.duration_seconds !== null && recording?.duration_seconds !== undefined && seconds > recording.duration_seconds) {
        return '時間不可超出所屬錄音長度';
      }
      return '';
    };

    const validateDraftRows = (): string => {
      for (const row of draftRows ?? []) {
        const error = getTimeError(row, row.time);
        if (error) return error;
        if (!row.text.trim()) return '逐字稿列不可為空白';
      }
      return '';
    };

    const focusRowText = (rowId: string): void => {
      window.setTimeout(() => {
        document.querySelector<HTMLTextAreaElement>(`textarea[data-row-id="${CSS.escape(rowId)}"]`)?.focus();
      }, 0);
    };

    const renderStructuredEditor = (editor: HTMLElement): void => {
      editor.innerHTML = '';
      if (!draftRows?.length) {
        const empty = document.createElement('p');
        empty.className = 'empty-hint';
        empty.textContent = structuredError || '沒有可編輯的結構化逐字稿列。';
        editor.appendChild(empty);
        return;
      }

      let currentRecordingId = '';
      for (const row of draftRows) {
        if (row.recordingId !== currentRecordingId) {
          currentRecordingId = row.recordingId;
          const recording = recordings.find((item) => item.id === row.recordingId);
          const heading = document.createElement('div');
          heading.className = 'structured-editor-segment';
          heading.dataset.recordingId = row.recordingId;
          heading.dataset.segmentIndex = String(row.segmentIndex);
          heading.textContent = recordings.length > 1
            ? `段落 ${row.segmentIndex}${recording?.original_file_name ? `（${recording.original_file_name}）` : ''}`
            : '錄音內容';
          editor.appendChild(heading);
        }

        const rowEl = document.createElement('div');
        rowEl.className = `structured-editor-row ${row.speakerLabel
          ? getSpeakerScopeClassName(recordings, row.recordingId, row.speakerLabel, getDraftSpeakerLabels(row.recordingId))
          : ''}`;
        rowEl.dataset.recordingId = row.recordingId;
        if (row.speakerLabel) rowEl.dataset.speakerLabel = row.speakerLabel;

        const timeInput = document.createElement('input');
        timeInput.className = 'structured-editor-time';
        timeInput.type = 'text';
        timeInput.value = row.time;
        timeInput.title = '點擊播放，或直接編輯時間';
        const timeError = getTimeError(row, row.time);
        timeInput.classList.toggle('has-error', Boolean(timeError));
        timeInput.addEventListener('click', (event) => {
          if ((event.target as HTMLInputElement).selectionStart !== (event.target as HTMLInputElement).selectionEnd) return;
          getTimeClickHandler(row.recordingId)(parseTimeToSeconds(row.time));
        });
        timeInput.addEventListener('input', () => {
          row.time = timeInput.value.trim();
          timeInput.classList.toggle('has-error', Boolean(getTimeError(row, row.time)));
        });
        rowEl.appendChild(timeInput);

        const controls = document.createElement('div');
        controls.className = 'structured-editor-controls';
        const speakerSelect = document.createElement('select');
        speakerSelect.className = 'structured-editor-speaker';
        const emptySpeakerOption = document.createElement('option');
        emptySpeakerOption.value = '';
        emptySpeakerOption.textContent = '未指定講者';
        speakerSelect.appendChild(emptySpeakerOption);
        const labels = getDraftSpeakerLabels(row.recordingId);
        for (const label of labels) {
          const option = document.createElement('option');
          option.value = label;
          option.textContent = getSpeakerDisplayLabel(
            buildSpeakerMappingLookup(localMappings),
            row.recordingId,
            label,
          );
          speakerSelect.appendChild(option);
        }
        const addSpeakerOption = document.createElement('option');
        addSpeakerOption.value = '__add_speaker__';
        addSpeakerOption.textContent = '＋新增講者代號（自動產生）';
        speakerSelect.appendChild(addSpeakerOption);
        if (row.speakerLabel) speakerSelect.value = row.speakerLabel;
        speakerSelect.addEventListener('change', () => {
          if (speakerSelect.value === addSpeakerOption.value) {
            row.speakerLabel = getNextSpeakerLabel(row.recordingId);
            renderFullscreen();
            focusRowText(row.id);
            return;
          }
          row.speakerLabel = speakerSelect.value || undefined;
          renderFullscreen();
          focusRowText(row.id);
        });
        controls.appendChild(speakerSelect);
        rowEl.appendChild(controls);

        const textInput = document.createElement('textarea');
        textInput.className = 'structured-editor-text';
        textInput.dataset.rowId = row.id;
        textInput.value = row.text;
        textInput.rows = 2;
        textInput.addEventListener('input', () => {
          row.text = textInput.value;
        });
        rowEl.appendChild(textInput);

        const splitBtn = document.createElement('button');
        splitBtn.className = 'btn btn-ghost btn-xs structured-editor-split';
        splitBtn.type = 'button';
        splitBtn.textContent = '在游標處拆分';
        splitBtn.addEventListener('click', () => {
          const cursor = textInput.selectionStart ?? 0;
          const before = row.text.slice(0, cursor);
          const after = row.text.slice(cursor);
          if (!before.trim() || !after.trim()) {
            showToast('拆分位置前後都必須有文字', 'warning');
            return;
          }
          const audioEl = document.querySelector<HTMLAudioElement>(`audio[data-recording-id="${CSS.escape(row.recordingId)}"]`);
          const isPlaying = Boolean(audioEl && !audioEl.paused && Number.isFinite(audioEl.currentTime));
          const newRow: TranscriptDraftRow = {
            ...row,
            id: `${row.id}-split-${Date.now()}`,
            text: after.trimStart(),
            time: isPlaying ? formatSecondsToTime(audioEl!.currentTime) : row.time,
            timeHint: isPlaying ? undefined : '時間沿用原列，可修改',
          };
          row.text = before.trimEnd();
          const rowIndex = draftRows!.findIndex((item) => item.id === row.id);
          draftRows!.splice(rowIndex + 1, 0, newRow);
          renderFullscreen();
          focusRowText(newRow.id);
        });
        rowEl.appendChild(splitBtn);
        if (row.timeHint) {
          const hint = document.createElement('span');
          hint.className = 'structured-editor-row-hint';
          hint.textContent = row.timeHint;
          rowEl.appendChild(hint);
        }
        editor.appendChild(rowEl);
      }
    };

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
        const editorStatus = document.createElement('span');
        editorStatus.className = 'transcript-editor-status';
        editorStatus.textContent = '手動編輯版會獨立保存，不會覆蓋原始版或校稿版。';
        meta.appendChild(editorStatus);
      }

      if (isEditing) {
        const modeControls = document.createElement('div');
        modeControls.className = 'transcript-editor-mode-controls';
        modeControls.setAttribute('role', 'tablist');
        modeControls.setAttribute('aria-label', '手動編輯模式');
        for (const mode of [
          { value: 'structured' as const, label: '結構化編輯' },
          { value: 'text' as const, label: '純文字編輯' },
        ]) {
          const modeBtn = document.createElement('button');
          modeBtn.type = 'button';
          modeBtn.className = `transcript-editor-mode-tab ${editMode === mode.value ? 'active' : ''}`;
          modeBtn.textContent = mode.label;
          modeBtn.setAttribute('role', 'tab');
          modeBtn.setAttribute('aria-selected', String(editMode === mode.value));
          modeBtn.addEventListener('click', () => {
            if (editMode === mode.value) return;
            if (editMode === 'structured') {
              syncDraftTextFromRows();
            } else if (mode.value === 'structured') {
              const parsed = getCachedManualDraftParse(draftText, getDraftBaseSegments());
              if (parsed.reason) {
                structuredError = parsed.reason;
                showToast(`無法安全切換為結構化編輯：${parsed.reason}`, 'warning');
                return;
              }
              draftRows = parsed.rows;
            }
            editMode = mode.value;
            renderFullscreen();
          });
          modeControls.appendChild(modeBtn);
        }
        body.appendChild(modeControls);

        const editorShell = document.createElement('div');
        editorShell.className = `transcript-editor-shell ${editMode === 'structured' ? 'structured-editor' : ''}`;
        const editorMappingPanel = buildSpeakerMappingPanel(
          (recordingId, speakerLabel) => scrollTranscriptTo(recordingId, speakerLabel, editorShell),
          false,
        );
        if (editorMappingPanel) {
          editorMappingPanel.classList.add('transcript-editor-mapping-panel');
          body.appendChild(editorMappingPanel);
        }
        if (editMode === 'structured') {
          renderStructuredEditor(editorShell);
        } else {
          const textarea = document.createElement('textarea');
          textarea.className = 'transcript-editor';
          textarea.value = draftText;
          const rowCountHint = document.createElement('div');
          rowCountHint.className = 'form-hint transcript-editor-row-count';
          const updateRowCountHint = (): void => {
            const rowCount = draftText.split('\n').filter((line) => transcriptUtteranceRe.test(line.trim())).length;
            rowCountHint.textContent = `目前可辨識逐字稿列：${rowCount}`;
          };
          updateRowCountHint();
          textarea.addEventListener('input', () => {
            draftText = textarea.value;
            structuredError = '';
            updateRowCountHint();
          });
          editorShell.appendChild(textarea);
          editorShell.appendChild(rowCountHint);
        }
        body.appendChild(editorShell);

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn btn-secondary';
        cancelBtn.textContent = '取消';
          cancelBtn.addEventListener('click', () => {
          isEditing = false;
          draftText = lastSavedText;
          draftRows = null;
          structuredError = '';
          renderFullscreen();
        });

        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn btn-primary';
        saveBtn.textContent = '儲存手動編輯版';
        saveBtn.addEventListener('click', async () => {
          try {
            if (editMode === 'structured') syncDraftTextFromRows();
            const validationError = editMode === 'structured' ? validateDraftRows() : '';
            if (validationError) {
              showToast(validationError, 'warning');
              return;
            }
            const baseVersion = (loadedTranscript.manual_base_version ?? 'original') as ManualBaseVersion;
            const updated = await onSaveManualTranscript(draftText, baseVersion);
            replaceTranscript(updated);
            overlayVersion = 'manual';
            isEditing = false;
            lastSavedText = draftText;
            draftRows = null;
            structuredError = '';
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
      } else if (overlayVersion === 'manual' && renderManualTranscript(viewer)) {
        // 可安全解析的手動版逐列保留錄音來源，時間戳可精確播放。
      } else {
        renderTranscriptTextInto(
          viewer,
          getTranscriptRenderText(loadedTranscript, recordings, overlayVersion),
          mapTranscriptSpeakerLabel(),
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
          initializeDraft();
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
            initializeDraft();
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

    if (isEditing) initializeDraft();
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
  pendingUploads: PendingRecordingUpload[],
  isSavingUpload: boolean,
  onPendingUploadsChanged: (saving?: boolean) => void,
  onUploadCompleted: () => Promise<void>,
  // 逐字稿的校稿狀態。前端的處理中狀態存於記憶體，離開頁面即消失，
  // 故重新進入時需改以資料庫狀態判斷背景工作是否仍在進行。
  proofreadStatus?: string,
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'detail-section';

  const header = document.createElement('div');
  header.className = 'section-header';
  const heading = document.createElement('h3');
  heading.textContent = '錄音';
  header.appendChild(heading);

  const uploadBtn = document.createElement('button');
  uploadBtn.className = 'btn btn-secondary btn-sm recording-upload-btn';
  uploadBtn.textContent = '上傳音訊';
  uploadBtn.disabled = isSavingUpload;
  uploadBtn.addEventListener('click', async () => {
    if (isSavingUpload) return;
    const selected = await openDialog({
      multiple: true,
      filters: [{ name: '音訊檔案', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'wma'] }],
    });
    if (!selected) return;
    const selectedPaths = Array.isArray(selected) ? selected : [selected];
    const existingPaths = new Set(pendingUploads.map((item) => normalizeUploadPath(item.sourcePath)));
    let added = false;
    for (const sourcePath of selectedPaths) {
      const normalizedPath = normalizeUploadPath(sourcePath);
      if (existingPaths.has(normalizedPath)) continue;
      existingPaths.add(normalizedPath);
      pendingUploads.push({
        sourcePath,
        originalFileName: getUploadFileName(sourcePath),
        error: null,
      });
      added = true;
    }
    if (added) onPendingUploadsChanged();
  });
  header.appendChild(uploadBtn);
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
  } else {
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

      // 轉譯狀態標籤。除了前端記憶體中的處理狀態，另需反映資料庫記錄的背景校稿，
      // 否則離開頁面再進入時，仍在校稿的段落會被誤標為「轉譯中」。
      const statusBadge = document.createElement('span');
      const isTranscribing = isProcessing(transcribeKey);
      const isBackgroundProofreading = proofreadStatus === 'running' && Boolean(rec.segment_transcript);
      const inProgress = isTranscribing || isBackgroundProofreading;
      statusBadge.className = `recording-segment-status ${inProgress ? 'processing' : rec.segment_transcript ? 'transcribed' : 'pending'}`;
      statusBadge.textContent = isTranscribing
        ? '轉譯中'
        : isBackgroundProofreading
          ? 'AI 校稿中'
          : rec.segment_transcript
            ? '已轉譯'
            : '未轉譯';
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
      } else if (isBackgroundProofreading) {
        // 背景校稿期間不可重新轉譯，否則會與進行中的校稿競寫同一份逐字稿
        transcribeBtn.textContent = 'AI 校稿中…';
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

        // 後端會在轉錄、AI 校稿等階段發出進度事件。長錄音的校稿需分段送交 LLM，
        // 耗時可能遠超轉錄本身，若不顯示階段訊息會讓人誤以為程式卡住。
        const unlistenProgress = await listen<{ meetingId: string; message: string }>(
          'asr_progress',
          (event) => {
            if (event.payload.meetingId !== meetingId) return;
            statusBadge.textContent = event.payload.message;
            transcribeBtn.textContent = event.payload.message;
          },
        );

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
        } finally {
          unlistenProgress();
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
  }

  if (pendingUploads.length > 0) {
    const panel = document.createElement('div');
    panel.className = 'pending-recording-upload';

    const panelTitle = document.createElement('div');
    panelTitle.className = 'pending-recording-upload-title';
    panelTitle.textContent = `待上傳檔案（${pendingUploads.length}）`;
    panel.appendChild(panelTitle);

    const list = document.createElement('div');
    list.className = 'pending-recording-upload-list';
    pendingUploads.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = `pending-recording-upload-row${item.error ? ' has-error' : ''}`;
      const name = document.createElement('span');
      name.className = 'pending-recording-upload-name';
      name.textContent = item.originalFileName;
      name.title = item.sourcePath;
      row.appendChild(name);
      if (item.error) {
        const error = document.createElement('span');
        error.className = 'pending-recording-upload-error';
        error.textContent = item.error;
        row.appendChild(error);
      }
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn btn-ghost btn-sm';
      removeBtn.textContent = '移除';
      removeBtn.disabled = isSavingUpload;
      removeBtn.addEventListener('click', () => {
        if (isSavingUpload) return;
        pendingUploads.splice(index, 1);
        onPendingUploadsChanged();
      });
      row.appendChild(removeBtn);
      list.appendChild(row);
    });
    panel.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'pending-recording-upload-actions';
    const addMoreBtn = document.createElement('button');
    addMoreBtn.className = 'btn btn-secondary btn-sm';
    addMoreBtn.textContent = '加入更多檔案';
    addMoreBtn.disabled = isSavingUpload;
    addMoreBtn.addEventListener('click', () => uploadBtn.click());
    actions.appendChild(addMoreBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-ghost btn-sm';
    cancelBtn.textContent = '取消全部';
    cancelBtn.disabled = isSavingUpload;
    cancelBtn.addEventListener('click', () => {
      if (isSavingUpload) return;
      pendingUploads.splice(0, pendingUploads.length);
      onPendingUploadsChanged();
    });
    actions.appendChild(cancelBtn);

    const saveUploadBtn = document.createElement('button');
    saveUploadBtn.className = 'btn btn-primary btn-sm';
    saveUploadBtn.textContent = isSavingUpload ? '儲存中…' : '儲存錄音';
    saveUploadBtn.disabled = isSavingUpload || pendingUploads.length === 0;
    saveUploadBtn.addEventListener('click', async () => {
      if (isSavingUpload || pendingUploads.length === 0) return;
      onPendingUploadsChanged(true);
      try {
        const result = await importRecordingFiles(meetingId, pendingUploads.map((item) => ({
          sourcePath: item.sourcePath,
          originalFileName: item.originalFileName,
        })));
        const failedByPath = new Map(
          result.results
            .filter((item) => item.error)
            .map((item) => [normalizeUploadPath(item.sourcePath), item.error!]),
        );
        for (let i = pendingUploads.length - 1; i >= 0; i--) {
          const item = pendingUploads[i]!;
          const error = failedByPath.get(normalizeUploadPath(item.sourcePath));
          if (error) item.error = error;
          else pendingUploads.splice(i, 1);
        }
        if (result.successCount > 0) await onUploadCompleted();
        showToast(
          result.failureCount === 0
            ? `已成功儲存 ${result.successCount} 個錄音`
            : result.successCount > 0
              ? `已儲存 ${result.successCount} 個錄音，${result.failureCount} 個失敗`
              : `${result.failureCount} 個錄音皆儲存失敗`,
          result.failureCount === 0 ? 'success' : result.successCount > 0 ? 'warning' : 'error',
        );
      } catch (err) {
        for (const item of pendingUploads) item.error = `批次匯入失敗：${String(err)}`;
        showToast(`儲存錄音失敗：${String(err)}`, 'error');
      } finally {
        onPendingUploadsChanged(false);
      }
    });
    actions.appendChild(saveUploadBtn);
    panel.appendChild(actions);
    section.appendChild(panel);
  }

  return section;
}

function formatSecondsToTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`;
}

function parseUtteranceRows(text: string): Array<{ time: string; speakerLabel?: string; text: string }> | null {
  const rows: Array<{ time: string; speakerLabel?: string; text: string }> = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const match = line.trim().match(transcriptUtteranceRe);
    if (!match) return null;
    const [, time, speakerLabel, body] = match;
    rows.push({ time, speakerLabel: speakerLabel?.trim() || undefined, text: body });
  }
  return rows;
}

function splitTranscriptSegments(text: string): string[] {
  return text.includes(MERGED_BREAK_SEPARATOR)
    ? text.split(MERGED_BREAK_SEPARATOR).map((segment) => segment.trim())
    : [text.trim()];
}

function normalizeTranscriptRowText(text: string): string {
  return text.replace(/\s+/g, '').trim().toLocaleLowerCase();
}

function inferRowsByRecordingSegment(
  manualRows: Array<{ time: string; speakerLabel?: string; text: string }>,
  baseRows: Array<Array<{ time: string; speakerLabel?: string; text: string }>>,
): Array<Array<{ time: string; speakerLabel?: string; text: string }>> | null {
  if (baseRows.length === 1) return [manualRows];

  const totalBaseRows = baseRows.reduce((total, rows) => total + rows.length, 0);
  if (manualRows.length === totalBaseRows) {
    const fixedRows: Array<Array<{ time: string; speakerLabel?: string; text: string }>> = [];
    let offset = 0;
    for (const segmentRows of baseRows) {
      fixedRows.push(manualRows.slice(offset, offset + segmentRows.length));
      offset += segmentRows.length;
    }
    return fixedRows;
  }

  const difference = manualRows.length - totalBaseRows;
  const searchRadius = Math.min(32, Math.max(8, Math.abs(difference) + 6));
  const inferred: Array<Array<{ time: string; speakerLabel?: string; text: string }>> = [];
  let manualOffset = 0;
  let baseOffset = 0;

  for (let segmentIndex = 0; segmentIndex < baseRows.length; segmentIndex += 1) {
    const segmentRows = baseRows[segmentIndex]!;
    if (segmentIndex === baseRows.length - 1) {
      const remaining = manualRows.slice(manualOffset);
      if (!remaining.length) return null;
      inferred.push(remaining);
      break;
    }

    const nextBaseRows = baseRows[segmentIndex + 1]!;
    const expectedBoundary = Math.round(
      (baseOffset + segmentRows.length) + difference * ((baseOffset + segmentRows.length) / Math.max(1, totalBaseRows)),
    );
    const minimumBoundary = manualOffset + 1;
    const remainingSegmentCount = baseRows.length - segmentIndex - 1;
    const maximumBoundary = manualRows.length - remainingSegmentCount;
    const from = Math.max(minimumBoundary, expectedBoundary - searchRadius);
    const to = Math.min(maximumBoundary, expectedBoundary + searchRadius);
    let bestBoundary = -1;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let boundary = from; boundary <= to; boundary += 1) {
      let score = -Math.abs(boundary - expectedBoundary) * 0.05;
      for (let lookahead = 0; lookahead < 4; lookahead += 1) {
        const baseRow = nextBaseRows[lookahead];
        const manualRow = manualRows[boundary + lookahead];
        if (!baseRow || !manualRow) break;
        if (baseRow.time === manualRow.time) score += 3;
        if (normalizeTranscriptRowText(baseRow.text) === normalizeTranscriptRowText(manualRow.text)) score += 4;
        if (baseRow.speakerLabel === manualRow.speakerLabel) score += 1;
      }
      const previousBaseRow = segmentRows[segmentRows.length - 1];
      const previousManualRow = manualRows[boundary - 1];
      if (previousBaseRow && previousManualRow) {
        if (previousBaseRow.time === previousManualRow.time) score += 2;
        if (normalizeTranscriptRowText(previousBaseRow.text) === normalizeTranscriptRowText(previousManualRow.text)) score += 3;
      }
      if (score > bestScore) {
        bestScore = score;
        bestBoundary = boundary;
      }
    }

    if (bestBoundary < 0 || bestScore < 3) return null;
    inferred.push(manualRows.slice(manualOffset, bestBoundary));
    manualOffset = bestBoundary;
    baseOffset += segmentRows.length;
  }

  return inferred.length === baseRows.length ? inferred : null;
}

function parseManualDraftRows(
  manualText: string,
  baseSegments: TranscriptSegmentSource[],
): TranscriptDraftParseResult {
  if (!manualText.trim() || baseSegments.length === 0) {
    return { rows: [], reason: '沒有可供結構化的逐字稿段落' };
  }

  const manualSegments = splitTranscriptSegments(manualText);
  const baseRows = baseSegments.map((segment) => parseUtteranceRows(segment.text));
  const invalidBaseIndex = baseRows.findIndex((rows) => !rows);
  if (invalidBaseIndex >= 0) {
    return { rows: [], reason: `基底逐字稿第 ${baseSegments[invalidBaseIndex]!.segmentIndex} 段包含無法辨識的格式` };
  }

  let rowsBySegment: Array<Array<{ time: string; speakerLabel?: string; text: string }>>;
  if (manualSegments.length === baseSegments.length) {
    rowsBySegment = [];
    for (const [index, segment] of manualSegments.entries()) {
      const parsedRows = parseUtteranceRows(segment);
      if (!parsedRows) {
        return { rows: [], reason: `手動版第 ${baseSegments[index]!.segmentIndex} 段包含無法辨識的文字格式` };
      }
      if (parsedRows.length === 0 && (baseRows[index]?.length ?? 0) > 0) {
        return { rows: [], reason: `手動版第 ${baseSegments[index]!.segmentIndex} 段沒有可辨識列（基底有 ${baseRows[index]!.length} 列）` };
      }
      rowsBySegment.push(parsedRows);
    }
  } else if (manualSegments.length === 1) {
    const allRows = parseUtteranceRows(manualSegments[0]!);
    if (!allRows) return { rows: [], reason: '內容包含自由格式文字，無法安全對應錄音段落' };
    const inferredRows = inferRowsByRecordingSegment(
      allRows,
      baseRows as Array<Array<{ time: string; speakerLabel?: string; text: string }>>,
    );
    if (!inferredRows) {
      const expectedCount = baseRows.reduce((total, rows) => total + (rows?.length ?? 0), 0);
      return {
        rows: [],
        reason: `目前 ${allRows.length} 列、基底 ${expectedCount} 列，且無法只依時間與文字可靠判定錄音段落邊界；這不一定是中場休息，可能是錄音中斷。請確認每列仍保留「[分:秒]」時間格式`,
      };
    }
    rowsBySegment = inferredRows;
  } else {
    return {
      rows: [],
      reason: `手動版有 ${manualSegments.length} 個分隔段落，但基底有 ${baseSegments.length} 段錄音`,
    };
  }

  const rows: TranscriptDraftRow[] = [];
  for (const [segmentOffset, segment] of baseSegments.entries()) {
    for (const [rowOffset, row] of rowsBySegment[segmentOffset]!.entries()) {
      const baseRow = baseRows[segmentOffset]?.[rowOffset];
      const speakerLabel = isSpeakerLabel(row.speakerLabel)
        ? row.speakerLabel
        : isSpeakerLabel(baseRow?.speakerLabel)
          ? baseRow.speakerLabel
          : undefined;
      rows.push({
        id: `${segment.recording.id}-${segmentOffset}-${rowOffset}-${Math.random().toString(36).slice(2, 8)}`,
        recordingId: segment.recording.id,
        segmentIndex: segment.segmentIndex,
        time: row.time,
        speakerLabel,
        text: row.text,
        noBreakBefore: rowOffset === 0 ? Boolean(segment.recording.no_break_before) : true,
      });
    }
  }
  return { rows };
}

function buildManualDraftCacheKey(manualText: string, baseSegments: TranscriptSegmentSource[]): string {
  let hash = 2166136261;
  const updateHash = (value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  };
  updateHash(manualText);
  for (const segment of baseSegments) {
    updateHash(segment.recording.id);
    updateHash(String(segment.segmentIndex));
    updateHash(segment.text);
    updateHash(String(segment.recording.no_break_before));
  }
  return String(hash >>> 0);
}

function cloneManualDraftParseResult(result: TranscriptDraftParseResult): TranscriptDraftParseResult {
  return {
    reason: result.reason,
    rows: result.rows.map((row) => ({ ...row })),
  };
}

function getCachedManualDraftParse(
  manualText: string,
  baseSegments: TranscriptSegmentSource[],
): TranscriptDraftParseResult {
  const key = buildManualDraftCacheKey(manualText, baseSegments);
  const cached = manualDraftParseCache.get(key);
  if (cached) return cloneManualDraftParseResult(cached);

  const parsed = parseManualDraftRows(manualText, baseSegments);
  manualDraftParseCache.set(key, parsed);
  while (manualDraftParseCache.size > MANUAL_DRAFT_CACHE_LIMIT) {
    const oldestKey = manualDraftParseCache.keys().next().value;
    if (oldestKey === undefined) break;
    manualDraftParseCache.delete(oldestKey);
  }
  return cloneManualDraftParseResult(parsed);
}

function serializeDraftRows(rows: TranscriptDraftRow[], recordings: Recording[]): string {
  const grouped = new Map<string, TranscriptDraftRow[]>();
  for (const row of rows) {
    const group = grouped.get(row.recordingId) ?? [];
    group.push(row);
    grouped.set(row.recordingId, group);
  }

  const segments: string[] = [];
  for (const recording of recordings) {
    const segmentRows = grouped.get(recording.id);
    if (!segmentRows?.length) continue;
    segments.push(segmentRows.map((row) => {
      const speaker = row.speakerLabel ? ` ${row.speakerLabel}` : '';
      return `[${row.time}${speaker}] ${row.text}`;
    }).join('\n'));
  }

  return segments.map((segment, index) => {
    if (index === 0) return segment;
    const priorRecordingIds = recordings.filter((item) => grouped.has(item.id));
    const currentRecording = priorRecordingIds[index];
    const firstRow = currentRecording ? grouped.get(currentRecording.id)?.[0] : undefined;
    return firstRow?.noBreakBefore || currentRecording?.no_break_before
      ? `\n\n${segment}`
      : `${MERGED_BREAK_SEPARATOR}${segment}`;
  }).join('');
}

function getSpeakerScopeClassName(
  recordings: Recording[],
  recordingId: string,
  speakerLabel: string,
  extraLabels: string[] = [],
): string {
  const recordingIndex = Math.max(0, recordings.findIndex((recording) => recording.id === recordingId));
  const labels = new Set<string>(extraLabels);
  const recording = recordings.find((item) => item.id === recordingId);
  if (recording) {
    for (const label of extractSpeakerLabels(recording.segment_transcript, recording.segment_proofread)) {
      labels.add(label);
    }
  }
  labels.add(speakerLabel);
  const speakerIndex = Array.from(labels).sort((left, right) => left.localeCompare(right)).indexOf(speakerLabel);
  return `speaker-scope-${(recordingIndex * 3 + Math.max(0, speakerIndex)) % 8 + 1}`;
}

function getSpeakerDisplayLabel(
  mappingBySpeaker: Map<string, string>,
  recordingId: string,
  speakerLabel: string,
): string {
  const participantName = getMappedSpeakerName(mappingBySpeaker, recordingId, speakerLabel);
  return participantName === speakerLabel ? speakerLabel : `${participantName}（${speakerLabel}）`;
}

function normalizeUploadPath(sourcePath: string): string {
  return sourcePath.replace(/\\/g, '/').toLowerCase();
}

function getUploadFileName(sourcePath: string): string {
  return sourcePath.split(/[/\\]/).pop() ?? sourcePath;
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
  let pendingUploads: PendingRecordingUpload[] = [];
  let isSavingUpload = false;
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
      pendingUploads,
      isSavingUpload,
      (saving) => {
        if (typeof saving === 'boolean') isSavingUpload = saving;
        build();
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
      transcript?.proofread_status,
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
