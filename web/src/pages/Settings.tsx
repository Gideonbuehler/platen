import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAlbums, IconPlus, IconSpinner, IconTrash, IconUsers } from '../components/Icons';
import { useAuth } from '../hooks/useAuth';
import { useTheme } from '../hooks/useTheme';
import { api } from '../lib/api';
import './Settings.css';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return `${value < 10 && index > 0 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}

export function SettingsPage() {
  const { user, refreshUser } = useAuth();
  const { choice, setChoice } = useTheme();
  const queryClient = useQueryClient();

  const [name, setName] = useState(user?.name ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const [newUser, setNewUser] = useState({ email: '', name: '', password: '' });
  const [newLibrary, setNewLibrary] = useState({ name: '', path: '' });
  const [browsePath, setBrowsePath] = useState('');

  const { data: stats } = useQuery({ queryKey: ['stats'], queryFn: api.stats });
  const { data: searchStatus } = useQuery({
    queryKey: ['search-status'],
    queryFn: api.searchStatus,
    // Poll while there is something to watch, so the bar moves on its own
    // during a first-run model download or a bulk re-index. Stops once idle.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 5_000;
      return data.state === 'loading' || data.pending > 0 ? 5_000 : false;
    },
    staleTime: 0,
  });
  const { data: faceStatus } = useQuery({
    queryKey: ['face-status'],
    queryFn: api.faceStatus,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 5_000;
      return data.state === 'loading' || data.pending > 0 ? 5_000 : false;
    },
    staleTime: 0,
  });
  const { data: users } = useQuery({
    queryKey: ['users'],
    queryFn: api.users,
    enabled: user?.isAdmin ?? false,
  });

  const saveProfile = useMutation({
    mutationFn: () =>
      api.updateMe({
        name: name !== user?.name ? name : undefined,
        password: newPassword || undefined,
        currentPassword: newPassword ? currentPassword : undefined,
      }),
    onSuccess: async () => {
      await refreshUser();
      setCurrentPassword('');
      setNewPassword('');
      setMessage({ kind: 'ok', text: 'Saved.' });
    },
    onError: (error: unknown) => {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Could not save changes.',
      });
    },
  });

  const createUser = useMutation({
    mutationFn: () => api.createUser(newUser),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      setNewUser({ email: '', name: '', password: '' });
      setMessage({ kind: 'ok', text: 'Account created.' });
    },
    onError: (error: unknown) => {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Could not create the account.',
      });
    },
  });

  const deleteUser = useMutation({
    mutationFn: (id: string) => api.deleteUser(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['users'] }),
  });

  const { data: libraries } = useQuery({
    queryKey: ['libraries'],
    queryFn: api.libraries,
    enabled: user?.isAdmin ?? false,
    // Follow a scan in progress without needing a manual refresh.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((lib) => lib.lastScanAt === null) ? 5_000 : 30_000,
  });

  const { data: browse } = useQuery({
    queryKey: ['library-browse', browsePath],
    queryFn: () => api.browseLibraries(browsePath),
    enabled: user?.isAdmin ?? false,
  });

  const createLibrary = useMutation({
    mutationFn: () => api.createLibrary(newLibrary),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['libraries'] });
      setNewLibrary({ name: '', path: '' });
      setMessage({ kind: 'ok', text: 'Library added. Scanning has started.' });
    },
    onError: (error: unknown) => {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Could not add the library.',
      });
    },
  });

  const scanLibrary = useMutation({
    mutationFn: (id: string) => api.scanLibrary(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['libraries'] });
      setMessage({ kind: 'ok', text: 'Scan queued.' });
    },
  });

  const removeLibrary = useMutation({
    mutationFn: (id: string) => api.deleteLibrary(id),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['libraries'] });
      void queryClient.invalidateQueries({ queryKey: ['assets'] });
      setMessage({ kind: 'ok', text: result.message });
    },
  });

  const writeSidecars = useMutation({
    mutationFn: () => api.writeSidecars(),
    onSuccess: () => {
      setMessage({ kind: 'ok', text: 'Reconciling sidecars. Refresh in a moment for the result.' });
    },
  });

  const rescanFaces = useMutation({
    mutationFn: (full: boolean) => api.rescanFaces(full),
    onSuccess: (result) => {
      setMessage({ kind: 'ok', text: `Queued ${result.queued} photo(s) for face scanning.` });
      void queryClient.invalidateQueries({ queryKey: ['face-status'] });
    },
  });

  const reindex = useMutation({
    mutationFn: (what: 'thumbnails' | 'metadata' | 'embeddings') => api.reindex(what),
    onSuccess: (result) => {
      setMessage({ kind: 'ok', text: `Queued ${result.queued} job(s).` });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
  });

  /**
   * Green only when the last sweep wrote everything it needed to and the
   * number it covered matches the library. A sweep that failed on even one
   * file means there is a photo nothing on disk describes.
   */
  const sidecarsHealthy =
    stats != null &&
    stats.sidecars.lastSweep != null &&
    stats.sidecars.lastSweep.failed === 0 &&
    stats.sidecars.lastSweep.written + stats.sidecars.lastSweep.unchanged >=
      stats.sidecars.describedAssets;

  const quotaPercent =
    user?.quotaBytes && user.quotaBytes > 0
      ? Math.min(100, Math.round((user.usageBytes / user.quotaBytes) * 100))
      : null;

  return (
    <div className="settings">
      <header className="settings-header">
        <h1>Settings</h1>
      </header>

      {message && (
        <div className={`settings-message is-${message.kind}`} role="status">
          {message.text}
        </div>
      )}

      {/* ---- Profile ------------------------------------------------------ */}
      <section className="settings-section card">
        <h2>Your account</h2>

        <div className="settings-field">
          <label className="label" htmlFor="settings-name">Name</label>
          <input
            id="settings-name"
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="settings-field">
          <label className="label">Email</label>
          <input className="input" value={user?.email ?? ''} disabled />
        </div>

        <div className="settings-grid">
          <div className="settings-field">
            <label className="label" htmlFor="settings-current">Current password</label>
            <input
              id="settings-current"
              type="password"
              className="input"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div className="settings-field">
            <label className="label" htmlFor="settings-new">New password</label>
            <input
              id="settings-new"
              type="password"
              className="input"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
              minLength={8}
            />
          </div>
        </div>
        <p className="settings-hint">Changing your password signs out every other device.</p>

        <button
          type="button"
          className="btn btn-primary"
          onClick={() => saveProfile.mutate()}
          disabled={saveProfile.isPending}
        >
          {saveProfile.isPending && <IconSpinner size={16} />}
          Save changes
        </button>
      </section>

      {/* ---- Appearance --------------------------------------------------- */}
      <section className="settings-section card">
        <h2>Appearance</h2>
        <div className="settings-theme">
          {(['dark', 'light', 'system'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`settings-theme-option${choice === option ? ' is-active' : ''}`}
              onClick={() => setChoice(option)}
            >
              {option === 'dark' ? 'Dark' : option === 'light' ? 'Light' : 'Match system'}
            </button>
          ))}
        </div>
      </section>

      {/* ---- Storage ------------------------------------------------------ */}
      <section className="settings-section card">
        <h2>Storage</h2>

        <div className="settings-usage">
          <span className="settings-usage-value">{formatBytes(user?.usageBytes ?? 0)}</span>
          <span className="settings-usage-label">
            {user?.quotaBytes ? `of ${formatBytes(user.quotaBytes)}` : 'used — no quota set'}
          </span>
        </div>

        {quotaPercent !== null && (
          <div className="settings-bar">
            <div style={{ width: `${quotaPercent}%` }} />
          </div>
        )}

        {stats && (
          <dl className="settings-stats">
            <div>
              <dt>Photos</dt>
              <dd>{stats.photos.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Videos</dt>
              <dd>{stats.videos.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Total size</dt>
              <dd>{formatBytes(stats.usageBytes)}</dd>
            </div>

          </dl>
        )}
      </section>

      {/* ---- Search index -------------------------------------------------- */}
      <section className="settings-section card">
        <h2>Search index</h2>

        {searchStatus ? (
          (() => {
            const percent =
              searchStatus.total > 0
                ? Math.round((searchStatus.indexed / searchStatus.total) * 100)
                : 100;
            const complete = searchStatus.pending === 0 && searchStatus.total > 0;

            return (
              <>
                <div className="settings-index-head">
                  <span className={`settings-dot is-${searchStatus.state}`} aria-hidden="true" />
                  <span className="settings-index-state">
                    {searchStatus.state === 'ready' && (complete ? 'Everything is indexed' : 'Indexing')}
                    {searchStatus.state === 'loading' && 'Loading the search model'}
                    {searchStatus.state === 'error' && 'Search unavailable'}
                    {searchStatus.state === 'disabled' && 'Semantic search is turned off'}
                  </span>
                </div>

                {searchStatus.enabled && (
                  <>
                    <div className="settings-bar">
                      <div style={{ width: `${percent}%` }} />
                    </div>
                    <p className="settings-hint" style={{ marginBottom: 0 }}>
                      {searchStatus.indexed.toLocaleString()} of{' '}
                      {searchStatus.total.toLocaleString()} photos indexed
                      {searchStatus.pending > 0 &&
                        ` · ${searchStatus.pending.toLocaleString()} still to process`}
                    </p>
                  </>
                )}

                {searchStatus.message && (
                  <p className={`settings-index-message${searchStatus.state === 'error' ? ' is-error' : ''}`}>
                    {searchStatus.message}
                  </p>
                )}

                <p className="settings-hint" style={{ marginTop: 'var(--space-3)', marginBottom: 0 }}>
                  Model: <code>{searchStatus.model}</code>
                </p>
              </>
            );
          })()
        ) : (
          <p className="settings-hint">Checking…</p>
        )}
      </section>

      {/* ---- People -------------------------------------------------------- */}
      <section className="settings-section card">
        <h2>
          <IconUsers size={17} />
          People
        </h2>

        {faceStatus ? (
          faceStatus.enabled ? (
            (() => {
              const percent =
                faceStatus.total > 0
                  ? Math.round((faceStatus.scanned / faceStatus.total) * 100)
                  : 100;
              return (
                <>
                  <div className="settings-index-head">
                    <span className={`settings-dot is-${faceStatus.state}`} aria-hidden="true" />
                    <span className="settings-index-state">
                      {faceStatus.state === 'ready' &&
                        (faceStatus.pending === 0 ? 'All photos scanned' : 'Scanning')}
                      {faceStatus.state === 'loading' && 'Loading face models'}
                      {faceStatus.state === 'error' && 'Face grouping unavailable'}
                      {faceStatus.state === 'disabled' && 'Turned off'}
                    </span>
                  </div>

                  <div className="settings-bar">
                    <div style={{ width: `${percent}%` }} />
                  </div>

                  <p className="settings-hint" style={{ marginBottom: 0 }}>
                    {faceStatus.scanned.toLocaleString()} of {faceStatus.total.toLocaleString()}{' '}
                    photos scanned · {faceStatus.faces.toLocaleString()} faces in{' '}
                    {faceStatus.people.toLocaleString()} people
                  </p>

                  {faceStatus.message && (
                    <p
                      className={`settings-index-message${faceStatus.state === 'error' ? ' is-error' : ''}`}
                    >
                      {faceStatus.message}
                    </p>
                  )}

                  <div className="settings-actions" style={{ marginTop: 'var(--space-4)' }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => rescanFaces.mutate(false)}
                    >
                      Scan new photos
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => rescanFaces.mutate(true)}
                    >
                      Rescan everything
                    </button>
                  </div>
                </>
              );
            })()
          ) : (
            <p className="settings-hint" style={{ marginBottom: 0 }}>
              Face grouping is turned off. Set <code>ENABLE_FACES=true</code> on the server to
              group photos by who is in them — it downloads about 190 MB of models and adds some
              CPU work per photo.
            </p>
          )
        ) : (
          <p className="settings-hint">Checking…</p>
        )}
      </section>

      {/* ---- Recoverability -------------------------------------------------- */}
      {user?.isAdmin && stats && (
        <section className="settings-section card">
          <h2>Library recovery</h2>

          <p className="settings-hint">
            Originals are stored under their internal ID, so the filename on disk carries no
            information. A small JSON file beside each one records its real name, capture time,
            albums and people — which means the library can be rebuilt even if the database is
            lost. Keep backing up Postgres; this is what works when that backup does not.
          </p>

          <div className="settings-index-head">
            <span
              className={`settings-dot is-${
                sidecarsHealthy ? 'ready' : stats.sidecars.lastSweepAt ? 'error' : 'pending'
              }`}
              aria-hidden="true"
            />
            <span className="settings-index-state">
              {!stats.sidecars.lastSweepAt
                ? 'Not written yet'
                : sidecarsHealthy
                  ? `All ${stats.sidecars.describedAssets.toLocaleString()} photos and videos describe themselves`
                  : `${stats.sidecars.lastSweep?.failed.toLocaleString()} could not be written`}
            </span>
          </div>

          {stats.sidecars.lastSweepAt && (
            <p className="settings-hint" style={{ marginBottom: 0 }}>
              Last checked {new Date(stats.sidecars.lastSweepAt).toLocaleString()} ·{' '}
              {stats.sidecars.lastSweep?.written.toLocaleString()} written,{' '}
              {stats.sidecars.lastSweep?.unchanged.toLocaleString()} already current
            </p>
          )}

          <div className="settings-actions" style={{ marginTop: 'var(--space-4)' }}>
            <button
              type="button"
              className="btn"
              onClick={() => writeSidecars.mutate()}
              disabled={writeSidecars.isPending}
            >
              {writeSidecars.isPending ? 'Queuing…' : 'Check now'}
            </button>
          </div>

          <p className="settings-hint" style={{ marginTop: 'var(--space-4)', marginBottom: 0 }}>
            This runs itself once a day. To rebuild from the files alone, run{' '}
            <code>npm run restore -w server</code> inside the container — it reports what it finds
            before changing anything.
          </p>
        </section>
      )}

      {/* ---- Thumbnail cache ------------------------------------------------ */}
      {user?.isAdmin && stats && (
        <section className="settings-section card">
          <h2>Thumbnail cache</h2>

          {!stats.cache.configured ? (
            <p className="settings-hint" style={{ marginBottom: 0 }}>
              Not configured. Thumbnails are read from disk, which is fine on SSD storage. If your
              photos live on a spinning array, adding Redis keeps the grid smooth while scrolling —
              set <code>REDIS_URL</code> and start the <code>platen-redis</code> container.
            </p>
          ) : (
            <>
              <div className="settings-index-head">
                <span
                  className={`settings-dot is-${stats.cache.healthy ? 'ready' : 'error'}`}
                  aria-hidden="true"
                />
                <span className="settings-index-state">
                  {stats.cache.healthy ? 'Connected' : 'Unreachable — serving from disk'}
                </span>
              </div>

              {stats.cache.healthy && (
                <>
                  <div className="settings-cache-bar">
                    <div style={{ width: `${Math.round(stats.cache.hitRate * 100)}%` }} />
                  </div>
                  <p className="settings-hint" style={{ marginBottom: 0 }}>
                    {Math.round(stats.cache.hitRate * 100)}% of thumbnail requests served from
                    memory · {stats.cache.hits.toLocaleString()} hits,{' '}
                    {stats.cache.misses.toLocaleString()} misses
                    {stats.cache.errors > 0 && (
                      <span className="settings-failed">
                        {' · '}
                        {stats.cache.errors.toLocaleString()} errors
                      </span>
                    )}
                  </p>
                </>
              )}

              {stats.cache.lastError && (
                <p className="settings-index-message is-error">{stats.cache.lastError}</p>
              )}

              <p className="settings-hint" style={{ marginTop: 'var(--space-4)', marginBottom: 0 }}>
                Only thumbnails and previews are cached. Your originals and the database are never
                stored in Redis, so losing it costs a little speed and nothing else.
              </p>
            </>
          )}
        </section>
      )}

      {/* ---- External libraries -------------------------------------------- */}
      {user?.isAdmin && (
        <section className="settings-section card">
          <h2>
            <IconAlbums size={17} />
            Existing folders
          </h2>
          <p className="settings-hint">
            Index photos already on this server, in place. Nothing is copied, moved or renamed,
            and removing a library here never deletes a file.
          </p>

          {libraries && libraries.length > 0 && (
            <ul className="settings-libraries">
              {libraries.map((library) => (
                <li key={library.id}>
                  <div className="settings-library-main">
                    <span className="settings-library-name">{library.name}</span>
                    <span className="settings-library-path">/{library.path}</span>
                    <span className="settings-library-stats">
                      {library.assetCount.toLocaleString()} photos
                      {library.missingCount > 0 && (
                        <span className="settings-failed">
                          {' · '}
                          {library.missingCount.toLocaleString()} missing
                        </span>
                      )}
                      {library.lastScanAt
                        ? ` · scanned ${new Date(library.lastScanAt).toLocaleString()}`
                        : ' · not scanned yet'}
                    </span>
                    {library.lastScanError && (
                      <span className="settings-library-error">{library.lastScanError}</span>
                    )}
                  </div>

                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => scanLibrary.mutate(library.id)}
                  >
                    Rescan
                  </button>
                  <button
                    type="button"
                    className="btn btn-icon btn-danger"
                    aria-label={`Remove ${library.name}`}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Stop indexing "${library.name}"? Your files stay exactly where they are — this only removes them from Platen.`,
                        )
                      ) {
                        removeLibrary.mutate(library.id);
                      }
                    }}
                  >
                    <IconTrash size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="settings-library-add">
            <input
              className="input"
              placeholder="Name, e.g. Old photos"
              value={newLibrary.name}
              onChange={(event) => setNewLibrary({ ...newLibrary, name: event.target.value })}
            />
            <input
              className="input"
              placeholder="Folder inside the mounted directory"
              value={newLibrary.path}
              onChange={(event) => setNewLibrary({ ...newLibrary, path: event.target.value })}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                !newLibrary.name.trim() || !newLibrary.path.trim() || createLibrary.isPending
              }
              onClick={() => createLibrary.mutate()}
            >
              <IconPlus size={16} />
              Add
            </button>
          </div>

          {/* Picking beats typing: the path is the one inside the container,
              which is not the path anyone knows from their NAS. */}
          {browse && (
            <div className="settings-browse">
              <div className="settings-browse-path">
                <button type="button" onClick={() => setBrowsePath('')} disabled={!browsePath}>
                  {browse.root}
                </button>
                {browsePath && <span>/{browsePath}</span>}
              </div>

              {!browse.exists ? (
                <p className="settings-hint" style={{ marginBottom: 0 }}>
                  Nothing is mounted at <code>{browse.root}</code> yet. Point{' '}
                  <code>EXTERNAL_PATH</code> at the share you want to index, then restart.
                </p>
              ) : browse.directories.length === 0 ? (
                <p className="settings-hint" style={{ marginBottom: 0 }}>
                  No sub-folders here.
                </p>
              ) : (
                <div className="settings-browse-list">
                  {browse.directories.map((dir) => (
                    <button
                      key={dir}
                      type="button"
                      className="settings-browse-item"
                      onClick={() => setBrowsePath(dir)}
                    >
                      {dir.split('/').pop()}
                    </button>
                  ))}
                </div>
              )}

              {browsePath && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    setNewLibrary({
                      name: newLibrary.name || (browsePath.split('/').pop() ?? browsePath),
                      path: browsePath,
                    })
                  }
                >
                  Use this folder
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {/* ---- Admin -------------------------------------------------------- */}
      {user?.isAdmin && (
        <>
          <section className="settings-section card">
            <h2>
              <IconUsers size={17} />
              People
            </h2>

            <ul className="settings-users">
              {users?.map((account) => (
                <li key={account.id}>
                  <div>
                    <span className="settings-user-name">
                      {account.name}
                      {account.isAdmin && <span className="settings-badge">Admin</span>}
                    </span>
                    <span className="settings-user-email">{account.email}</span>
                  </div>
                  <span className="settings-user-usage">{formatBytes(account.usageBytes)}</span>
                  {account.id !== user.id && (
                    <button
                      type="button"
                      className="btn btn-icon btn-danger"
                      aria-label={`Delete ${account.name}`}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete ${account.name}? Every photo they own is permanently removed.`,
                          )
                        ) {
                          deleteUser.mutate(account.id);
                        }
                      }}
                    >
                      <IconTrash size={16} />
                    </button>
                  )}
                </li>
              ))}
            </ul>

            <form
              className="settings-new-user"
              onSubmit={(event) => {
                event.preventDefault();
                createUser.mutate();
              }}
            >
              <input
                className="input"
                placeholder="Name"
                value={newUser.name}
                onChange={(event) => setNewUser({ ...newUser, name: event.target.value })}
                required
              />
              <input
                className="input"
                type="email"
                placeholder="Email"
                value={newUser.email}
                onChange={(event) => setNewUser({ ...newUser, email: event.target.value })}
                required
              />
              <input
                className="input"
                type="password"
                placeholder="Password"
                value={newUser.password}
                onChange={(event) => setNewUser({ ...newUser, password: event.target.value })}
                minLength={8}
                required
              />
              <button type="submit" className="btn btn-secondary" disabled={createUser.isPending}>
                Add person
              </button>
            </form>
          </section>

          <section className="settings-section card">
            <h2>Maintenance</h2>
            <p className="settings-hint">
              Re-queue background work. Safe to run at any time; jobs are de-duplicated.
            </p>
            <div className="settings-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => reindex.mutate('thumbnails')}
              >
                Rebuild thumbnails
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => reindex.mutate('metadata')}
              >
                Re-read metadata
              </button>
              {searchStatus?.enabled && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => reindex.mutate('embeddings')}
                >
                  Rebuild search index
                </button>
              )}
            </div>

            {stats && stats.jobs.length > 0 && (
              <dl className="settings-stats">
                {stats.jobs.map((job) => (
                  <div key={job.type}>
                    <dt>{job.type}</dt>
                    <dd>
                      {job.pending + job.active} queued
                      {job.failed > 0 && <span className="settings-failed"> · {job.failed} failed</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
        </>
      )}
    </div>
  );
}
