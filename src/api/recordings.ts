import { invoke } from '@tauri-apps/api/core';
import type {
  Recording,
  RecordingDeviceList,
  RecordingPreview,
  RecordingImportBatchResult,
  RecordingImportItem,
  RecordingSourceMode,
} from '../types';

export interface StartDesktopRecordingRequest {
  mode: RecordingSourceMode;
  microphone_device_id: string | null;
  system_device_id: string | null;
}

export const getRecording = (meetingId: string) => invoke<Recording | null>('get_recording', { meetingId });
export const getRecordings = (meetingId: string) => invoke<Recording[]>('get_recordings', { meetingId });
export const saveRecording = (
  meetingId: string,
  filePath: string,
  originalFileName: string | null,
  durationSeconds: number | null,
) => invoke<Recording>('save_recording', { meetingId, filePath, originalFileName, durationSeconds });
export const deleteRecording = (recordingId: string) => invoke<void>('delete_recording', { recordingId });
export const setNoBreakBefore = (recordingId: string, noBreakBefore: boolean) => invoke<void>('set_no_break_before', { recordingId, noBreakBefore });
export const reorderRecordings = (meetingId: string, recordingIds: string[]) =>
  invoke<Recording[]>('reorder_recordings', { meetingId, recordingIds });
export const remergeSegments = (meetingId: string) => invoke<string>('remerge_segments', { meetingId });
export const listRecordingDevices = () => invoke<RecordingDeviceList>('list_recording_devices');
export const startDesktopRecording = (request: StartDesktopRecordingRequest) =>
  invoke<void>('start_desktop_recording', { request });
export const stopDesktopRecording = () => invoke<RecordingPreview>('stop_desktop_recording');
export const cancelDesktopRecording = () => invoke<void>('cancel_desktop_recording');
export const discardTempRecordingFile = (filePath: string) =>
  invoke<void>('discard_temp_recording_file', { filePath });
export const commitTemporaryRecording = (
  meetingId: string,
  tempFilePath: string,
  originalFileName: string | null,
  durationSeconds: number | null,
  sourceMode: RecordingSourceMode | null,
) =>
  invoke<Recording>('commit_temporary_recording', {
    meetingId,
    tempFilePath,
    originalFileName,
    durationSeconds,
    sourceMode,
  });

/**
 * 將既有音訊檔（來自使用者選檔的真實路徑）複製進 recordings 目錄後存路徑至 DB
 * 全程在檔案系統層完成，不透過 IPC 傳輸位元組，避免大檔案撐爆 webview 記憶體
 */
export const importRecordingFile = (
  meetingId: string,
  sourcePath: string,
  fileName: string,
  originalFileName: string | null,
  durationSeconds: number | null,
) =>
  invoke<Recording>('import_recording_file', {
    meetingId,
    sourcePath,
    fileName,
    originalFileName,
    durationSeconds,
  });

export const importRecordingFiles = (meetingId: string, items: RecordingImportItem[]) =>
  invoke<RecordingImportBatchResult>('import_recording_files', { meetingId, items });
