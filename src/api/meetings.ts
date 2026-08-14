import { invoke } from '@tauri-apps/api/core';
import type { MeetingWithDetails, Category, CreateMeetingRequest, UpdateMeetingRequest } from '../types';

const STARTUP_RETRY_DELAYS_MS = [80, 160, 320, 640, 1000];

function isPoolStateStartupError(error: unknown): boolean {
  const message = String(error);
  return message.includes('state not managed') && message.includes('pool');
}

function waitForStartupRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

export async function getMeetings(): Promise<MeetingWithDetails[]> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await invoke<MeetingWithDetails[]>('get_meetings');
    } catch (error) {
      const retryDelay = STARTUP_RETRY_DELAYS_MS[attempt];
      if (!isPoolStateStartupError(error) || retryDelay === undefined) throw error;
      await waitForStartupRetry(retryDelay);
    }
  }
}

export const getArchivedMeetings = () => invoke<MeetingWithDetails[]>('get_archived_meetings');
export const getMeeting = (id: string) => invoke<MeetingWithDetails | null>('get_meeting', { id });
export const createMeeting = (request: CreateMeetingRequest) => invoke<MeetingWithDetails>('create_meeting', { request });
export const updateMeeting = (id: string, request: UpdateMeetingRequest) => invoke<MeetingWithDetails>('update_meeting', { id, request });
export const deleteMeeting = (id: string) => invoke<void>('delete_meeting', { id });
export const archiveMeeting = (id: string) => invoke<MeetingWithDetails>('archive_meeting', { id });
export const unarchiveMeeting = (id: string) => invoke<MeetingWithDetails>('unarchive_meeting', { id });
export const getCategories = () => invoke<Category[]>('get_categories');
export const createCategory = (name: string) => invoke<Category>('create_category', { name });
export const updateCategory = (id: string, name: string) => invoke<Category>('update_category', { id, name });
export const deleteCategory = (id: string) => invoke<void>('delete_category', { id });
