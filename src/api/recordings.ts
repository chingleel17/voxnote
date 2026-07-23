import { invoke } from '@tauri-apps/api/core';
import type {
  Recording,
  RecordingDeviceList,
  RecordingPreview,
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
 * 將音訊位元組寫入磁碟並儲存路徑至 DB
 */
export const writeRecordingFile = (
  meetingId: string,
  fileData: number[],
  fileName: string,
  originalFileName: string | null,
  durationSeconds: number | null,
) => invoke<Recording>('write_recording_file', { meetingId, fileData, fileName, originalFileName, durationSeconds });
export const readRecordingFile = (filePath: string) => invoke<number[]>('read_recording_file', { filePath });
