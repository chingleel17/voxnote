import type { AppConfig } from '../types';
import { getSettings } from '../api/settings';

let currentConfig: AppConfig | null = null;
let loadPromise: Promise<AppConfig> | null = null;

export function getCurrentConfig(): AppConfig | null {
  return currentConfig;
}

export function setCurrentConfig(config: AppConfig): void {
  currentConfig = { ...config };
}

export async function initConfigStore(): Promise<AppConfig> {
  if (currentConfig) {
    return currentConfig;
  }

  if (!loadPromise) {
    loadPromise = getSettings()
      .then((config) => {
        currentConfig = { ...config };
        return currentConfig;
      })
      .finally(() => {
        loadPromise = null;
      });
  }

  return loadPromise;
}
