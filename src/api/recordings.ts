import { invoke } from '@tauri-apps/api/core';
import type { Recording } from '../types';

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
