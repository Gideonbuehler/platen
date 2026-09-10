import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { IconSpinner } from './components/Icons';
import { useAuth } from './hooks/useAuth';
import { UploadsProvider } from './hooks/useUploads';
import { AlbumDetailPage } from './pages/AlbumDetail';
import { AlbumsPage } from './pages/Albums';
import { LoginPage } from './pages/Login';
import { PeoplePage } from './pages/People';
import { PersonDetailPage } from './pages/PersonDetail';
import { SearchPage } from './pages/Search';
import { SettingsPage } from './pages/Settings';
import { SharePage } from './pages/Share';
import { TimelinePage } from './pages/Timeline';

export function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="app-booting">
        <IconSpinner size={26} />
      </div>
    );
  }

  return (
    <Routes>
      {/* Public share viewer: reachable without an account, and deliberately
          outside the app shell so recipients see only the shared photos. */}
      <Route path="/s/:key" element={<SharePage />} />

      {user ? (
        <Route
          path="*"
          element={
            <UploadsProvider>
              <AppShell>
                <Routes>
                  <Route path="/" element={<TimelinePage key="all" variant="all" />} />
                  <Route
                    path="/favorites"
                    element={<TimelinePage key="favorites" variant="favorites" />}
                  />
                  <Route path="/archive" element={<TimelinePage key="archive" variant="archive" />} />
                  <Route path="/trash" element={<TimelinePage key="trash" variant="trash" />} />
                  <Route path="/albums" element={<AlbumsPage />} />
                  <Route path="/albums/:id" element={<AlbumDetailPage />} />
                  <Route path="/people" element={<PeoplePage />} />
                  <Route path="/people/:id" element={<PersonDetailPage />} />
                  <Route path="/search" element={<SearchPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </AppShell>
            </UploadsProvider>
          }
        />
      ) : (
        <Route path="*" element={<LoginPage />} />
      )}
    </Routes>
  );
}
