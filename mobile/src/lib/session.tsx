import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AppState, Platform, useColorScheme } from 'react-native';
import { api, getServerUrl, isSignedIn } from './api';
import { getSettings, runBackup, syncLedgerFromServer } from './backup';
import { registerBackgroundBackup } from './backgroundTask';
import { dark, light, type Palette } from './theme';
import type { User } from '../types';

interface SessionValue {
  user: User | null;
  serverUrl: string | null;
  loading: boolean;
  palette: Palette;
  isDark: boolean;
  signIn: (user: User) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  const [user, setUser] = useState<User | null>(null);
  const [serverUrl, setServerUrlState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const isDark = scheme !== 'light';
  const palette = isDark ? dark : (light as unknown as Palette);

  // Restore the session on launch.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const url = await getServerUrl();
      if (!cancelled) setServerUrlState(url);

      if (url && (await isSignedIn())) {
        try {
          const me = await api.me();
          if (!cancelled) setUser(me);
        } catch {
          // Offline, or the token was revoked. Either way the login screen is
          // the right destination; a stale token is cleared by the API layer.
          if (!cancelled) setUser(null);
        }
      }

      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Opening the app is the one moment we are guaranteed foreground time, so it
  // is also the most reliable point to sync. On iOS especially, this — not the
  // background task — is what actually keeps a library up to date.
  useEffect(() => {
    if (!user) return;

    let running = false;
    const sync = async () => {
      if (running) return;
      const settings = await getSettings();
      if (!settings.enabled) return;

      running = true;
      try {
        await runBackup({ maxItems: 40 });
      } catch {
        // Never surface a foreground sync failure as a crash; the Backup screen
        // shows the real state.
      } finally {
        running = false;
      }
    };

    void sync();

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void sync();
    });
    return () => subscription.remove();
  }, [user]);

  const signIn = useCallback(async (nextUser: User) => {
    setUser(nextUser);
    setServerUrlState(await getServerUrl());

    // A fresh install on an existing account: learn what the server already has
    // before uploading anything.
    await syncLedgerFromServer().catch(() => 0);

    const settings = await getSettings();
    if (settings.enabled) await registerBackgroundBackup().catch(() => {});
  }, []);

  const signOut = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, serverUrl, loading, palette, isDark, signIn, signOut }),
    [user, serverUrl, loading, palette, isDark, signIn, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside <SessionProvider>');
  return context;
}

/** Label shown in the server's session list, so a lost phone is identifiable. */
export const deviceLabel = `${Platform.OS === 'ios' ? 'iPhone' : 'Android'} · Aperture`;
