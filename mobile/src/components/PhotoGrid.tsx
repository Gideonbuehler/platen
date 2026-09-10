import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { useRouter } from 'expo-router';
import { getAccessToken, getServerUrl } from '../lib/api';
import { useSession } from '../lib/session';
import { fontSize, radius, spacing } from '../lib/theme';
import type { Asset } from '../types';

const COLUMNS = 3;
const GAP = 2;

interface Section {
  label: string;
  assets: Asset[];
}

/**
 * The camera's wall-clock date, matching what the web client shows.
 *
 * The server stores a true instant plus the offset the file recorded; shifting
 * by that offset and reading UTC fields reproduces the time on the camera, so
 * an evening photo does not slide into the next day for a viewer in another
 * timezone.
 */
function dayLabel(takenAt: string, offset: string | null): string {
  const instant = new Date(takenAt);
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
    const label = dayLabel(asset.takenAt, asset.takenAtOffset);
    const bucket = groups.get(label);
    if (bucket) bucket.push(asset);
    else groups.set(label, [asset]);
  }
  return [...groups.entries()].map(([label, items]) => ({ label, assets: items }));
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export interface PhotoGridProps {
  assets: Asset[];
  loading?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  onEndReached?: () => void;
  loadingMore?: boolean;
  /** Rendered in place of the grid when there is nothing to show. */
  empty?: React.ReactNode;
  header?: React.ReactNode;
  /** Grouped by day by default; off for search results, which are ranked. */
  groupByDate?: boolean;
}

export function PhotoGrid({
  assets,
  loading,
  refreshing,
  onRefresh,
  onEndReached,
  loadingMore,
  empty,
  header,
  groupByDate = true,
}: PhotoGridProps) {
  const { palette, user } = useSession();
  const router = useRouter();
  const styles = makeStyles(palette);

  // expo-image cannot set headers, so tiles need the token in the URL.
  // Resolved once here rather than awaited inside every cell's render.
  const [base, setBase] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setBase(await getServerUrl());
      setToken(await getAccessToken());
    })();
  }, [user]);

  const tileSize = (Dimensions.get('window').width - GAP * (COLUMNS - 1)) / COLUMNS;

  const sections = useMemo(
    () => (groupByDate ? groupByDay(assets) : [{ label: '', assets }]),
    [assets, groupByDate],
  );

  const renderTile = useCallback(
    (asset: Asset) => (
      <Pressable
        key={asset.id}
        onPress={() => router.push(`/photo/${asset.id}`)}
        style={{ width: tileSize, height: tileSize, marginRight: GAP, marginBottom: GAP }}
      >
        <Image
          source={
            base && token
              ? // The version stamp matches the web client: derivative URLs are
                // stable but their contents are not, so regenerating a
                // thumbnail must not be masked by a cached copy.
                { uri: `${base}/api/assets/${asset.id}/thumbnail?token=${token}&v=${asset.updatedAt}` }
              : undefined
          }
          style={styles.tile}
          contentFit="cover"
          transition={160}
          cachePolicy="memory-disk"
          recyclingKey={asset.id}
        />

        {asset.type === 'video' && (
          <View style={styles.videoBadge}>
            <Text style={styles.videoBadgeText}>
              {asset.durationMs ? formatDuration(asset.durationMs) : 'Video'}
            </Text>
          </View>
        )}

        {asset.isFavorite && <View style={styles.favouriteDot} />}
      </Pressable>
    ),
    [base, token, tileSize, router, styles],
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }

  return (
    <FlatList
      data={sections}
      keyExtractor={(section, index) => `${section.label}-${index}`}
      ListHeaderComponent={header ? <>{header}</> : null}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing ?? false}
            onRefresh={onRefresh}
            tintColor={palette.accent}
          />
        ) : undefined
      }
      onEndReached={onEndReached}
      onEndReachedThreshold={1.2}
      ListEmptyComponent={empty ? <>{empty}</> : null}
      ListFooterComponent={
        loadingMore ? (
          <View style={styles.footer}>
            <ActivityIndicator color={palette.textTertiary} />
          </View>
        ) : null
      }
      renderItem={({ item }) => (
        <View style={styles.section}>
          {item.label.length > 0 && <Text style={styles.sectionTitle}>{item.label}</Text>}
          <View style={styles.grid}>{item.assets.map(renderTile)}</View>
        </View>
      )}
    />
  );
}

const makeStyles = (p: ReturnType<typeof useSession>['palette']) =>
  StyleSheet.create({
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: p.surfaceBase,
      paddingVertical: spacing.xxl,
    },
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
    favouriteDot: {
      position: 'absolute',
      left: 5,
      bottom: 5,
      width: 7,
      height: 7,
      borderRadius: radius.full,
      backgroundColor: '#fff',
    },
    footer: { padding: spacing.xl, alignItems: 'center' },
  });
