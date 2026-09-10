import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import type { Asset } from '@aperture/shared';
import { IconLogo, IconSpinner } from '../components/Icons';
import { Lightbox } from '../components/Lightbox';
import { PhotoGrid } from '../components/PhotoGrid';
import { api, shareOriginalUrl, sharePreviewUrl, shareThumbnailUrl } from '../lib/api';
import './Share.css';

interface ShareContents {
  title: string;
  allowDownload: boolean;
  isAlbum: boolean;
  assets: Asset[];
}

/**
 * Public share viewer.
 *
 * Deliberately outside the authenticated shell: someone opening a link should
 * see the photos and nothing else — no sidebar, no upload button, no hint about
 * the rest of the library.
 */
export function SharePage() {
  const { key } = useParams<{ key: string }>();

  const [contents, setContents] = useState<ShareContents | null>(null);
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const load = useCallback(
    async (candidate?: string) => {
      if (!key) return;
      setError(null);

      try {
        const result = await api.shareContents(key, candidate);
        setContents(result);
        setRequiresPassword(false);
        document.title = `${result.title} · Aperture`;
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 401 || status === 403) {
          setRequiresPassword(true);
          if (candidate) setError('That password is not correct.');
        } else {
          setError(err instanceof Error ? err.message : 'This link is no longer available.');
        }
      } finally {
        setLoading(false);
      }
    },
    [key],
  );

  useEffect(() => {
    // Probe first so a password-protected link renders its prompt immediately
    // rather than flashing an error.
    (async () => {
      if (!key) return;
      try {
        const info = await api.shareInfo(key);
        if (info.requiresPassword) {
          setRequiresPassword(true);
          setLoading(false);
          document.title = `${info.title} · Aperture`;
          return;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'This link is no longer available.');
        setLoading(false);
        return;
      }
      await load();
    })();
  }, [key, load]);

  const onSubmitPassword = (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    void load(password).finally(() => setLoading(false));
  };

  if (loading) {
    return (
      <div className="share-center">
        <IconSpinner size={26} />
      </div>
    );
  }

  if (requiresPassword) {
    return (
      <div className="share-center">
        <form className="share-gate card" onSubmit={onSubmitPassword}>
          <IconLogo size={30} />
          <h1>This album is protected</h1>
          <p>Enter the password you were given to view these photos.</p>

          <input
            type="password"
            className="input"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Password"
            autoFocus
          />

          {error && <div className="login-error">{error}</div>}

          <button type="submit" className="btn btn-primary">
            View photos
          </button>
        </form>
      </div>
    );
  }

  if (error || !contents) {
    return (
      <div className="share-center">
        <div className="share-gate card">
          <IconLogo size={30} />
          <h1>Link unavailable</h1>
          <p>{error ?? 'This link may have expired or been removed.'}</p>
        </div>
      </div>
    );
  }

  const { assets } = contents;

  return (
    <div className="share">
      <header className="share-header">
        <div className="share-brand">
          <IconLogo size={20} />
          <span>Aperture</span>
        </div>
        <h1>{contents.title}</h1>
        <p>
          {assets.length} {assets.length === 1 ? 'item' : 'items'}
          {!contents.allowDownload && ' · downloads disabled'}
        </p>
      </header>

      <PhotoGrid
        assets={assets}
        onOpen={(asset) => setLightboxIndex(assets.findIndex((a) => a.id === asset.id))}
        selection={new Set()}
        onSelectionChange={() => {}}
        thumbnailUrl={(asset) => shareThumbnailUrl(key!, asset.id)}
        empty={<p className="share-empty">There is nothing in this share yet.</p>}
      />

      {lightboxIndex !== null && assets[lightboxIndex] && (
        <Lightbox
          assets={assets}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          previewUrl={(asset) => sharePreviewUrl(key!, asset.id)}
          originalUrl={(asset) => shareOriginalUrl(key!, asset.id)}
          downloadUrl={(asset) => shareOriginalUrl(key!, asset.id)}
          readOnly
          allowDownload={contents.allowDownload}
        />
      )}
    </div>
  );
}
