import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { PhotoGrid } from '../../src/components/PhotoGrid';
import { api } from '../../src/lib/api';
import { useSession } from '../../src/lib/session';
import { fontSize, spacing } from '../../src/lib/theme';
import type { Album, Asset } from '../../src/types';

export default function AlbumScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { palette } = useSession();
  const styles = makeStyles(palette);

  const [album, setAlbum] = useState<Album | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [detail, page] = await Promise.all([api.album(id), api.albumAssets(id)]);
      setAlbum(detail);
      setAssets(page.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this album.');
    }
  }, [id]);

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, [load]);

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: album?.name ?? 'Album' }} />
      {error && <Text style={styles.error}>{error}</Text>}

      <PhotoGrid
        assets={assets}
        loading={loading}
        onRefresh={load}
        header={
          album ? (
            <Text style={styles.subtitle}>
              {album.assetCount} {album.assetCount === 1 ? 'item' : 'items'}
            </Text>
          ) : null
        }
        empty={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>This album is empty</Text>
            <Text style={styles.emptyBody}>Add photos to it from the web app.</Text>
          </View>
        }
      />
    </View>
  );
}

const makeStyles = (p: ReturnType<typeof useSession>['palette']) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: p.surfaceBase },
    subtitle: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      fontSize: fontSize.sm,
      color: p.textTertiary,
    },
    empty: { alignItems: 'center', padding: spacing.xxl, gap: spacing.sm },
    emptyTitle: { fontSize: fontSize.lg, fontWeight: '600', color: p.textPrimary },
    emptyBody: { fontSize: fontSize.sm, color: p.textSecondary, textAlign: 'center' },
    error: {
      margin: spacing.md,
      padding: spacing.md,
      borderRadius: 10,
      backgroundColor: p.dangerMuted,
      color: p.danger,
      fontSize: fontSize.sm,
    },
  });
