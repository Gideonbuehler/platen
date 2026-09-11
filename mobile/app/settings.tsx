import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { api } from '../src/lib/api';
import { unregisterBackgroundBackup } from '../src/lib/backgroundTask';
import { useSession } from '../src/lib/session';
import { fontSize, radius, spacing } from '../src/lib/theme';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return `${value < 10 && index > 0 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}

export default function SettingsScreen() {
  const { palette, user, serverUrl, signOut } = useSession();
  const router = useRouter();
  const styles = makeStyles(palette);

  const [stats, setStats] = useState<{ assets: number; usageBytes: number } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const result = await api.me();
        setStats({ assets: 0, usageBytes: result.usageBytes });
      } catch {
        // Offline — the account section simply shows less.
      }
    })();
  }, []);

  const confirmSignOut = () => {
    Alert.alert(
      'Sign out?',
      'Automatic backup stops until you sign in again. Photos already on the server are unaffected.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: async () => {
            await unregisterBackgroundBackup().catch(() => {});
            await signOut();
            router.replace('/login');
          },
        },
      ],
    );
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.sectionLabel}>Account</Text>

        <View style={styles.row}>
          <Text style={styles.rowLabel}>Name</Text>
          <Text style={styles.rowValue}>{user?.name ?? '—'}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Email</Text>
          <Text style={styles.rowValue}>{user?.email ?? '—'}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Server</Text>
          <Text style={styles.rowValue} numberOfLines={1}>
            {serverUrl?.replace(/^https?:\/\//, '') ?? '—'}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Storage used</Text>
          <Text style={styles.rowValue}>
            {stats ? formatBytes(stats.usageBytes) : '—'}
            {user?.quotaBytes ? ` of ${formatBytes(user.quotaBytes)}` : ''}
          </Text>
        </View>
      </View>

      <Pressable style={styles.card} onPress={() => router.push('/backup')}>
        <Text style={styles.linkTitle}>Backup settings</Text>
        <Text style={styles.linkSubtitle}>
          Automatic upload, Wi-Fi only, videos, and troubleshooting.
        </Text>
      </Pressable>

      <Pressable style={[styles.card, styles.danger]} onPress={confirmSignOut}>
        <Text style={styles.dangerText}>Sign out</Text>
      </Pressable>

      <Text style={styles.footnote}>
        Platen · your photos stay on your own server.
      </Text>
    </ScrollView>
  );
}

const makeStyles = (p: ReturnType<typeof useSession>['palette']) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: p.surfaceBase },
    content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
    card: {
      padding: spacing.lg,
      borderRadius: radius.lg,
      backgroundColor: p.surfaceRaised,
      borderWidth: 1,
      borderColor: p.borderSubtle,
      gap: spacing.sm,
    },
    sectionLabel: {
      marginBottom: spacing.xs,
      fontSize: fontSize.xs,
      fontWeight: '600',
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: p.textTertiary,
    },
    row: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
    rowLabel: { fontSize: fontSize.sm, color: p.textSecondary },
    rowValue: { flexShrink: 1, fontSize: fontSize.sm, color: p.textPrimary, textAlign: 'right' },
    linkTitle: { fontSize: fontSize.md, fontWeight: '600', color: p.textPrimary },
    linkSubtitle: { fontSize: fontSize.xs, color: p.textSecondary, lineHeight: 17 },
    danger: { alignItems: 'center', backgroundColor: p.dangerMuted, borderColor: 'transparent' },
    dangerText: { fontSize: fontSize.md, fontWeight: '600', color: p.danger },
    footnote: { textAlign: 'center', fontSize: fontSize.xs, color: p.textTertiary },
  });
