import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { api, getAccessToken, getServerUrl } from '../../src/lib/api';
import { getStats, type BackupStats } from '../../src/lib/backup';
import { useSession } from '../../src/lib/session';
import { fontSize, radius, spacing } from '../../src/lib/theme';
import type { Person } from '../../src/types';

/**
 * The hub tab.
 *
 * People, the saved views, and the two things you configure once. Backup gets
 * a live progress line here because "is my phone actually backed up?" is the
 * question this app exists to answer, and burying it a screen deeper would
 * mean nobody ever checks.
 */
export default function LibraryScreen() {
  const { palette, user } = useSession();
  const router = useRouter();
  const styles = makeStyles(palette);

  const [people, setPeople] = useState<Person[]>([]);
  const [backup, setBackup] = useState<BackupStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [base, setBase] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setBase(await getServerUrl());
      setToken(await getAccessToken());
    })();
  }, [user]);

  const load = useCallback(async () => {
    const [peopleResult, statsResult] = await Promise.allSettled([api.people(), getStats()]);
    if (peopleResult.status === 'fulfilled') setPeople(peopleResult.value);
    if (statsResult.status === 'fulfilled') setBackup(statsResult.value);
  }, []);

  // Refresh on focus, so returning from the Backup screen shows the new count
  // rather than a stale one.
  useFocusEffect(
    useCallback(() => {
      void load().finally(() => setLoading(false));
    }, [load]),
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }

  const backedUp =
    backup && backup.total > 0 ? Math.round(((backup.total - backup.pending) / backup.total) * 100) : null;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
          tintColor={palette.accent}
        />
      }
    >
      {/* ---- People ------------------------------------------------------ */}
      {people.length > 0 && (
        <View>
          <Text style={styles.sectionTitle}>People</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.peopleRow}>
            {people.map((person) => (
              <Pressable
                key={person.id}
                style={styles.person}
                onPress={() => router.push(`/person/${person.id}`)}
              >
                <View style={styles.avatar}>
                  {person.coverFaceId && base && token ? (
                    <Image
                      source={{ uri: `${base}/api/people/faces/${person.coverFaceId}/thumbnail?token=${token}` }}
                      style={styles.avatarImage}
                      contentFit="cover"
                      transition={160}
                      cachePolicy="memory-disk"
                    />
                  ) : (
                    <Ionicons name="person" size={22} color={palette.textTertiary} />
                  )}
                </View>
                <Text style={styles.personName} numberOfLines={1}>
                  {person.name ?? 'Unnamed'}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      {/* ---- Saved views ------------------------------------------------- */}
      <View style={styles.card}>
        <Row
          icon="heart-outline"
          label="Favourites"
          onPress={() => router.push('/collection/favorites')}
          palette={palette}
        />
        <Divider palette={palette} />
        <Row
          icon="archive-outline"
          label="Archive"
          onPress={() => router.push('/collection/archive')}
          palette={palette}
        />
        <Divider palette={palette} />
        <Row
          icon="trash-outline"
          label="Trash"
          onPress={() => router.push('/collection/trash')}
          palette={palette}
        />
      </View>

      {/* ---- Backup ------------------------------------------------------ */}
      <Pressable style={styles.card} onPress={() => router.push('/backup')}>
        <View style={styles.row}>
          <Ionicons name="cloud-upload-outline" size={20} color={palette.textSecondary} />
          <View style={styles.rowText}>
            <Text style={styles.rowLabel}>Backup</Text>
            <Text style={styles.rowSub}>
              {backup === null
                ? 'Tap to set up'
                : backup.pending === 0
                  ? 'Everything on this phone is backed up'
                  : `${backup.pending.toLocaleString()} still to upload`}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={palette.textTertiary} />
        </View>

        {backedUp !== null && (
          <View style={styles.bar}>
            <View style={[styles.barFill, { width: `${backedUp}%` }]} />
          </View>
        )}
      </Pressable>

      {/* ---- Account ----------------------------------------------------- */}
      <View style={styles.card}>
        <Row
          icon="settings-outline"
          label="Settings"
          sub={user?.email}
          onPress={() => router.push('/settings')}
          palette={palette}
        />
      </View>
    </ScrollView>
  );
}

function Row({
  icon,
  label,
  sub,
  onPress,
  palette,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  sub?: string;
  onPress: () => void;
  palette: ReturnType<typeof useSession>['palette'];
}) {
  const styles = makeStyles(palette);
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <Ionicons name={icon} size={20} color={palette.textSecondary} />
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        {sub && (
          <Text style={styles.rowSub} numberOfLines={1}>
            {sub}
          </Text>
        )}
      </View>
      <Ionicons name="chevron-forward" size={18} color={palette.textTertiary} />
    </Pressable>
  );
}

const Divider = ({ palette }: { palette: ReturnType<typeof useSession>['palette'] }) => (
  <View style={{ height: 1, backgroundColor: palette.borderSubtle, marginLeft: 40 }} />
);

const makeStyles = (p: ReturnType<typeof useSession>['palette']) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: p.surfaceBase },
    content: { padding: spacing.md, gap: spacing.lg, paddingBottom: spacing.xxl },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: p.surfaceBase,
    },
    sectionTitle: {
      marginBottom: spacing.sm,
      fontSize: fontSize.md,
      fontWeight: '600',
      color: p.textPrimary,
    },
    peopleRow: { gap: spacing.md, paddingRight: spacing.md },
    person: { alignItems: 'center', width: 68, gap: spacing.xs },
    avatar: {
      width: 64,
      height: 64,
      borderRadius: radius.full,
      overflow: 'hidden',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: p.surfaceRaised,
    },
    avatarImage: { width: '100%', height: '100%' },
    personName: { fontSize: fontSize.xs, color: p.textSecondary, textAlign: 'center' },
    card: {
      borderRadius: radius.lg,
      backgroundColor: p.surfaceRaised,
      borderWidth: 1,
      borderColor: p.borderSubtle,
      overflow: 'hidden',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.md,
    },
    rowText: { flex: 1, gap: 2 },
    rowLabel: { fontSize: fontSize.md, color: p.textPrimary },
    rowSub: { fontSize: fontSize.xs, color: p.textTertiary },
    bar: {
      height: 4,
      marginHorizontal: spacing.md,
      marginBottom: spacing.md,
      borderRadius: radius.full,
      backgroundColor: p.surfaceHover,
      overflow: 'hidden',
    },
    barFill: { height: '100%', borderRadius: radius.full, backgroundColor: p.accent },
  });
