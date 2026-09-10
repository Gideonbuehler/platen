import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { PhotoGrid } from '../../src/components/PhotoGrid';
import { api } from '../../src/lib/api';
import { useSession } from '../../src/lib/session';
import { fontSize, radius, spacing } from '../../src/lib/theme';
import type { Asset, SearchStatus } from '../../src/types';

/** Teaches what semantic search can do; an empty box teaches nothing. */
const SUGGESTIONS = [
  'sunset over water',
  'snow on mountains',
  'birthday cake',
  'dog on a beach',
  'city at night',
  'a plate of food',
];

export default function SearchScreen() {
  const { palette } = useSession();
  const styles = makeStyles(palette);

  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Asset[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SearchStatus | null>(null);

  useEffect(() => {
    void api.searchStatus().then(setStatus).catch(() => {});
  }, []);

  // Debounce: each keystroke would otherwise queue a CLIP text encode on a
  // server that may be a Raspberry Pi.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), 400);
    return () => clearTimeout(timer);
  }, [input]);

  useEffect(() => {
    if (query.length === 0) {
      setResults([]);
      setError(null);
      return;
    }

    let cancelled = false;
    setSearching(true);

    void (async () => {
      try {
        setError(null);
        // Falls back to metadata search when the server has ML switched off,
        // so the tab is never simply dead.
        const found = status?.enabled
          ? (await api.search(query)).map((hit) => hit.asset)
          : await api.searchMetadata(query);
        if (!cancelled) setResults(found);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Search failed.');
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [query, status?.enabled]);

  const semantic = status?.enabled ?? false;

  return (
    <View style={styles.root}>
      <View style={styles.field}>
        <Ionicons name="search" size={18} color={palette.textTertiary} />
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={semantic ? 'Describe a photo' : 'Filename, camera, place'}
          placeholderTextColor={palette.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {searching && <ActivityIndicator size="small" color={palette.accent} />}
        {input.length > 0 && !searching && (
          <Pressable onPress={() => setInput('')} hitSlop={8}>
            <Ionicons name="close-circle" size={18} color={palette.textTertiary} />
          </Pressable>
        )}
      </View>

      {status && semantic && status.pending > 0 && (
        <Text style={styles.notice}>
          Indexing {status.indexed.toLocaleString()} of {status.total.toLocaleString()} photos —
          results improve as it finishes.
        </Text>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {query.length === 0 ? (
        <ScrollView contentContainerStyle={styles.suggestions}>
          <Text style={styles.suggestionsLabel}>Try searching for…</Text>
          <View style={styles.chips}>
            {SUGGESTIONS.map((suggestion) => (
              <Pressable key={suggestion} style={styles.chip} onPress={() => setInput(suggestion)}>
                <Text style={styles.chipText}>{suggestion}</Text>
              </Pressable>
            ))}
          </View>

          {!semantic && (
            <Text style={styles.notice}>
              Natural-language search is off on this server, so this searches filenames and camera
              details only.
            </Text>
          )}
        </ScrollView>
      ) : (
        <PhotoGrid
          assets={results}
          // Results are ranked by relevance, so grouping them by date would
          // scatter the best matches down the page.
          groupByDate={false}
          header={
            results.length > 0 ? (
              <Text style={styles.count}>
                {results.length} {results.length === 1 ? 'result' : 'results'}
              </Text>
            ) : null
          }
          empty={
            searching ? null : (
              <View style={styles.empty}>
                <Ionicons name="search-outline" size={36} color={palette.textTertiary} />
                <Text style={styles.emptyTitle}>No matches</Text>
                <Text style={styles.emptyBody}>
                  {semantic
                    ? 'Try describing the scene differently — colours, objects, or the place.'
                    : 'Try part of a filename, or a camera model.'}
                </Text>
              </View>
            )
          }
        />
      )}
    </View>
  );
}

const makeStyles = (p: ReturnType<typeof useSession>['palette']) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: p.surfaceBase },
    field: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      margin: spacing.md,
      paddingHorizontal: spacing.md,
      height: 44,
      borderRadius: radius.full,
      backgroundColor: p.surfaceRaised,
      borderWidth: 1,
      borderColor: p.borderSubtle,
    },
    input: { flex: 1, color: p.textPrimary, fontSize: fontSize.md },
    count: {
      paddingHorizontal: spacing.md,
      paddingBottom: spacing.sm,
      fontSize: fontSize.sm,
      color: p.textTertiary,
    },
    notice: {
      marginHorizontal: spacing.md,
      marginBottom: spacing.sm,
      fontSize: fontSize.xs,
      color: p.textTertiary,
      lineHeight: 17,
    },
    error: {
      margin: spacing.md,
      padding: spacing.md,
      borderRadius: radius.md,
      backgroundColor: p.dangerMuted,
      color: p.danger,
      fontSize: fontSize.sm,
    },
    suggestions: { padding: spacing.md, gap: spacing.md },
    suggestionsLabel: { fontSize: fontSize.sm, color: p.textSecondary },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    chip: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.full,
      backgroundColor: p.surfaceRaised,
      borderWidth: 1,
      borderColor: p.borderSubtle,
    },
    chipText: { fontSize: fontSize.sm, color: p.textSecondary },
    empty: { alignItems: 'center', padding: spacing.xxl, gap: spacing.sm },
    emptyTitle: { fontSize: fontSize.lg, fontWeight: '600', color: p.textPrimary },
    emptyBody: {
      fontSize: fontSize.sm,
      color: p.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
    },
  });
