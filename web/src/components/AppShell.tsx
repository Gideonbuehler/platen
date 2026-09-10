import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useTheme } from '../hooks/useTheme';
import { useUploads } from '../hooks/useUploads';
import { captureEntries, expandDroppedEntries } from '../lib/dropped-files';
import {
  IconAlbums,
  IconArchive,
  IconHeart,
  IconLogo,
  IconLogout,
  IconMoon,
  IconPhotos,
  IconSearch,
  IconSettings,
  IconSpinner,
  IconSun,
  IconTrash,
  IconUpload,
  IconUsers,
} from './Icons';
import './AppShell.css';

const NAV_ITEMS = [
  { to: '/', label: 'Photos', icon: IconPhotos, end: true },
  { to: '/search', label: 'Search', icon: IconSearch, end: false },
  { to: '/albums', label: 'Albums', icon: IconAlbums, end: false },
  { to: '/people', label: 'People', icon: IconUsers, end: false },
  { to: '/favorites', label: 'Favourites', icon: IconHeart, end: false },
  { to: '/archive', label: 'Archive', icon: IconArchive, end: false },
  { to: '/trash', label: 'Trash', icon: IconTrash, end: false },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const { resolved, setChoice } = useTheme();
  const { queue, addFiles, clearFinished } = useUploads();
  const navigate = useNavigate();
  const location = useLocation();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Close transient UI whenever the route changes.
  useEffect(() => {
    setMenuOpen(false);
    setMobileNavOpen(false);
  }, [location.pathname]);

  // ---- drag and drop -----------------------------------------------------
  // dragenter/dragleave fire for every child element, so a plain boolean
  // flickers. Counting entries against exits is the reliable way to know when
  // the pointer has genuinely left the window.
  useEffect(() => {
    let depth = 0;

    const onDragEnter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      depth++;
      setDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    const onDragLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      depth = 0;
      setDragging(false);
      if (!event.dataTransfer) return;
      event.preventDefault();

      // Capture the entries synchronously — the DataTransfer is emptied the
      // moment this handler returns, so this cannot wait for the walk.
      const entries = captureEntries(event.dataTransfer);
      const fallback = Array.from(event.dataTransfer.files);

      void expandDroppedEntries(entries).then((files) => {
        // Older browsers without the Entries API still get plain file drops.
        addFiles(files.length > 0 ? files : fallback);
      });
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [addFiles]);

  const active = queue.filter((item) => item.status === 'uploading' || item.status === 'pending');
  const failed = queue.filter((item) => item.status === 'error');

  // Dismiss the upload toast on its own once everything has settled. Failures
  // linger noticeably longer, because they are the only case where the toast
  // carries information the user still needs to read.
  useEffect(() => {
    if (queue.length === 0 || active.length > 0) return;

    const delay = failed.length > 0 ? 15_000 : 4_000;
    const timer = setTimeout(clearFinished, delay);
    return () => clearTimeout(timer);
  }, [queue.length, active.length, failed.length, clearFinished]);

  return (
    <div className="shell">
      <aside className={`shell-sidebar${mobileNavOpen ? ' is-open' : ''}`}>
        <div className="shell-brand" onClick={() => navigate('/')}>
          <IconLogo size={24} />
          <span>Aperture</span>
        </div>

        <nav className="shell-nav">
          {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => `shell-nav-item${isActive ? ' is-active' : ''}`}
            >
              <Icon size={19} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="shell-sidebar-footer">
          <button
            type="button"
            className="btn btn-primary shell-upload"
            onClick={() => fileInputRef.current?.click()}
          >
            <IconUpload size={17} />
            Upload
          </button>

          <div className="shell-user">
            <button
              type="button"
              className="shell-user-button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
            >
              <span className="shell-avatar">{user?.name.charAt(0).toUpperCase() ?? '?'}</span>
              <span className="shell-user-name">{user?.name}</span>
            </button>

            {menuOpen && (
              <div className="shell-menu" role="menu">
                <button
                  type="button"
                  className="shell-menu-item"
                  onClick={() => setChoice(resolved === 'dark' ? 'light' : 'dark')}
                >
                  {resolved === 'dark' ? <IconSun size={17} /> : <IconMoon size={17} />}
                  {resolved === 'dark' ? 'Light theme' : 'Dark theme'}
                </button>
                <button
                  type="button"
                  className="shell-menu-item"
                  onClick={() => navigate('/settings')}
                >
                  <IconSettings size={17} />
                  Settings
                </button>
                <button type="button" className="shell-menu-item is-danger" onClick={() => void logout()}>
                  <IconLogout size={17} />
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>

      {mobileNavOpen && <div className="shell-scrim" onClick={() => setMobileNavOpen(false)} />}

      <main className="shell-main">
        <button
          type="button"
          className="shell-menu-toggle btn btn-icon"
          onClick={() => setMobileNavOpen(true)}
          aria-label="Open navigation"
        >
          <IconLogo size={22} />
        </button>
        {children}
      </main>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,video/*"
        hidden
        onChange={(event) => {
          if (event.target.files?.length) addFiles(Array.from(event.target.files));
          // Reset so selecting the same file twice still fires a change event.
          event.target.value = '';
        }}
      />

      {dragging && (
        <div className="shell-dropzone">
          <div className="shell-dropzone-card">
            <IconUpload size={34} />
            <h2>Drop to upload</h2>
            <p>Photos and videos are added to your library</p>
          </div>
        </div>
      )}

      {queue.length > 0 && (
        <div className="shell-uploads card">
          <div className="shell-uploads-header">
            {active.length > 0 ? (
              <>
                <IconSpinner size={15} />
                <span>
                  Uploading {queue.length - active.length + 1} of {queue.length}
                </span>
              </>
            ) : (
              <span>
                {queue.length - failed.length} uploaded
                {failed.length > 0 ? `, ${failed.length} failed` : ''}
              </span>
            )}
            {active.length === 0 && (
              <button type="button" className="shell-uploads-close" onClick={clearFinished}>
                Dismiss
              </button>
            )}
          </div>

          {active[0] && (
            <div className="shell-uploads-current">
              <span className="shell-uploads-name">{active[0].file.name}</span>
              <div className="shell-uploads-bar">
                <div style={{ width: `${Math.round(active[0].progress * 100)}%` }} />
              </div>
            </div>
          )}

          {failed.length > 0 && active.length === 0 && (
            <ul className="shell-uploads-errors">
              {failed.slice(0, 3).map((item) => (
                <li key={item.id}>
                  <strong>{item.file.name}</strong> — {item.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
