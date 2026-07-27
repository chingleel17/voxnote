import { invoke } from '@tauri-apps/api/core';
import type { ExportTextFile, MeetingExportResult } from '../types';

export const exportMeetingBundle = (
  meetingId: string,
  parentDir: string,
  folderName: string,
  textFiles: ExportTextFile[],
  overwrite: boolean,
) =>
  invoke<MeetingExportResult>('export_meeting_bundle', {
    meetingId,
    parentDir,
    folderName,
    textFiles,
    overwrite,
  });
