import { invoke } from '@tauri-apps/api/core';
import type { MeetingTemplate, CreateTemplateRequest, UpdateTemplateRequest } from '../types';

export const getTemplates = () =>
  invoke<MeetingTemplate[]>('get_meeting_templates');

export const createTemplate = (request: CreateTemplateRequest) =>
  invoke<MeetingTemplate>('create_meeting_template', { request });

export const deleteTemplate = (id: string) =>
  invoke<void>('delete_meeting_template', { id });

export const updateTemplate = (id: string, request: UpdateTemplateRequest) =>
  invoke<MeetingTemplate>('update_meeting_template', { id, request });
