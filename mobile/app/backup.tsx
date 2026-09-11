import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import {
  ensurePermission,
  getSettings,
  getStats,
  resetLedger,
  runBackup,
  setSettings,
  syncLedgerFromServer,
  type BackupProgress,
  type BackupSettings,
  type BackupStats,
} from '../src/lib/backup';
import {
  getBackgroundStatus,
  registerBackgroundBackup,
  unregisterBackgroundBackup,
} from '../src/lib/backgroundTask';
import { useSession } from '../src/lib/session';
import { fontSize, radius, spacing } from '../src/lib/theme';

export default function BackupScreen() {
  const { palette } = useSession();
  const styles = makeStyles(palette);

  const [settings, setLocalSettings] = useState<BackupSettings | null>(null);
  const [stats, setStats] = useState<BackupStats | null>(null);
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [backgroundNote, setBackgroundNote] = useState<string | null>(null);
  const cancelRef = useRef({ cancelled: false });

  const refresh = useCallback(async () => {
    const [nextSettings, nextStats, background] = await Promise.all([
      getSettings(),
      getStats(),
      getBackgroundStatus(),
    ]);
    setLocalSettings(nextSettings);
    setStats(nextStats);
    setBackgroundNote(background.available ? null : background.reason);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleEnabled = async (enabled: boolean) => {
    if (enabled && !(await ensurePermission())) {
      Alert.alert(
        'Photo access needed',
        'Platen needs access to your photo library to back it up. Enable it in system settings.',
      );
      return;
    }

    await setSettings({ enabled });
    setLocalSettings((prev) => (prev ? { ...prev, enabled } : prev));

    if (enabled) {
      await registerBackgroundBackup().catch(() => {});
      // First enable on an existing account: learn what the server already has
      // so we do not re-upload a library it already holds.
      await syncLedgerFromServer().catch(() => 0);
      await refresh();
    } else {
      await unregisterBackgroundBackup().catch(() => {});
    }
  };

  const startBackup = async () => {
    if (!(await ensurePermission())) {
      Alert.alert('Photo access needed', 'Grant photo library access to run a backup.');
      return;
    }

    cancelRef.current = { cancelled: false };
    setRunning(true);
    setProgress(null);

    try {
      const result = await runBackup({
        onProgress: setProgress,
        signal: cancelRef.current,
      });

      if (result.failed > 0) {
        Alert.alert(
          'Backup finished with problems',
          `${result.uploaded} uploaded, ${result.skipped} already on the server, ${result.failed} failed. Failed items are retried on the next run.`,
        );
      }
    } catch (err) {
      Alert.alert('Backup failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setRunning(false);
      setProgress(null);
      await refresh();
    }
  };

  if (!settings || !stats) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }

  const percent = stats.total > 0 ? Math.round(((stats.total - stats.pending) / stats.total) * 100) : 100;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      {/* --- status ---------------------------------------------------- */}
      <View style={styles.card}>
        <Text style={styles.bigNumber}>{percent}%</Text>
        <Text style={styles.bigLabel}>
          {stats.pending === 0
            ? 'Everything is backed up'
            : `${stats.pending.toLocaleString()} of ${stats.total.toLocaleString()} still to upload`}
        </Text>

        <View style={styles.bar}>
          <View style={[styles.barFill, { width: `${percent}%` }]} />
        </View>

        {stats.lastRun && (
          <Text style={styles.muted}>
            Last run {new Date(stats.lastRun).toLocaleString()}
          </Text>
        )}
      </View>

      {/* --- run now ---------------------------------------------------- */}
      {running ? (
        <View style={styles.card}>
          <Text style={styles.rowTitle}>Backing up…</Text>
          {progress && (
            <>
              <Text style={styles.muted} numberOfLines={1}>
                {progress.filename}
              </Text>
              <View style={styles.bar}>
                <View
                  style={[
                    styles.barFill,
                    { width: `${Math.round((progress.current / progress.total) * 100)}%` },
                  ]}
                />
              </View>
              <Text style={styles.muted}>
                {progress.current} of {progress.total}
              </Text>
            </>
          )}
          <Pressable
            style={[styles.button, styles.buttonSecondary]}
            onPress={() => {
              cancelRef.current.cancelled = true;
            }}
          >
            <Text style={styles.buttonSecondaryText}>Stop</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable style={styles.button} onPress={startBackup}>
          <Text style={styles.buttonText}>
            {stats.pending > 0 ? `Back up ${stats.pending.toLocaleString()} items` : 'Check for new photos'}
          </Text>
        </Pressable>
      )}

      {/* --- settings --------------------------------------------------- */}
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>Automatic backup</Text>
            <Text style={styles.rowSubtitle}>
              {Platform.OS === 'ios'
                ? 'Runs when you open the app, and in the background when iOS allows it.'
                : 'Runs periodically in the background, and when you open the app.'}
            </Text>
          </View>
          <Switch
            value={settings.enabled}
            onValueChange={toggleEnabled}
            trackColor={{ true: palette.accent, false: palette.surfaceHover }}
            thumbColor="#fff"
          />
        </View>

        <View style={styles.divider} />

        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>Wi-Fi only</Text>
            <Text style={styles.rowSubtitle}>Avoid uploading over mobile data.</Text>
          </View>
          <Switch
            value={settings.wifiOnly}
            onValueChange={async (wifiOnly) => {
              await setSettings({ wifiOnly });
              setLocalSettings({ ...settings, wifiOnly });
            }}
            trackColor={{ true: palette.accent, false: palette.surfaceHover }}
            thumbColor="#fff"
          />
        </View>

        <View style={styles.divider} />

        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>Include videos</Text>
            <Text style={styles.rowSubtitle}>Videos are large; turn this off to back up stills only.</Text>
          </View>
          <Switch
            value={settings.includeVideos}
            onValueChange={async (includeVideos) => {
              await setSettings({ includeVideos });
              setLocalSettings({ ...settings, includeVideos });
              await refresh();
            }}
            trackColor={{ true: palette.accent, false: palette.surfaceHover }}
            thumbColor="#fff"
          />
        </View>
      </View>

      {backgroundNote && (
        <View style={[styles.card, styles.warning]}>
          <Text style={styles.warningText}>{backgroundNote}</Text>
        </View>
      )}

      {/* --- iOS honesty ------------------------------------------------ */}
      {Platform.OS === 'ios' && (
        <Text style={styles.footnote}>
          iOS does not allow apps to upload continuously in the background. Platen syncs every
          time you open it, and takes whatever background windows iOS offers — which become more
          frequent the more often you use the app.
        </Text>
      )}

      {/* --- troubleshooting -------------------------------------------- */}
      <View style={styles.card}>
        <Text style={styles.rowTitle}>Troubleshooting</Text>

        <Pressable
          style={[styles.button, styles.buttonSecondary]}
          onPress={async () => {
            const count = await syncLedgerFromServer();
            await refresh();
            Alert.alert(
              'Synced with server',
              `Matched ${count.toLocaleString()} items already backed up from this device.`,
            );
          }}
        >
          <Text style={styles.buttonSecondaryText}>Re-sync with server</Text>
        </Pressable>

        <Pressable
          style={[styles.button, styles.buttonSecondary]}
          onPress={() =>
            Alert.alert(
              'Re-check every photo?',
              'Platen will offer your whole library again. Anything the server already has is detected and skipped, so nothing is duplicated — it just takes longer.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Re-check',
                  style: 'destructive',
                  onPress: async () => {
                    await resetLedger();
                    await refresh();
                  },
                },
              ],
            )
          }
        >
          <Text style={styles.buttonSecondaryText}>Forget local upload history</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const makeStyles = (p: ReturnType<typeof useSession>['palette']) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: p.surfaceBase },
    content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: p.surfaceBase,
    },
    card: {
      padding: spacing.lg,
      borderRadius: radius.lg,
      backgroundColor: p.surfaceRaised,
      borderWidth: 1,
      borderColor: p.borderSubtle,
      gap: spacing.sm,
    },
    bigNumber: {
      fontSize: 44,
      fontWeight: '700',
      color: p.textPrimary,
      letterSpacing: -1,
    },
    bigLabel: { fontSize: fontSize.md, color: p.textSecondary },
    bar: {
      height: 6,
      marginTop: spacing.sm,
      borderRadius: radius.full,
      backgroundColor: p.surfaceHover,
      overflow: 'hidden',
    },
    barFill: { height: '100%', borderRadius: radius.full, backgroundColor: p.accent },
    muted: { fontSize: fontSize.xs, color: p.textTertiary },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    rowText: { flex: 1, gap: 2 },
    rowTitle: { fontSize: fontSize.md, fontWeight: '600', color: p.textPrimary },
    rowSubtitle: { fontSize: fontSize.xs, color: p.textSecondary, lineHeight: 17 },
    divider: { height: 1, backgroundColor: p.borderSubtle, marginVertical: spacing.xs },
    button: {
      height: 50,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.md,
      backgroundColor: p.accent,
    },
    buttonText: { fontSize: fontSize.md, fontWeight: '600', color: p.accentContrast },
    buttonSecondary: {
      height: 44,
      marginTop: spacing.sm,
      backgroundColor: p.surfaceOverlay,
      borderWidth: 1,
      borderColor: p.borderDefault,
    },
    buttonSecondaryText: { fontSize: fontSize.sm, fontWeight: '500', color: p.textPrimary },
    warning: { backgroundColor: p.dangerMuted, borderColor: p.danger },
    warningText: { fontSize: fontSize.sm, color: p.danger, lineHeight: 19 },
    footnote: {
      fontSize: fontSize.xs,
      color: p.textTertiary,
      lineHeight: 18,
      paddingHorizontal: spacing.xs,
    },
  });
