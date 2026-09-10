import { useEffect, useState } from 'react';
import { ActivityIndicator, Dimensions, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useLocalSearchParams } from 'expo-router';
import { api, getAccessToken, getServerUrl } from '../../src/lib/api';
import { useSession } from '../../src/lib/session';
import { fontSize, radius, spacing } from '../../src/lib/theme';
import type { Asset } from '../../src/types';

export default function PhotoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { palette } = useSession();
  const styles = makeStyles(palette);

  const [asset, setAsset] = useState<Asset | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [loaded, base, token] = await Promise.all([
          api.asset(id),
          getServerUrl(),
          getAccessToken(),
        ]);
        setAsset(loaded);
        if (base && token) setUri(`${base}/api/assets/${id}/preview?token=${token}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load this photo.');
      }
    })();
  }, [id]);

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

  return (
    <View style={styles.root}>
      <Pressable style={styles.stage} onPress={() => setShowInfo((v) => !v)}>
        <Image
          source={{ uri }}
          style={{ width, height: height * 0.75 }}
          contentFit="contain"
          transition={200}
          cachePolicy="memory-disk"
        />
      </Pressable>

      {showInfo && (
        <ScrollView style={styles.panel} contentContainerStyle={styles.panelContent}>
          <Text style={styles.panelTitle}>{asset.originalFilename}</Text>

          <View style={styles.row}>
            <Text style={styles.label}>Taken</Text>
            <Text style={styles.value}>
              {new Date(asset.takenAt).toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                timeZone: 'UTC',
              })}
            </Text>
          </View>

          {asset.width && asset.height && (
            <View style={styles.row}>
              <Text style={styles.label}>Dimensions</Text>
              <Text style={styles.value}>{asset.width} × {asset.height}</Text>
            </View>
          )}

          {asset.exif?.make && (
            <View style={styles.row}>
              <Text style={styles.label}>Camera</Text>
              <Text style={styles.value}>{asset.exif.make} {asset.exif.model}</Text>
            </View>
          )}

          {(asset.exif?.fNumber || asset.exif?.iso) && (
            <View style={styles.chips}>
              {asset.exif.fNumber ? <Text style={styles.chip}>f/{asset.exif.fNumber}</Text> : null}
              {asset.exif.exposureTime ? <Text style={styles.chip}>{asset.exif.exposureTime}s</Text> : null}
              {asset.exif.iso ? <Text style={styles.chip}>ISO {asset.exif.iso}</Text> : null}
              {asset.exif.focalLength ? <Text style={styles.chip}>{Math.round(asset.exif.focalLength)}mm</Text> : null}
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const makeStyles = (p: ReturnType<typeof useSession>['palette']) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: '#000' },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' },
    stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
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
