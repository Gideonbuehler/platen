import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAlbums, IconPlus, IconSpinner, IconUsers } from '../components/Icons';
import { api, assetThumbnailUrl } from '../lib/api';
import './Albums.css';

export function AlbumsPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const { data: albums, isLoading } = useQuery({ queryKey: ['albums'], queryFn: api.albums });

  const createAlbum = useMutation({
    mutationFn: (albumName: string) => api.createAlbum({ name: albumName }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['albums'] });
      setCreating(false);
      setName('');
    },
  });

  if (isLoading) {
    return (
      <div className="albums-loading">
        <IconSpinner size={26} />
      </div>
    );
  }

  return (
    <>
      <header className="albums-header">
        <div>
          <h1>Albums</h1>
          {albums && albums.length > 0 && (
            <p className="albums-subtitle">
              {albums.length} {albums.length === 1 ? 'album' : 'albums'}
            </p>
          )}
        </div>

        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          <IconPlus size={17} />
          New album
        </button>
      </header>

      {creating && (
        <form
          className="albums-create card"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) createAlbum.mutate(name.trim());
          }}
        >
          <input
            className="input"
            placeholder="Album name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            maxLength={200}
          />
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || createAlbum.isPending}>
            Create
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setCreating(false);
              setName('');
            }}
          >
            Cancel
          </button>
        </form>
      )}

      {albums && albums.length === 0 ? (
        <div className="albums-empty">
          <IconAlbums size={40} />
          <h2>No albums yet</h2>
          <p>Group photos into albums to find them faster, or to share a set with someone.</p>
        </div>
      ) : (
        <div className="albums-grid">
          {albums?.map((album) => (
            <Link key={album.id} to={`/albums/${album.id}`} className="album-card">
              <div className="album-cover">
                {album.coverAssetId ? (
                  <img src={assetThumbnailUrl(album.coverAssetId, album.updatedAt)} alt="" loading="lazy" />
                ) : (
                  <div className="album-cover-empty">
                    <IconAlbums size={26} />
                  </div>
                )}
              </div>

              <div className="album-meta">
                <h3>{album.name}</h3>
                <p>
                  {album.assetCount} {album.assetCount === 1 ? 'item' : 'items'}
                  {album.sharedWith.length > 0 && (
                    <span className="album-shared">
                      <IconUsers size={13} />
                      {album.sharedWith.length}
                    </span>
                  )}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
