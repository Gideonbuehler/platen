import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { Link, useRouter } from 'expo-router';
import { api, getServerUrl, getAccessToken } from '../src/lib/api';
import { useSession } from '../src/lib/session';
import { fontSize, radius, spacing } from '../src/lib/theme';
import type { Asset } from '../src/types';

const COLUMNS = 3;
const GAP = 2;

interface Section {
  date: string;
  label: string;
  assets: Asset[];
}

function formatDayLabel(iso: string, offset: string | null): string {
  // Same rule as the web client: shift by the recorded offset (or none) and
  // read UTC fields, so the day shown is the day the camera recorded.
  const instant = new Date(iso);
  let date = instant;
  if (offset) {
    const match = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
    if (match) {
      const sign = match[1] === '-' ? -1 : 1;
      const minutes = sign * (Number(match[2]) * 60 + Number(match[3]));
      date = new Date(instant.getTime() + minutes * 60_000);
    }
  }

  const today = new Date();
  const isToday =
    date.getUTCFullYear() === today.getFullYear() &&
    date.getUTCMonth() === today.getMonth() &&
    date.getUTCDate() === today.getDate();
  if (isToday) return 'Today';

  return date.toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: date.getUTCFullYear() === today.getFullYear() ? undefined : 'numeric',
    timeZone: 'UTC',
  });
}

function groupByDay(assets: Asset[]): Section[] {
  const groups = new Map<string, Asset[]>();

  for (const asset of assets) {
    const label = formatDayLabel(asset.takenAt, asset.takenAtOffset);
    const bucket = groups.get(label);
    if (bucket) bucket.push(asset);
    else groups.set(label, [asset]);
  }

  return [...groups.entries()].map(([label, items]) => ({
    date: label,
    label,
    assets: items,
  }));
}

export default function TimelineScreen() {
  const { palette, user } = useSession();
  const router = useRouter();
  const styles = makeStyles(palette);

  const [assets, setAssets] = useState<Asset[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  // expo-image cannot set headers, so tiles need the token in the URL. Resolve
  // it once here rather than awaiting inside every cell's render.
  useEffect(() => {
    void (async () => {
      setBaseUrl(await getServerUrl());
      setToken(await getAccessToken());
    })();
  }, [user]);

  const load = useCallback(async (reset: boolean) => {
    try {
      setError(null);
      const page = await api.timeline(reset ? undefined : (cursor ?? undefined));
      setAssets((previous) => (reset ? page.items : [...previous, ...page.items]));
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load photos.');
    }
  }, [cursor]);

  useEffect(() => {
    void load(true).finally(() => setLoading(false));
    // Intentionally once on mount: `load` changes with the cursor, and
    // re-running on that would reset the list mid-scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setCursor(null);
    await load(true);
    setRefreshing(false);
  }, [load]);

  const onEndReached = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    await load(false);
    setLoadingMore(false);
  }, [cursor, loadingMore, load]);

  const width = Dimensions.get('window').width;
  const tileSize = (width - GAP * (COLUMNS - 1)) / COLUMNS;

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }

  const sections = groupByDay(assets);

  return (
    <View style={styles.root}>
      <View style={styles.toolbar}>
        <Link href="/backup" asChild>
          <Pressable style={styles.toolbarButton}>
            <Text style={styles.toolbarText}>Backup</Text>
          </Pressable>
        </Link>
        <Link href="/settings" asChild>
          <Pressable style={styles.toolbarButton}>
            <Text style={styles.toolbarText}>Settings</Text>
          </Pressable>
        </Link>
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      <FlatList
        data={sections}
        keyExtractor={(section) => section.date}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={palette.accent}
          />
        }
        onEndReached={onEndReached}
        onEndReachedThreshold={1.2}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No photos yet</Text>
            <Text style={styles.emptyBody}>
              Turn on Backup to start copying your camera roll to your server.
            </Text>
          </View>
        }
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.footer}>
              <ActivityIndicator color={palette.textTertiary} />
            </View>
          ) : null
        }
        renderItem={({ item: section }) => (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{section.label}</Text>
            <View style={styles.grid}>
              {section.assets.map((asset) => (
                <Pressable
                  key={asset.id}
                  onPress={() => router.push(`/photo/${asset.id}`)}
                  style={{ width: tileSize, height: tileSize, marginRight: GAP, marginBottom: GAP }}
                >
                  <Image
                    source={
                      baseUrl && token
                        ? { uri: `${baseUrl}/api/assets/${asset.id}/thumbnail?token=${token}` }
                        : undefined
                    }
                    style={styles.tile}
                    contentFit="cover"
                    transition={180}
                    cachePolicy="memory-disk"
                    recyclingKey={asset.id}
                  />
                  {asset.type === 'video' && (
                    <View style={styles.videoBadge}>
                      <Text style={styles.videoBadgeText}>
                        {asset.durationMs
                          ? `${Math.floor(asset.durationMs / 60000)}:${String(
                              Math.round((asset.durationMs % 60000) / 1000),
                            ).padStart(2, '0')}`
                          : 'Video'}
                      </Text>
                    </View>
                  )}
                </Pressable>
              ))}
            </View>
          </View>
        )}
      />
    </View>
  );
}

const makeStyles = (p: ReturnType<typeof useSession>['palette']) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: p.surfaceBase },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: p.surfaceBase,
    },
    toolbar: {
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingBottom: spacing.sm,
    },
    toolbarButton: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.full,
      backgroundColor: p.surfaceRaised,
      borderWidth: 1,
      borderColor: p.borderSubtle,
    },
    toolbarText: { fontSize: fontSize.sm, color: p.textSecondary, fontWeight: '500' },
    section: { marginBottom: spacing.lg },
    sectionTitle: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      fontSize: fontSize.md,
      fontWeight: '600',
      color: p.textPrimary,
    },
    grid: { flexDirection: 'row', flexWrap: 'wrap' },
    tile: { width: '100%', height: '100%', backgroundColor: p.surfaceRaised },
    videoBadge: {
      position: 'absolute',
      right: 4,
      bottom: 4,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: radius.full,
      backgroundColor: 'rgba(0,0,0,0.6)',
    },
    videoBadgeText: { fontSize: 10, color: '#fff', fontWeight: '600' },
    empty: { alignItems: 'center', padding: spacing.xxl, gap: spacing.sm },
    emptyTitle: { fontSize: fontSize.lg, fontWeight: '600', color: p.textPrimary },
    emptyBody: { fontSize: fontSize.sm, color: p.textSecondary, textAlign: 'center', lineHeight: 20 },
    footer: { padding: spacing.xl, alignItems: 'center' },
    error: {
      margin: spacing.md,
      padding: spacing.md,
      borderRadius: radius.md,
      backgroundColor: p.dangerMuted,
      color: p.danger,
      fontSize: fontSize.sm,
    },
  });
