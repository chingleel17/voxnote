import { invoke } from '@tauri-apps/api/core';
import type { SavedParticipant } from '../types';

export const getSavedParticipants = () =>
  invoke<SavedParticipant[]>('get_saved_participants');

export const upsertSavedParticipant = (name: string) =>
  invoke<SavedParticipant>('upsert_saved_participant', { name });

export const deleteSavedParticipant = (id: string) =>
  invoke<void>('delete_saved_participant', { id });
