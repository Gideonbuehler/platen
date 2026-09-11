import { useState, type FormEvent } from 'react';
import { IconLogo, IconSpinner } from '../components/Icons';
import { useAuth } from '../hooks/useAuth';
import './Login.css';

export function LoginPage() {
  const { serverInfo, login, register } = useAuth();

  // A brand-new server has no accounts, so the form must be the sign-up form —
  // there is nothing to sign in to yet.
  const onboarding = serverInfo?.needsOnboarding ?? false;
  const [mode, setMode] = useState<'login' | 'register'>(onboarding ? 'register' : 'login');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isRegister = onboarding || mode === 'register';

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      if (isRegister) await register(email, password, name);
      else await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-aurora" aria-hidden="true" />

      <main className="login-card">
        <div className="login-brand">
          <IconLogo size={34} />
          <h1>Platen</h1>
        </div>

        <p className="login-tagline">
          {onboarding
            ? 'Create the administrator account for this server.'
            : 'Your photos, on your own server.'}
        </p>

        <form onSubmit={onSubmit} className="login-form">
          {isRegister && (
            <div>
              <label className="label" htmlFor="name">
                Name
              </label>
              <input
                id="name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                required
              />
            </div>
          )}

          <div>
            <label className="label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
              autoFocus
            />
          </div>

          <div>
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              minLength={8}
              required
            />
            {isRegister && <p className="login-hint">At least 8 characters.</p>}
          </div>

          {error && (
            <div className="login-error" role="alert">
              {error}
            </div>
          )}

          <button type="submit" className="btn btn-primary login-submit" disabled={busy}>
            {busy ? <IconSpinner size={17} /> : null}
            {isRegister ? 'Create account' : 'Sign in'}
          </button>
        </form>

        {!onboarding && serverInfo?.allowRegistration && (
          <button
            type="button"
            className="login-switch"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError(null);
            }}
          >
            {mode === 'login' ? 'Need an account? Sign up' : 'Already have an account? Sign in'}
          </button>
        )}

        {!serverInfo && (
          <p className="login-offline">
            Could not reach the server. Check that the container is running.
          </p>
        )}
      </main>
    </div>
  );
}
