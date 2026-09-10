import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider, useSession } from '../src/lib/session';
import '../src/lib/backgroundTask'; // registers the TaskManager task definition

/**
 * Auth gate.
 *
 * The task definition must be imported at module scope (above) rather than
 * inside a component: iOS wakes the app straight into the background task, and
 * TaskManager throws if the task is not already defined when that happens.
 */
function RootNavigator() {
  const { user, loading, palette, isDark } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;

    // `segments[0]` is 'login' on the sign-in screen and '(tabs)' inside the
    // app, so a group never confuses the gate.
    const onLoginScreen = segments[0] === 'login';
    if (!user && !onLoginScreen) router.replace('/login');
    else if (user && onLoginScreen) router.replace('/');
  }, [user, loading, segments, router]);

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: palette.surfaceBase,
        }}
      >
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }

  return (
    <>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: palette.surfaceBase },
          headerTintColor: palette.textPrimary,
          headerTitleStyle: { fontWeight: '600' },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: palette.surfaceBase },
        }}
      >
        {/* The tab group brings its own headers. */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="backup" options={{ title: 'Backup' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen name="album/[id]" />
        <Stack.Screen name="person/[id]" />
        <Stack.Screen name="collection/[kind]" />
        <Stack.Screen
          name="photo/[id]"
          options={{ title: '', headerTransparent: true, animation: 'fade' }}
        />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <RootNavigator />
      </SessionProvider>
    </SafeAreaProvider>
  );
}
