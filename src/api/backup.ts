import { invoke } from '@tauri-apps/api/core';
import type { BackupResult, BackupPreflightResult, BackupImportMode } from '../types';

export const exportFullBackup = (destination: string) =>
  invoke<BackupResult>('export_full_backup', { destination });

export const preflightFullBackup = (source: string) =>
  invoke<BackupPreflightResult>('preflight_full_backup', { source });

export const importFullBackup = (source: string, mode: BackupImportMode) =>
  invoke<BackupResult>('import_full_backup', { source, mode });
