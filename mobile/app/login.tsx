import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { api, normaliseServerUrl, setServerUrl } from '../src/lib/api';
import { deviceLabel, useSession } from '../src/lib/session';
import { fontSize, radius, spacing } from '../src/lib/theme';
import type { ServerInfo } from '../src/types';

/**
 * Two-step sign-in: find the server, then authenticate.
 *
 * Splitting them matters on a self-hosted app. "Login failed" is useless when
 * the real problem is a typo in the address or a phone on mobile data instead
 * of the home wifi — so the first step validates the URL and reports exactly
 * what went wrong.
 */
export default function LoginScreen() {
  const { palette, signIn } = useSession();

  const [step, setStep] = useState<'server' | 'credentials'>('server');
  const [url, setUrl] = useState('');
  const [info, setInfo] = useState<ServerInfo | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const styles = makeStyles(palette);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const normalised = normaliseServerUrl(url);
      const serverInfo = await api.serverInfo(normalised);
      await setServerUrl(normalised);
      setInfo(serverInfo);
      setStep('credentials');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach that server.');
    } finally {
      setBusy(false);
    }
  };

  const authenticate = async () => {
    setBusy(true);
    setError(null);
    try {
      const user = info?.needsOnboarding
        ? await api.register(email, password, name, deviceLabel)
        : await api.login(email, password, deviceLabel);
      await signIn(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.brand}>Aperture</Text>
          <Text style={styles.tagline}>
            {step === 'server'
              ? 'Connect to your photo server.'
              : info?.needsOnboarding
                ? 'Create the first account on this server.'
                : `Signing in to ${normaliseServerUrl(url).replace(/^https?:\/\//, '')}`}
          </Text>
        </View>

        {step === 'server' ? (
          <View style={styles.form}>
            <Text style={styles.label}>Server address</Text>
            <TextInput
              style={styles.input}
              value={url}
              onChangeText={setUrl}
              placeholder="tower.local:2283"
              placeholderTextColor={palette.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              onSubmitEditing={connect}
              editable={!busy}
            />
            <Text style={styles.hint}>
              The address you use in a browser. http:// is assumed if you leave the scheme off.
            </Text>

            {error && <Text style={styles.error}>{error}</Text>}

            <Pressable
              style={[styles.button, (!url.trim() || busy) && styles.buttonDisabled]}
              onPress={connect}
              disabled={!url.trim() || busy}
            >
              {busy ? (
                <ActivityIndicator color={palette.accentContrast} />
              ) : (
                <Text style={styles.buttonText}>Connect</Text>
              )}
            </Pressable>
          </View>
        ) : (
          <View style={styles.form}>
            {info?.needsOnboarding && (
              <>
                <Text style={styles.label}>Name</Text>
                <TextInput
                  style={styles.input}
                  value={name}
                  onChangeText={setName}
                  placeholderTextColor={palette.textTertiary}
                  autoCapitalize="words"
                  editable={!busy}
                />
              </>
            )}

            <Text style={styles.label}>Email</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor={palette.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              editable={!busy}
            />

            <Text style={styles.label}>Password</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholderTextColor={palette.textTertiary}
              returnKeyType="go"
              onSubmitEditing={authenticate}
              editable={!busy}
            />

            {error && <Text style={styles.error}>{error}</Text>}

            <Pressable
              style={[styles.button, busy && styles.buttonDisabled]}
              onPress={authenticate}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color={palette.accentContrast} />
              ) : (
                <Text style={styles.buttonText}>
                  {info?.needsOnboarding ? 'Create account' : 'Sign in'}
                </Text>
              )}
            </Pressable>

            <Pressable
              onPress={() => {
                setStep('server');
                setError(null);
              }}
            >
              <Text style={styles.switch}>Use a different server</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (p: ReturnType<typeof useSession>['palette']) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: p.surfaceBase },
    scroll: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl },
    header: { marginBottom: spacing.xxl },
    brand: {
      fontSize: fontSize.xxl,
      fontWeight: '700',
      color: p.textPrimary,
      letterSpacing: -0.5,
    },
    tagline: { marginTop: spacing.sm, fontSize: fontSize.md, color: p.textSecondary },
    form: { gap: spacing.sm },
    label: {
      marginTop: spacing.md,
      marginBottom: spacing.xs,
      fontSize: fontSize.sm,
      fontWeight: '500',
      color: p.textSecondary,
    },
    input: {
      height: 48,
      paddingHorizontal: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: p.borderDefault,
      backgroundColor: p.surfaceRaised,
      color: p.textPrimary,
      fontSize: fontSize.md,
    },
    hint: { marginTop: spacing.sm, fontSize: fontSize.xs, color: p.textTertiary, lineHeight: 17 },
    error: {
      marginTop: spacing.md,
      padding: spacing.md,
      borderRadius: radius.md,
      backgroundColor: p.dangerMuted,
      color: p.danger,
      fontSize: fontSize.sm,
    },
    button: {
      height: 50,
      marginTop: spacing.xl,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.md,
      backgroundColor: p.accent,
    },
    buttonDisabled: { opacity: 0.45 },
    buttonText: { fontSize: fontSize.md, fontWeight: '600', color: p.accentContrast },
    switch: {
      marginTop: spacing.xl,
      textAlign: 'center',
      fontSize: fontSize.sm,
      color: p.textSecondary,
    },
  });
