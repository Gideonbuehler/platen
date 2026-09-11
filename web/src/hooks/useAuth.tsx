import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ServerInfo, User } from '@platen/shared';
import { api, isAuthenticated, onAuthChange } from '../lib/api';

interface AuthContextValue {
  user: User | null;
  serverInfo: ServerInfo | null;
  /** True until the initial session restore finishes. */
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();

  // Restore an existing session on load, and find out whether this server still
  // needs its first account.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const info = await api.serverInfo();
        if (!cancelled) setServerInfo(info);
      } catch {
        // Server unreachable; the login screen surfaces this on first attempt.
      }

      if (isAuthenticated()) {
        try {
          const me = await api.me();
          if (!cancelled) setUser(me);
        } catch {
          if (!cancelled) setUser(null);
        }
      }

      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // The api module signs out on an unrecoverable 401 (expired refresh token);
  // mirror that into React state so the router redirects immediately.
  useEffect(
    () =>
      onAuthChange((authenticated) => {
        if (!authenticated) {
          setUser(null);
          queryClient.clear();
        }
      }),
    [queryClient],
  );

  const login = useCallback(async (email: string, password: string) => {
    setUser(await api.login(email, password));
  }, []);

  const register = useCallback(async (email: string, password: string, name: string) => {
    const created = await api.register(email, password, name);
    setUser(created);
    // The first registration flips needsOnboarding; keep the cached info honest.
    setServerInfo((prev) => (prev ? { ...prev, needsOnboarding: false } : prev));
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
    queryClient.clear();
  }, [queryClient]);

  const refreshUser = useCallback(async () => {
    try {
      setUser(await api.me());
    } catch {
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, serverInfo, loading, login, register, logout, refreshUser }),
    [user, serverInfo, loading, login, register, logout, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
