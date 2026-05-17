import { invoke } from '@tauri-apps/api/core';
import type { Tag } from '../types';

export async function getTags(): Promise<Tag[]> {
  return invoke<Tag[]>('get_tags');
}

export async function createTag(name: string, color: string): Promise<Tag> {
  return invoke<Tag>('create_tag', { name, color });
}

export async function updateTag(id: string, name: string, color: string): Promise<Tag> {
  return invoke<Tag>('update_tag', { id, name, color });
}

export async function deleteTag(id: string): Promise<void> {
  return invoke<void>('delete_tag', { id });
}

export async function setMeetingTags(meetingId: string, tagIds: string[]): Promise<void> {
  return invoke<void>('set_meeting_tags', { meetingId, tagIds });
}
