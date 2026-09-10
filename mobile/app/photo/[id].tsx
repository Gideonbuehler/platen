import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { api, getAccessToken, getServerUrl } from '../../src/lib/api';
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

export default function PhotoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { palette } = useSession();
  const router = useRouter();
  const styles = makeStyles(palette);

  const [asset, setAsset] = useState<Asset | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [loaded, base, token] = await Promise.all([
        api.asset(id),
        getServerUrl(),
        getAccessToken(),
      ]);
      setAsset(loaded);
      if (base && token) {
        setUri(`${base}/api/assets/${id}/preview?token=${token}&v=${loaded.updatedAt}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this photo.');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleFavourite = async () => {
    if (!asset || busy) return;
    setBusy(true);

    // Optimistic: a heart that waits for a round trip feels broken, and the
    // only cost of being wrong is one wrong icon until the next load.
    const next = !asset.isFavorite;
    setAsset({ ...asset, isFavorite: next });
    try {
      await api.updateAsset(asset.id, { isFavorite: next });
    } catch {
      setAsset({ ...asset, isFavorite: !next });
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = () => {
    if (!asset) return;
    Alert.alert(
      'Move to trash?',
      'It stays recoverable for 30 days before being removed for good.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Move to trash',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.deleteAssets([asset.id]);
              router.back();
            } catch (err) {
              Alert.alert('Could not delete', err instanceof Error ? err.message : 'Unknown error');
            }
          },
        },
      ],
    );
  };

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  if (!asset || !uri) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }

  const { width, height } = Dimensions.get('window');
  const wallClock = captureWallClock(asset.takenAt, asset.takenAtOffset);

  return (
    <View style={styles.root}>
      <Stack.Screen
        options={{
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

      <Pressable style={styles.stage} onPress={() => setShowInfo((v) => !v)}>
        <Image
          source={{ uri }}
          style={{ width, height: height * 0.72 }}
          contentFit="contain"
          transition={180}
          cachePolicy="memory-disk"
        />
      </Pressable>

      {showInfo && (
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
    root: { flex: 1, backgroundColor: '#000' },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' },
    stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
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
