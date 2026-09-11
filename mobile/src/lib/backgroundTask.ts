import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import { getSettings, runBackup } from './backup';

export const BACKUP_TASK = 'platen-backup';

/**
 * Background camera-roll backup.
 *
 * What each platform actually gives us, so expectations stay honest:
 *
 *  - Android: WorkManager-backed. Runs reliably on roughly the requested
 *    interval, subject to Doze. This is the "set it and forget it" platform.
 *  - iOS: opportunistic only. The system decides when — and it learns from how
 *    the person uses the app, so an app opened daily gets frequent windows and
 *    one opened monthly gets almost none. There is no API that guarantees a
 *    background window, so the app also runs a full sync whenever it is opened.
 *
 * Each background window uploads at most a handful of items. iOS grants roughly
 * 30 seconds before killing the process, and a killed run mid-upload wastes the
 * whole window; small batches always make forward progress because the ledger
 * is written after every file.
 */
const BACKGROUND_BATCH_SIZE = 12;

TaskManager.defineTask(BACKUP_TASK, async () => {
  try {
    const settings = await getSettings();
    if (!settings.enabled) return BackgroundFetch.BackgroundFetchResult.NoData;

    const result = await runBackup({ maxItems: BACKGROUND_BATCH_SIZE });

    return result.uploaded > 0
      ? BackgroundFetch.BackgroundFetchResult.NewData
      : BackgroundFetch.BackgroundFetchResult.NoData;
  } catch {
    // Reporting failure tells iOS to back off, which is the right response to
    // a server that is unreachable — it stops us burning battery retrying.
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

export async function registerBackgroundBackup(): Promise<void> {
  const already = await TaskManager.isTaskRegisteredAsync(BACKUP_TASK);
  if (already) return;

  await BackgroundFetch.registerTaskAsync(BACKUP_TASK, {
    // A floor, not a promise: both platforms treat it as "no more often than".
    minimumInterval: 15 * 60,
    stopOnTerminate: false, // Android: survive the app being swiped away
    startOnBoot: true,      // Android: resume after a reboot
  });
}

export async function unregisterBackgroundBackup(): Promise<void> {
  if (await TaskManager.isTaskRegisteredAsync(BACKUP_TASK)) {
    await BackgroundFetch.unregisterTaskAsync(BACKUP_TASK);
  }
}

/** Whether the OS is currently willing to run background work at all — the
 *  user may have disabled Background App Refresh system-wide. */
export async function getBackgroundStatus(): Promise<{
  available: boolean;
  reason: string;
}> {
  const status = await BackgroundFetch.getStatusAsync();

  switch (status) {
    case BackgroundFetch.BackgroundFetchStatus.Restricted:
      return {
        available: false,
        reason: 'Background activity is restricted on this device (parental controls or low power mode).',
      };
    case BackgroundFetch.BackgroundFetchStatus.Denied:
      return {
        available: false,
        reason: 'Background App Refresh is turned off. Enable it in system settings for automatic backup.',
      };
    default:
      return { available: true, reason: '' };
  }
}
