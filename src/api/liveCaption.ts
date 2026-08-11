import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  LiveCaptionBuildInfo,
  LiveCaptionErrorPayload,
  LiveCaptionPayload,
  LiveCaptionSettingsPayload,
  LiveCaptionStatus,
  RecordingDeviceList,
} from '../types';

const LIVE_CAPTION_EVENT = 'live-caption';
const LIVE_CAPTION_ERROR_EVENT = 'live-caption-error';
const LIVE_CAPTION_STATUS_EVENT = 'live-caption-status';
const LIVE_CAPTION_SETTINGS_EVENT = 'live-caption-settings';
const LIVE_CAPTION_INTERACTIVE_EVENT = 'live-caption-interactive';

export const startLiveCaption = (audioSource?: 'microphone' | 'system') =>
  invoke<LiveCaptionStatus>('start_live_caption', {
    request: { audio_source: audioSource ?? null },
  });

export const stopLiveCaption = () => invoke<LiveCaptionStatus>('stop_live_caption');
export const getLiveCaptionStatus = () => invoke<LiveCaptionStatus>('get_live_caption_status');
export const listLiveCaptionAudioSources = () =>
  invoke<RecordingDeviceList>('list_live_caption_audio_sources');
export const getLiveCaptionBuildInfo = () =>
  invoke<LiveCaptionBuildInfo>('get_live_caption_build_info');
export const setLiveCaptionClickThrough = (ignore: boolean) =>
  invoke<void>('set_live_caption_click_through', { ignore });

export const listenLiveCaption = (
  handler: (payload: LiveCaptionPayload) => void,
): Promise<UnlistenFn> => listen<LiveCaptionPayload>(LIVE_CAPTION_EVENT, (event) => handler(event.payload));

export const listenLiveCaptionError = (
  handler: (payload: LiveCaptionErrorPayload) => void,
): Promise<UnlistenFn> => listen<LiveCaptionErrorPayload>(LIVE_CAPTION_ERROR_EVENT, (event) => handler(event.payload));

export const listenLiveCaptionStatus = (
  handler: (payload: LiveCaptionStatus) => void,
): Promise<UnlistenFn> => listen<LiveCaptionStatus>(LIVE_CAPTION_STATUS_EVENT, (event) => handler(event.payload));

/** 後端依游標位置切換點擊穿透時通知前端，供字幕視窗更新視覺提示。 */
export const listenLiveCaptionInteractive = (
  handler: (interactive: boolean) => void,
): Promise<UnlistenFn> =>
  listen<boolean>(LIVE_CAPTION_INTERACTIVE_EVENT, (event) => handler(event.payload));

export const listenLiveCaptionSettings = (
  handler: (payload: LiveCaptionSettingsPayload) => void,
): Promise<UnlistenFn> => listen<LiveCaptionSettingsPayload>(LIVE_CAPTION_SETTINGS_EVENT, (event) => handler(event.payload));
