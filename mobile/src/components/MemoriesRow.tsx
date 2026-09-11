import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { api, getAccessToken, getServerUrl } from '../lib/api';
import { useSession } from '../lib/session';
import { setViewerAssets } from '../lib/viewer';
import { Scrim } from './Scrim';
import { fontSize, radius, spacing } from '../lib/theme';
import type { Memory } from '../types';

/**
 * "On this day", above the timeline.
 *
 * Renders nothing at all when there is nothing to show, rather than an empty
 * state. A section explaining that you took no photos on this date in previous
 * years is worse than no section: it costs a permanent strip of screen to say
 * nothing, every day, to someone who has only been using the app a month.
 */
export function MemoriesRow() {
  const { palette, user } = useSession();
  const router = useRouter();
  const styles = makeStyles(palette);

  const [memories, setMemories] = useState<Memory[]>([]);
  const [base, setBase] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setBase(await getServerUrl());
      setToken(await getAccessToken());
      try {
        setMemories(await api.memories());
      } catch {
        // A failed memories fetch must never break the timeline beneath it.
        setMemories([]);
      }
    })();
  }, [user]);

  const open = useCallback(
    (memory: Memory) => {
      // The viewer pages through this memory, not the timeline: "next" here
      // means the next photo from that day, which is a different list.
      setViewerAssets(memory.assets);
      const first = memory.assets[0];
      if (first) router.push(`/photo/${first.id}`);
    },
    [router],
  );

  if (memories.length === 0 || !base || !token) return null;

  return (
    <View style={styles.root}>
      <Text style={styles.heading}>On this day</Text>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {memories.map((memory) => {
          const cover = memory.assets[0];
          if (!cover) return null;

          return (
            <Pressable key={memory.year} style={styles.card} onPress={() => open(memory)}>
              <Image
                source={{
                  uri: `${base}/api/assets/${cover.id}/thumbnail?token=${token}&v=${cover.updatedAt}`,
                }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                transition={160}
                cachePolicy="memory-disk"
              />

              <Scrim from="bottom" opacity={0.72} />

              <View style={styles.caption}>
                <Text style={styles.years}>
                  {memory.yearsAgo === 1 ? 'A year ago' : `${memory.yearsAgo} years ago`}
                </Text>
                <Text style={styles.count}>
                  {memory.assetCount} {memory.assetCount === 1 ? 'photo' : 'photos'}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const makeStyles = (p: ReturnType<typeof useSession>['palette']) =>
  StyleSheet.create({
    root: { paddingTop: spacing.md, paddingBottom: spacing.sm },
    heading: {
      paddingHorizontal: spacing.md,
      paddingBottom: spacing.sm,
      fontSize: fontSize.md,
      fontWeight: '600',
      color: p.textPrimary,
    },
    row: { paddingHorizontal: spacing.md, gap: spacing.sm },
    card: {
      width: 132,
      height: 168,
      borderRadius: radius.lg,
      overflow: 'hidden',
      backgroundColor: p.surfaceRaised,
    },
    caption: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      padding: spacing.sm,
      gap: 1,
    },
    years: { fontSize: fontSize.sm, fontWeight: '600', color: '#fff' },
    count: { fontSize: fontSize.xs, color: 'rgba(255,255,255,0.75)' },
  });
