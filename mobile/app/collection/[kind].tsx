import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { PhotoGrid } from '../../src/components/PhotoGrid';
import { api } from '../../src/lib/api';
import { useSession } from '../../src/lib/session';
import { fontSize, spacing } from '../../src/lib/theme';
import type { Asset, Page } from '../../src/types';

/**
 * The saved views — favourites, archive and trash.
 *
 * One screen rather than three, because they differ only in which endpoint
 * they page through and what to say when they are empty.
 */
const VIEWS = {
  favorites: {
    title: 'Favourites',
    fetch: (cursor?: string) => api.favorites(cursor),
    emptyTitle: 'No favourites yet',
    emptyBody: 'Tap the heart on a photo to keep it here.',
  },
  archive: {
    title: 'Archive',
    fetch: (cursor?: string) => api.archived(cursor),
    emptyTitle: 'Archive is empty',
    emptyBody: 'Archived photos stay in your library but are hidden from the main timeline.',
  },
  trash: {
    title: 'Trash',
    fetch: (cursor?: string) => api.trashed(cursor),
    emptyTitle: 'Trash is empty',
    emptyBody: 'Deleted photos wait here for 30 days before they are removed for good.',
  },
} as const satisfies Record<
  string,
  { title: string; fetch: (cursor?: string) => Promise<Page<Asset>>; emptyTitle: string; emptyBody: string }
>;

type ViewKind = keyof typeof VIEWS;

export default function CollectionScreen() {
  const { kind } = useLocalSearchParams<{ kind: string }>();
  const { palette } = useSession();
  const styles = makeStyles(palette);

  const view = VIEWS[kind as ViewKind] ?? VIEWS.favorites;

  const [assets, setAssets] = useState<Asset[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (reset: boolean, from?: string | null) => {
      try {
        setError(null);
        const page = await view.fetch(reset ? undefined : (from ?? undefined));
        setAssets((previous) => (reset ? page.items : [...previous, ...page.items]));
        setCursor(page.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load these photos.');
      }
    },
    [view],
  );

  useEffect(() => {
    setLoading(true);
    void load(true).finally(() => setLoading(false));
  }, [load]);

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: view.title }} />
      {error && <Text style={styles.error}>{error}</Text>}

      <PhotoGrid
        assets={assets}
        loading={loading}
        refreshing={refreshing}
        onRefresh={async () => {
          setRefreshing(true);
          await load(true);
          setRefreshing(false);
        }}
        onEndReached={async () => {
          if (!cursor || loadingMore) return;
          setLoadingMore(true);
          await load(false, cursor);
          setLoadingMore(false);
        }}
        loadingMore={loadingMore}
        empty={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{view.emptyTitle}</Text>
            <Text style={styles.emptyBody}>{view.emptyBody}</Text>
          </View>
        }
      />
    </View>
  );
}

const makeStyles = (p: ReturnType<typeof useSession>['palette']) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: p.surfaceBase },
    empty: { alignItems: 'center', padding: spacing.xxl, gap: spacing.sm },
    emptyTitle: { fontSize: fontSize.lg, fontWeight: '600', color: p.textPrimary },
    emptyBody: {
      fontSize: fontSize.sm,
      color: p.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
    },
    error: {
      margin: spacing.md,
      padding: spacing.md,
      borderRadius: 10,
      backgroundColor: p.dangerMuted,
      color: p.danger,
      fontSize: fontSize.sm,
    },
  });
