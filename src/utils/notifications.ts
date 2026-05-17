import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { showToast } from '../components/toast';
import { getCurrentConfig, initConfigStore } from './configStore';

interface CompletionNotification {
  title: string;
  body: string;
}

interface NotificationDispatchOptions {
  ignoreFocus?: boolean;
}

export interface NotificationDebugInfo {
  enabled: boolean;
  focused: boolean;
  permissionGranted: boolean;
  skippedBecauseFocused: boolean;
}

let permissionGranted: boolean | null = null;
let permissionRequest: Promise<boolean> | null = null;
let focusTrackingInitialized = false;
let windowFocused = true;
let documentVisible = true;

function updateForegroundState(): void {
  windowFocused = window.document.hasFocus();
  documentVisible = window.document.visibilityState !== 'hidden';
}

export function initNotificationFocusTracking(): void {
  if (focusTrackingInitialized) {
    return;
  }

  focusTrackingInitialized = true;
  updateForegroundState();

  window.addEventListener('focus', () => {
    windowFocused = true;
    documentVisible = window.document.visibilityState !== 'hidden';
  });

  window.addEventListener('blur', () => {
    windowFocused = false;
  });

  window.document.addEventListener('visibilitychange', () => {
    documentVisible = window.document.visibilityState !== 'hidden';
    if (documentVisible) {
      windowFocused = window.document.hasFocus();
    }
  });
}

function isAppForeground(): boolean {
  if (!focusTrackingInitialized) {
    updateForegroundState();
  }

  return windowFocused && documentVisible;
}

async function ensureNotificationPermission(): Promise<boolean> {
  if (permissionGranted !== null) {
    return permissionGranted;
  }

  if (!permissionRequest) {
    permissionRequest = (async () => {
      let granted = await isPermissionGranted();
      if (!granted) {
        granted = (await requestPermission()) === 'granted';
      }
      permissionGranted = granted;
      permissionRequest = null;
      return granted;
    })();
  }

  return permissionRequest;
}

async function getNotificationDebugInfo(options?: NotificationDispatchOptions): Promise<NotificationDebugInfo> {
  const config = getCurrentConfig() ?? await initConfigStore();
  const focused = isAppForeground();
  const permissionGranted = await ensureNotificationPermission();

  return {
    enabled: config.completion_notification_enabled,
    focused,
    permissionGranted,
    skippedBecauseFocused: !options?.ignoreFocus && focused,
  };
}

async function dispatchNotification(
  notification: CompletionNotification,
  options?: NotificationDispatchOptions,
): Promise<NotificationDebugInfo> {
  const debug = await getNotificationDebugInfo(options);

  if (!debug.enabled) {
    return debug;
  }

  if (debug.skippedBecauseFocused) {
    return debug;
  }

  if (!debug.permissionGranted) {
    return debug;
  }

  await sendNotification(notification);
  return debug;
}

export async function notifyCompletion(notification: CompletionNotification): Promise<void> {
  try {
    await dispatchNotification(notification);
  } catch (err) {
    showToast(`Windows 通知失敗：${String(err)}`, 'warning', 5000);
  }
}

export async function sendTestNotification(): Promise<NotificationDebugInfo> {
  try {
    return await dispatchNotification(
      {
        title: 'VoxNote 測試通知',
        body: '這是一則測試通知，用來確認 Windows 通知是否正常。',
      },
      { ignoreFocus: true },
    );
  } catch (err) {
    showToast(`Windows 通知失敗：${String(err)}`, 'warning', 5000);
    throw err;
  }
}
