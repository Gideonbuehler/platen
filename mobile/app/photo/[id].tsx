import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { api, getAccessToken, getServerUrl } from '../../src/lib/api';
import { getViewerAssets, indexOfAsset } from '../../src/lib/viewer';
import { useSession } from '../../src/lib/session';
import { fontSize, radius, spacing } from '../../src/lib/theme';
import type { Asset } from '../../src/types';

/** The camera's own wall clock, matching the web client. */
function captureWallClock(takenAt: string, offset: string | null): Date {
  const instant = new Date(takenAt);
  if (!offset) return instant;
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
  if (!match) return instant;
  const sign = match[1] === '-' ? -1 : 1;
  return new Date(instant.getTime() + sign * (Number(match[2]) * 60 + Number(match[3])) * 60_000);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * One video page.
 *
 * Its own component so the player hook is scoped to a single asset — a hook
 * cannot be called per item inside a list render. Playback is tied to whether
 * this page is the visible one, or every video in the window would play at
 * once, several soundtracks over each other.
 */
function VideoPage({
  uri,
  poster,
  isActive,
  width,
  height,
}: {
  uri: string;
  poster: string;
  isActive: boolean;
  width: number;
  height: number;
}) {
  const player = useVideoPlayer(uri, (instance) => {
    instance.loop = false;
  });

  useEffect(() => {
    if (isActive) player.play();
    else player.pause();
  }, [isActive, player]);

  return (
    <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
      {/* The poster sits underneath so the frame is filled while the stream
          buffers, rather than a black rectangle. */}
      <Image
        source={{ uri: poster }}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        cachePolicy="memory-disk"
      />
      <VideoView
        player={player}
        style={{ width, height }}
        contentFit="contain"
        nativeControls
        allowsFullscreen
        allowsPictureInPicture
      />
    </View>
  );
}

export default function PhotoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { palette } = useSession();
  const router = useRouter();
  const styles = makeStyles(palette);

  const listRef = useRef<FlatList<Asset>>(null);
  const { width, height } = Dimensions.get('window');

  // The list the grid was showing. A cold deep link finds nothing here and
  // falls back to fetching just the one asset.
  const [assets, setAssets] = useState<Asset[]>(() => {
    const shared = getViewerAssets();
    return indexOfAsset(id) >= 0 ? shared : [];
  });
  const [index, setIndex] = useState(() => Math.max(0, indexOfAsset(id)));
  const [showInfo, setShowInfo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setBase(await getServerUrl());
      setToken(await getAccessToken());
    })();
  }, []);

  useEffect(() => {
    if (assets.length > 0) return;
    void (async () => {
      try {
        setAssets([await api.asset(id)]);
        setIndex(0);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load this photo.');
      }
    })();
  }, [id, assets.length]);

  const asset = assets[index];

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: { index: number | null }[] }) => {
      const first = viewableItems[0];
      if (first?.index != null) setIndex(first.index);
    },
  ).current;

  // 60% means a page counts as current only once it clearly dominates the
  // screen, so playback does not start on a video half-swiped past.
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;

  const toggleFavourite = useCallback(async () => {
    if (!asset) return;
    const next = !asset.isFavorite;

    // Optimistic: a heart that waits for a round trip feels broken, and being
    // wrong costs one wrong icon until the next load.
    setAssets((list) =>
      list.map((item) => (item.id === asset.id ? { ...item, isFavorite: next } : item)),
    );
    try {
      await api.updateAsset(asset.id, { isFavorite: next });
    } catch {
      setAssets((list) =>
        list.map((item) => (item.id === asset.id ? { ...item, isFavorite: !next } : item)),
      );
    }
  }, [asset]);

  const confirmDelete = useCallback(() => {
    if (!asset) return;
    Alert.alert('Move to trash?', 'It stays recoverable for 30 days.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Move to trash',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteAssets([asset.id]);
            // Drop it from the pager and stay put, rather than kicking the
            // user back to the grid after every single delete.
            setAssets((list) => {
              const next = list.filter((item) => item.id !== asset.id);
              if (next.length === 0) router.back();
              return next;
            });
            setIndex((current) => Math.min(current, assets.length - 2));
          } catch (err) {
            Alert.alert('Could not delete', err instanceof Error ? err.message : 'Unknown error');
          }
        },
      },
    ]);
  }, [asset, assets.length, router]);

  const getItemLayout = useCallback(
    (_: unknown, i: number) => ({ length: width, offset: width * i, index: i }),
    [width],
  );

  const wallClock = useMemo(
    () => (asset ? captureWallClock(asset.takenAt, asset.takenAtOffset) : null),
    [asset],
  );

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  if (!asset || !base || !token) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <Text style={styles.headerTitle}>
              {assets.length > 1 ? `${index + 1} of ${assets.length}` : ''}
            </Text>
          ),
          headerRight: () => (
            <View style={styles.actions}>
              <Pressable onPress={toggleFavourite} hitSlop={10}>
                <Ionicons
                  name={asset.isFavorite ? 'heart' : 'heart-outline'}
                  size={22}
                  color={asset.isFavorite ? palette.accent : '#fff'}
                />
              </Pressable>
              <Pressable onPress={() => setShowInfo((v) => !v)} hitSlop={10}>
                <Ionicons name="information-circle-outline" size={22} color="#fff" />
              </Pressable>
              <Pressable onPress={confirmDelete} hitSlop={10}>
                <Ionicons name="trash-outline" size={22} color="#fff" />
              </Pressable>
            </View>
          ),
        }}
      />

      <FlatList
        ref={listRef}
        data={assets}
        keyExtractor={(item) => item.id}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={index}
        getItemLayout={getItemLayout}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        // Keep the neighbours mounted so a swipe reveals a loaded image, but
        // no more than that — a mounted video page holds a decoder.
        windowSize={3}
        maxToRenderPerBatch={3}
        renderItem={({ item, index: itemIndex }) => {
          const preview = `${base}/api/assets/${item.id}/preview?token=${token}&v=${item.updatedAt}`;

          if (item.type === 'video') {
            return (
              <VideoPage
                uri={`${base}/api/assets/${item.id}/original?token=${token}`}
                poster={preview}
                isActive={itemIndex === index}
                width={width}
                height={height * 0.75}
              />
            );
          }

          return (
            <Pressable
              onPress={() => setShowInfo((v) => !v)}
              style={{ width, height: height * 0.75, alignItems: 'center', justifyContent: 'center' }}
            >
              <Image
                source={{ uri: preview }}
                style={{ width, height: height * 0.75 }}
                contentFit="contain"
                transition={140}
                cachePolicy="memory-disk"
                recyclingKey={item.id}
              />
            </Pressable>
          );
        }}
      />

      {showInfo && wallClock && (
        <ScrollView style={styles.panel} contentContainerStyle={styles.panelContent}>
          <Text style={styles.panelTitle}>{asset.originalFilename}</Text>

          <Row
            label="Taken"
            value={wallClock.toLocaleDateString(undefined, {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
              timeZone: 'UTC',
            })}
            palette={palette}
          />

          <Row
            label="File"
            value={`${formatBytes(asset.fileSize)}${
              asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ''
            }`}
            palette={palette}
          />

          {asset.exif?.make && (
            <Row
              label="Camera"
              value={`${asset.exif.make} ${asset.exif.model ?? ''}`.trim()}
              palette={palette}
            />
          )}

          {asset.exif?.lens && <Row label="Lens" value={asset.exif.lens} palette={palette} />}

          {(asset.exif?.fNumber || asset.exif?.iso) && (
            <View style={styles.chips}>
              {asset.exif.fNumber ? <Text style={styles.chip}>ƒ/{asset.exif.fNumber}</Text> : null}
              {asset.exif.exposureTime ? (
                <Text style={styles.chip}>{asset.exif.exposureTime}s</Text>
              ) : null}
              {asset.exif.iso ? <Text style={styles.chip}>ISO {asset.exif.iso}</Text> : null}
              {asset.exif.focalLength ? (
                <Text style={styles.chip}>{Math.round(asset.exif.focalLength)}mm</Text>
              ) : null}
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

function Row({
  label,
  value,
  palette,
}: {
  label: string;
  value: string;
  palette: ReturnType<typeof useSession>['palette'];
}) {
  const styles = makeStyles(palette);
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

const makeStyles = (p: ReturnType<typeof useSession>['palette']) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: '#000', justifyContent: 'center' },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' },
    headerTitle: { color: '#fff', fontSize: fontSize.sm, fontVariant: ['tabular-nums'] },
    actions: { flexDirection: 'row', gap: spacing.lg, paddingRight: spacing.sm },
    error: { color: p.danger, fontSize: fontSize.sm, padding: spacing.xl, textAlign: 'center' },
    panel: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      maxHeight: '45%',
      backgroundColor: p.surfaceRaised,
      borderTopLeftRadius: radius.xl,
      borderTopRightRadius: radius.xl,
    },
    panelContent: { padding: spacing.lg, gap: spacing.md },
    panelTitle: { fontSize: fontSize.md, fontWeight: '600', color: p.textPrimary },
    row: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
    label: { fontSize: fontSize.sm, color: p.textTertiary },
    value: { flexShrink: 1, fontSize: fontSize.sm, color: p.textPrimary, textAlign: 'right' },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    chip: {
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
      borderRadius: radius.sm,
      backgroundColor: p.surfaceOverlay,
      color: p.textSecondary,
      fontSize: fontSize.xs,
    },
  });
