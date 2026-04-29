import { invoke } from '@tauri-apps/api/core';
import type { Transcript } from '../types';

export const getTranscript = (meetingId: string) => invoke<Transcript | null>('get_transcript', { meetingId });
export const saveTranscriptOriginal = (meetingId: string, content: string) => invoke<Transcript>('save_transcript_original', { meetingId, content });
export const saveTranscriptProofread = (meetingId: string, proofreadContent: string, provider: string) => invoke<Transcript>('save_transcript_proofread', { meetingId, proofreadContent, provider });
export const switchTranscriptVersion = (meetingId: string, version: 'original' | 'proofread') => invoke<Transcript>('switch_transcript_version', { meetingId, version });
