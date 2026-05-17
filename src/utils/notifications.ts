import { getCurrentWindow } from '@tauri-apps/api/window';
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

let permissionGranted: boolean | null = null;
let permissionRequest: Promise<boolean> | null = null;

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

async function shouldNotify(): Promise<boolean> {
  const config = getCurrentConfig() ?? await initConfigStore();
  if (!config.completion_notification_enabled) {
    return false;
  }

  const isFocused = await getCurrentWindow().isFocused();
  return !isFocused;
}

export async function notifyCompletion(notification: CompletionNotification): Promise<void> {
  if (!await shouldNotify()) {
    return;
  }

  if (!await ensureNotificationPermission()) {
    return;
  }

  try {
    await sendNotification(notification);
  } catch (err) {
    showToast(`Windows 通知失敗：${String(err)}`, 'warning', 5000);
  }
}
