import { invoke } from '@tauri-apps/api/core';
import type { MeetingWithDetails, Category, CreateMeetingRequest, UpdateMeetingRequest } from '../types';

export const getMeetings = () => invoke<MeetingWithDetails[]>('get_meetings');
export const getMeeting = (id: string) => invoke<MeetingWithDetails | null>('get_meeting', { id });
export const createMeeting = (request: CreateMeetingRequest) => invoke<MeetingWithDetails>('create_meeting', { request });
export const updateMeeting = (id: string, request: UpdateMeetingRequest) => invoke<MeetingWithDetails>('update_meeting', { id, request });
export const deleteMeeting = (id: string) => invoke<void>('delete_meeting', { id });
export const getCategories = () => invoke<Category[]>('get_categories');
export const createCategory = (name: string) => invoke<Category>('create_category', { name });
export const deleteCategory = (id: string) => invoke<void>('delete_category', { id });
