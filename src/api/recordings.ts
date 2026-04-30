import { invoke } from '@tauri-apps/api/core';
import type { Recording } from '../types';

export const getRecording = (meetingId: string) => invoke<Recording | null>('get_recording', { meetingId });
export const saveRecording = (meetingId: string, filePath: string, durationSeconds: number | null) => invoke<Recording>('save_recording', { meetingId, filePath, durationSeconds });

/**
 * 將音訊位元組寫入磁碟並儲存路徑至 DB
 * @param fileData - 音訊原始位元組（Array<number>）
 * @param fileName - 儲存的檔案名稱（含副檔名）
 */
export const writeRecordingFile = (
  meetingId: string,
  fileData: number[],
  fileName: string,
  durationSeconds: number | null,
) => invoke<Recording>('write_recording_file', { meetingId, fileData, fileName, durationSeconds });
