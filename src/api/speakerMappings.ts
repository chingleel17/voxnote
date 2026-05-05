import { invoke } from '@tauri-apps/api/core';
import type { SpeakerMapping } from '../types';

export const getSpeakerMappings = (meetingId: string) =>
  invoke<SpeakerMapping[]>('get_speaker_mappings', { meetingId });

export const upsertSpeakerMapping = (
  meetingId: string,
  speakerLabel: string,
  participantName: string,
) => invoke<SpeakerMapping>('upsert_speaker_mapping', { meetingId, speakerLabel, participantName });

export const deleteSpeakerMapping = (meetingId: string, speakerLabel: string) =>
  invoke<void>('delete_speaker_mapping', { meetingId, speakerLabel });
