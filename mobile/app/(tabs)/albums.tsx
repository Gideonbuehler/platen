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
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { api, getAccessToken, getServerUrl } from '../../src/lib/api';
import { useSession } from '../../src/lib/session';
import { fontSize, radius, spacing } from '../../src/lib/theme';
import type { Album } from '../../src/types';

const COLUMNS = 2;

export default function AlbumsScreen() {
  const { palette, user } = useSession();
  const router = useRouter();
  const styles = makeStyles(palette);

  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setBase(await getServerUrl());
      setToken(await getAccessToken());
    })();
  }, [user]);

  const load = useCallback(async () => {
    try {
      setError(null);
      setAlbums(await api.albums());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load albums.');
    }
  }, []);

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, [load]);

  const size = (Dimensions.get('window').width - spacing.md * 3) / COLUMNS;

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {error && <Text style={styles.error}>{error}</Text>}

      <FlatList
        data={albums}
        numColumns={COLUMNS}
        keyExtractor={(album) => album.id}
        contentContainerStyle={styles.list}
        columnWrapperStyle={styles.row}
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
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="albums-outline" size={36} color={palette.textTertiary} />
            <Text style={styles.emptyTitle}>No albums yet</Text>
            <Text style={styles.emptyBody}>
              Albums you create on the web appear here. Grouping photos makes them far easier to
              find later, and to share.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable style={{ width: size }} onPress={() => router.push(`/album/${item.id}`)}>
            <View style={[styles.cover, { width: size, height: size }]}>
              {item.coverAssetId && base && token ? (
                <Image
                  source={{
                    uri: `${base}/api/assets/${item.coverAssetId}/thumbnail?token=${token}&v=${item.updatedAt}`,
                  }}
                  style={styles.coverImage}
                  contentFit="cover"
                  transition={160}
                  cachePolicy="memory-disk"
                />
              ) : (
                <View style={styles.coverEmpty}>
                  <Ionicons name="albums-outline" size={24} color={palette.textTertiary} />
                </View>
              )}
            </View>

            <Text style={styles.name} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={styles.count}>
              {item.assetCount} {item.assetCount === 1 ? 'item' : 'items'}
            </Text>
          </Pressable>
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
    list: { padding: spacing.md, gap: spacing.lg },
    row: { gap: spacing.md },
    cover: {
      borderRadius: radius.lg,
      overflow: 'hidden',
      backgroundColor: p.surfaceRaised,
    },
    coverImage: { width: '100%', height: '100%' },
    coverEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    name: {
      marginTop: spacing.sm,
      fontSize: fontSize.sm,
      fontWeight: '500',
      color: p.textPrimary,
    },
    count: { fontSize: fontSize.xs, color: p.textTertiary },
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
      borderRadius: radius.md,
      backgroundColor: p.dangerMuted,
      color: p.danger,
      fontSize: fontSize.sm,
    },
  });
