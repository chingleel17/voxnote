import { invoke } from '@tauri-apps/api/core';
import type { Summary } from '../types';

export const getSummary = (meetingId: string) => invoke<Summary | null>('get_summary', { meetingId });
export const saveSummary = (meetingId: string, content: string, provider: string) => invoke<Summary>('save_summary', { meetingId, content, provider });
