import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { MemoriesRow } from '../../src/components/MemoriesRow';
import { PhotoGrid } from '../../src/components/PhotoGrid';
import { api } from '../../src/lib/api';
import { useSession } from '../../src/lib/session';
import { fontSize, spacing } from '../../src/lib/theme';
import type { Asset } from '../../src/types';

export default function TimelineScreen() {
  const { palette } = useSession();
  const styles = makeStyles(palette);

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
        const page = await api.timeline(reset ? undefined : (from ?? undefined));
        setAssets((previous) => (reset ? page.items : [...previous, ...page.items]));
        setCursor(page.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load photos.');
      }
    },
    [],
  );

  useEffect(() => {
    void load(true).finally(() => setLoading(false));
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }, [load]);

  const onEndReached = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    await load(false, cursor);
    setLoadingMore(false);
  }, [cursor, loadingMore, load]);

  return (
    <View style={styles.root}>
      {error && <Text style={styles.error}>{error}</Text>}

      <PhotoGrid
        assets={assets}
        loading={loading}
        refreshing={refreshing}
        onRefresh={onRefresh}
        onEndReached={onEndReached}
        loadingMore={loadingMore}
        header={<MemoriesRow />}
        empty={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No photos yet</Text>
            <Text style={styles.emptyBody}>
              Turn on Backup under Library to start copying your camera roll to your server.
            </Text>
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
