import { invoke } from '@tauri-apps/api/core';
import type { Recording } from '../types';

export const getRecording = (meetingId: string) => invoke<Recording | null>('get_recording', { meetingId });
export const saveRecording = (meetingId: string, filePath: string, durationSeconds: number | null) => invoke<Recording>('save_recording', { meetingId, filePath, durationSeconds });
