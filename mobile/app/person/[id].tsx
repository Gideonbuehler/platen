import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { PhotoGrid } from '../../src/components/PhotoGrid';
import { api } from '../../src/lib/api';
import { useSession } from '../../src/lib/session';
import { fontSize, radius, spacing } from '../../src/lib/theme';
import type { Asset, Person } from '../../src/types';

export default function PersonScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { palette } = useSession();
  const styles = makeStyles(palette);

  const [person, setPerson] = useState<Person | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [detail, page] = await Promise.all([api.person(id), api.personAssets(id)]);
      setPerson(detail);
      setAssets(page.items);
      if (!editing) setDraft(detail.name ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this person.');
    }
  }, [id, editing]);

  useEffect(() => {
    void load().finally(() => setLoading(false));
    // `load` changes with `editing`, and re-running then would overwrite what
    // is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const save = async () => {
    try {
      const updated = await api.updatePerson(id, { name: draft.trim() || null });
      setPerson(updated);
      setEditing(false);
    } catch (err) {
      Alert.alert('Could not save', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: person?.name ?? 'Person' }} />
      {error && <Text style={styles.error}>{error}</Text>}

      <PhotoGrid
        assets={assets}
        loading={loading}
        onRefresh={load}
        header={
          person ? (
            <View style={styles.header}>
              {editing ? (
                <View style={styles.nameRow}>
                  <TextInput
                    style={styles.input}
                    value={draft}
                    onChangeText={setDraft}
                    placeholder="Add a name"
                    placeholderTextColor={palette.textTertiary}
                    autoFocus
                    maxLength={120}
                    returnKeyType="done"
                    onSubmitEditing={save}
                  />
                  <Pressable style={styles.save} onPress={save}>
                    <Ionicons name="checkmark" size={18} color={palette.accentContrast} />
                  </Pressable>
                </View>
              ) : (
                // Naming from here beats the People list: the photos are right
                // there, which is what makes an unfamiliar face recognisable.
                <Pressable style={styles.nameRow} onPress={() => setEditing(true)}>
                  <Text style={person.name ? styles.name : styles.namePlaceholder}>
                    {person.name ?? 'Add a name'}
                  </Text>
                  <Ionicons name="pencil" size={15} color={palette.textTertiary} />
                </Pressable>
              )}

              <Text style={styles.subtitle}>
                {person.assetCount} {person.assetCount === 1 ? 'photo' : 'photos'}
              </Text>
            </View>
          ) : null
        }
        empty={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No photos</Text>
            <Text style={styles.emptyBody}>
              The photos this person appeared in may have been deleted.
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
    header: { padding: spacing.md, gap: spacing.xs },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    name: { fontSize: fontSize.xl, fontWeight: '700', color: p.textPrimary },
    namePlaceholder: { fontSize: fontSize.xl, fontWeight: '700', color: p.textTertiary },
    input: {
      flex: 1,
      height: 42,
      paddingHorizontal: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: p.borderDefault,
      backgroundColor: p.surfaceRaised,
      color: p.textPrimary,
      fontSize: fontSize.md,
    },
    save: {
      width: 42,
      height: 42,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.md,
      backgroundColor: p.accent,
    },
    subtitle: { fontSize: fontSize.sm, color: p.textTertiary },
    empty: { alignItems: 'center', padding: spacing.xxl, gap: spacing.sm },
    emptyTitle: { fontSize: fontSize.lg, fontWeight: '600', color: p.textPrimary },
    emptyBody: { fontSize: fontSize.sm, color: p.textSecondary, textAlign: 'center' },
    error: {
      margin: spacing.md,
      padding: spacing.md,
      borderRadius: radius.md,
      backgroundColor: p.dangerMuted,
      color: p.danger,
      fontSize: fontSize.sm,
    },
  });
