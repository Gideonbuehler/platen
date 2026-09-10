import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, getAccessToken, getServerUrl } from '../../src/lib/api';
import { getViewerAssets, indexOfAsset } from '../../src/lib/viewer';
import { Scrim } from '../../src/components/Scrim';
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
 * cannot be called per item inside a list render. Playback follows visibility,
 * or every video in the mounted window would play at once.
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
    <View style={{ width, height }}>
      {/* Behind the player so the frame is filled while the stream buffers,
          instead of a black rectangle. */}
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
  const insets = useSafeAreaInsets();
  const styles = makeStyles(palette);

  const { width, height } = Dimensions.get('window');

  const [assets, setAssets] = useState<Asset[]>(() =>
    indexOfAsset(id) >= 0 ? getViewerAssets() : [],
  );
  const [index, setIndex] = useState(() => Math.max(0, indexOfAsset(id)));
  const [error, setError] = useState<string | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  /**
   * Chrome and the info sheet are overlays, never layout.
   *
   * The previous version reserved a quarter of the screen for metadata that
   * was usually hidden, so every photo sat in a letterbox above dead space.
   * Media now fills the screen and everything else floats above it.
   */
  const [chromeVisible, setChromeVisible] = useState(true);
  const [infoOpen, setInfoOpen] = useState(false);

  const chrome = useRef(new Animated.Value(1)).current;
  const sheet = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(chrome, {
      toValue: chromeVisible ? 1 : 0,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [chromeVisible, chrome]);

  useEffect(() => {
    Animated.timing(sheet, {
      toValue: infoOpen ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [infoOpen, sheet]);

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

  // 60%: a page is only "current" once it clearly dominates the screen, so
  // playback never starts on a video half-swiped past.
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;

  const toggleFavourite = useCallback(async () => {
    if (!asset) return;
    const next = !asset.isFavorite;

    // Optimistic: a heart that waits for a round trip feels broken.
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
            setAssets((list) => {
              const next = list.filter((item) => item.id !== asset.id);
              if (next.length === 0) router.back();
              return next;
            });
            setIndex((current) => Math.max(0, Math.min(current, assets.length - 2)));
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
      <Stack.Screen options={{ headerShown: false }} />

      {/* ---- Media, edge to edge -------------------------------------- */}
      <FlatList
        data={assets}
        keyExtractor={(item) => item.id}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={index}
        getItemLayout={getItemLayout}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
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
                height={height}
              />
            );
          }

          return (
            <Pressable
              onPress={() => setChromeVisible((v) => !v)}
              style={{ width, height }}
            >
              <Image
                source={{ uri: preview }}
                style={{ width, height }}
                contentFit="contain"
                transition={140}
                cachePolicy="memory-disk"
                recyclingKey={item.id}
              />
            </Pressable>
          );
        }}
      />

      {/* ---- Top chrome ------------------------------------------------ */}
      <Animated.View
        style={[styles.topBar, { opacity: chrome, paddingTop: insets.top + spacing.sm }]}
        pointerEvents={chromeVisible ? 'auto' : 'none'}
      >
        {/* A gradient rather than a flat bar: icons stay legible over a bright
            photo without stamping a solid slab across the top of it. */}
        <Scrim from="top" opacity={0.65} />
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.iconButton}>
          <Ionicons name="chevron-back" size={26} color="#fff" />
        </Pressable>

        {assets.length > 1 && (
          <Text style={styles.counter}>
            {index + 1} / {assets.length}
          </Text>
        )}
      </Animated.View>

      {/* ---- Bottom actions -------------------------------------------- */}
      <Animated.View
        style={[styles.bottomBar, { opacity: chrome, paddingBottom: insets.bottom + spacing.md }]}
        pointerEvents={chromeVisible ? 'auto' : 'none'}
      >
        <Scrim from="bottom" opacity={0.7} />

        <Action
          icon={asset.isFavorite ? 'heart' : 'heart-outline'}
          label="Favourite"
          tint={asset.isFavorite ? palette.accent : '#fff'}
          onPress={toggleFavourite}
          palette={palette}
        />
        <Action
          icon="information-circle-outline"
          label="Info"
          onPress={() => setInfoOpen(true)}
          palette={palette}
        />
        <Action icon="trash-outline" label="Delete" onPress={confirmDelete} palette={palette} />
      </Animated.View>

      {/* ---- Info sheet ------------------------------------------------- */}
      {infoOpen && (
        <>
          <Animated.View style={[styles.scrim, { opacity: sheet }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setInfoOpen(false)} />
          </Animated.View>

          <Animated.View
            style={[
              styles.sheet,
              {
                paddingBottom: insets.bottom + spacing.lg,
                transform: [
                  { translateY: sheet.interpolate({ inputRange: [0, 1], outputRange: [400, 0] }) },
                ],
              },
            ]}
          >
            <View style={styles.grabber} />

            <ScrollView contentContainerStyle={styles.sheetContent}>
              <Text style={styles.sheetTitle} numberOfLines={1}>
                {asset.originalFilename}
              </Text>

              {wallClock && (
                <Text style={styles.sheetDate}>
                  {wallClock.toLocaleDateString(undefined, {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                    timeZone: 'UTC',
                  })}
                </Text>
              )}

              {(asset.exif?.fNumber || asset.exif?.iso || asset.exif?.focalLength) && (
                <View style={styles.chips}>
                  {asset.exif.fNumber ? (
                    <Text style={styles.chip}>ƒ/{asset.exif.fNumber}</Text>
                  ) : null}
                  {asset.exif.exposureTime ? (
                    <Text style={styles.chip}>{asset.exif.exposureTime}s</Text>
                  ) : null}
                  {asset.exif.iso ? <Text style={styles.chip}>ISO {asset.exif.iso}</Text> : null}
                  {asset.exif.focalLength ? (
                    <Text style={styles.chip}>{Math.round(asset.exif.focalLength)}mm</Text>
                  ) : null}
                </View>
              )}

              <View style={styles.divider} />

              {asset.exif?.make && (
                <Detail
                  icon="camera-outline"
                  primary={`${asset.exif.make} ${asset.exif.model ?? ''}`.trim()}
                  secondary={asset.exif.lens ?? undefined}
                  palette={palette}
                />
              )}

              <Detail
                icon="document-outline"
                primary={formatBytes(asset.fileSize)}
                secondary={
                  asset.width && asset.height ? `${asset.width} × ${asset.height}` : undefined
                }
                palette={palette}
              />

              {asset.exif?.latitude != null && asset.exif?.longitude != null && (
                <Detail
                  icon="location-outline"
                  primary={
                    [asset.exif.city, asset.exif.country].filter(Boolean).join(', ') || 'Location'
                  }
                  secondary={`${asset.exif.latitude.toFixed(4)}, ${asset.exif.longitude.toFixed(4)}`}
                  palette={palette}
                />
              )}
            </ScrollView>
          </Animated.View>
        </>
      )}
    </View>
  );
}

function Action({
  icon,
  label,
  tint = '#fff',
  onPress,
  palette,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  tint?: string;
  onPress: () => void;
  palette: ReturnType<typeof useSession>['palette'];
}) {
  const styles = makeStyles(palette);
  return (
    <Pressable style={styles.action} onPress={onPress} hitSlop={8}>
      <Ionicons name={icon} size={24} color={tint} />
      <Text style={[styles.actionLabel, { color: tint }]}>{label}</Text>
    </Pressable>
  );
}

function Detail({
  icon,
  primary,
  secondary,
  palette,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  primary: string;
  secondary?: string;
  palette: ReturnType<typeof useSession>['palette'];
}) {
  const styles = makeStyles(palette);
  return (
    <View style={styles.detail}>
      <Ionicons name={icon} size={19} color={palette.textTertiary} />
      <View style={styles.detailText}>
        <Text style={styles.detailPrimary}>{primary}</Text>
        {secondary && <Text style={styles.detailSecondary}>{secondary}</Text>}
      </View>
    </View>
  );
}

const makeStyles = (p: ReturnType<typeof useSession>['palette']) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: '#000' },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' },
    error: { color: p.danger, fontSize: fontSize.sm, padding: spacing.xl, textAlign: 'center' },

    topBar: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.sm,
      paddingBottom: spacing.lg,
    },
    iconButton: { padding: spacing.xs },
    counter: {
      color: 'rgba(255,255,255,0.9)',
      fontSize: fontSize.sm,
      fontVariant: ['tabular-nums'],
      paddingRight: spacing.md,
    },

    bottomBar: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      flexDirection: 'row',
      justifyContent: 'space-around',
      alignItems: 'flex-end',
      paddingTop: spacing.xxl,
    },
    action: { alignItems: 'center', gap: 3, paddingHorizontal: spacing.lg },
    actionLabel: { fontSize: 11 },

    scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
    sheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      maxHeight: '62%',
      backgroundColor: p.surfaceRaised,
      borderTopLeftRadius: radius.xl,
      borderTopRightRadius: radius.xl,
    },
    grabber: {
      alignSelf: 'center',
      width: 36,
      height: 4,
      marginTop: spacing.sm,
      borderRadius: radius.full,
      backgroundColor: p.borderDefault,
    },
    sheetContent: { padding: spacing.lg, gap: spacing.md },
    sheetTitle: { fontSize: fontSize.lg, fontWeight: '600', color: p.textPrimary },
    sheetDate: { fontSize: fontSize.sm, color: p.textSecondary, marginTop: -spacing.sm },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    chip: {
      paddingHorizontal: spacing.md,
      paddingVertical: 5,
      borderRadius: radius.full,
      backgroundColor: p.surfaceOverlay,
      color: p.textSecondary,
      fontSize: fontSize.xs,
      overflow: 'hidden',
    },
    divider: { height: 1, backgroundColor: p.borderSubtle },
    detail: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    detailText: { flex: 1 },
    detailPrimary: { fontSize: fontSize.sm, color: p.textPrimary },
    detailSecondary: { fontSize: fontSize.xs, color: p.textTertiary, marginTop: 1 },
  });
