import { useCallback, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Asset } from '@platen/shared';
import {
  IconAlbums,
  IconChevronLeft,
  IconShare,
  IconSpinner,
  IconTrash,
} from '../components/Icons';
import { Lightbox } from '../components/Lightbox';
import { PhotoGrid } from '../components/PhotoGrid';
import { SelectionBar } from '../components/SelectionBar';
import { api } from '../lib/api';
import './Albums.css';

export function AlbumDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [sharePanelOpen, setSharePanelOpen] = useState(false);
  const [shareEmail, setShareEmail] = useState('');
  const [publicLink, setPublicLink] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);

  const { data: album, isLoading } = useQuery({
    queryKey: ['album', id],
    queryFn: () => api.album(id!),
    enabled: Boolean(id),
  });

  const { data: page } = useQuery({
    queryKey: ['album-assets', id],
    queryFn: () => api.albumAssets(id!),
    enabled: Boolean(id),
  });

  const assets = page?.items ?? [];

  const removeFromAlbum = useMutation({
    mutationFn: (assetIds: string[]) => api.removeFromAlbum(id!, assetIds),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['album-assets', id] });
      void queryClient.invalidateQueries({ queryKey: ['album', id] });
      setSelection(new Set());
    },
  });

  const deleteAlbum = useMutation({
    mutationFn: () => api.deleteAlbum(id!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['albums'] });
      navigate('/albums');
    },
  });

  const shareWithUser = useMutation({
    mutationFn: (email: string) => api.shareAlbumWith(id!, email),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['album', id] });
      setShareEmail('');
      setShareError(null);
    },
    onError: (error: unknown) => {
      setShareError(error instanceof Error ? error.message : 'Could not share the album.');
    },
  });

  const createLink = useMutation({
    mutationFn: () => api.createShareLink({ albumId: id!, allowDownload: true }),
    onSuccess: (link) => {
      setPublicLink(`${window.location.origin}/s/${link.key}`);
    },
  });

  const openAt = useCallback(
    (asset: Asset) => setLightboxIndex(assets.findIndex((a) => a.id === asset.id)),
    [assets],
  );

  if (isLoading || !album) {
    return (
      <div className="albums-loading">
        <IconSpinner size={26} />
      </div>
    );
  }

  return (
    <>
      <Link to="/albums" className="album-back">
        <IconChevronLeft size={16} />
        Albums
      </Link>

      <header className="album-detail-header">
        <div>
          <h1>{album.name}</h1>
          <p className="albums-subtitle">
            {album.assetCount} {album.assetCount === 1 ? 'item' : 'items'}
          </p>
        </div>

        <div className="album-detail-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setSharePanelOpen((open) => !open)}
          >
            <IconShare size={17} />
            Share
          </button>
          <button
            type="button"
            className="btn btn-danger btn-icon"
            aria-label="Delete album"
            onClick={() => {
              if (window.confirm(`Delete the album "${album.name}"? The photos themselves are kept.`)) {
                deleteAlbum.mutate();
              }
            }}
          >
            <IconTrash size={17} />
          </button>
        </div>
      </header>

      {sharePanelOpen && (
        <section className="album-share-panel card">
          <h3>Share with someone on this server</h3>
          <form
            className="album-share-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (shareEmail.trim()) shareWithUser.mutate(shareEmail.trim());
            }}
          >
            <input
              type="email"
              className="input"
              placeholder="their@email.com"
              value={shareEmail}
              onChange={(event) => setShareEmail(event.target.value)}
            />
            <button type="submit" className="btn btn-secondary" disabled={shareWithUser.isPending}>
              Invite
            </button>
          </form>

          {shareError && <p className="login-error">{shareError}</p>}

          {album.sharedWith.length > 0 && (
            <div className="album-share-people">
              {album.sharedWith.map((person) => (
                <span key={person.id} className="album-share-chip">
                  {person.name}
                </span>
              ))}
            </div>
          )}

          <h3 style={{ marginTop: 'var(--space-5)' }}>Public link</h3>
          {publicLink ? (
            <div className="album-share-link">
              <span>{publicLink}</span>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void navigator.clipboard?.writeText(publicLink)}
              >
                Copy
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => createLink.mutate()}
              disabled={createLink.isPending}
            >
              Create a link anyone can open
            </button>
          )}
        </section>
      )}

      <PhotoGrid
        assets={assets}
        onOpen={openAt}
        selection={selection}
        onSelectionChange={setSelection}
        empty={
          <div className="album-detail-empty">
            <IconAlbums size={40} />
            <h2>This album is empty</h2>
            <p>Select photos in your timeline and choose “Add to album”.</p>
          </div>
        }
      />

      <SelectionBar
        count={selection.size}
        onClear={() => setSelection(new Set())}
        onDelete={() => removeFromAlbum.mutate([...selection])}
      />

      {lightboxIndex !== null && assets[lightboxIndex] && (
        <Lightbox
          assets={assets}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
}
