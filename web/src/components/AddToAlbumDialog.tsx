import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { IconAlbums, IconPlus, IconSpinner } from './Icons';
import './AddToAlbumDialog.css';

interface AddToAlbumDialogProps {
  assetIds: string[];
  onClose: () => void;
  onDone: () => void;
}

export function AddToAlbumDialog({ assetIds, onClose, onDone }: AddToAlbumDialogProps) {
  const queryClient = useQueryClient();
  const [newAlbumName, setNewAlbumName] = useState('');

  const { data: albums, isLoading } = useQuery({ queryKey: ['albums'], queryFn: api.albums });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['albums'] });
    void queryClient.invalidateQueries({ queryKey: ['album-assets'] });
  };

  const addToExisting = useMutation({
    mutationFn: (albumId: string) => api.addToAlbum(albumId, assetIds),
    onSuccess: () => {
      invalidate();
      onDone();
    },
  });

  const createWith = useMutation({
    mutationFn: (name: string) => api.createAlbum({ name, assetIds }),
    onSuccess: () => {
      invalidate();
      onDone();
    },
  });

  const busy = addToExisting.isPending || createWith.isPending;

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog card"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Add to album"
      >
        <header className="dialog-header">
          <h2>Add {assetIds.length} {assetIds.length === 1 ? 'item' : 'items'} to…</h2>
        </header>

        <form
          className="dialog-create"
          onSubmit={(event) => {
            event.preventDefault();
            if (newAlbumName.trim()) createWith.mutate(newAlbumName.trim());
          }}
        >
          <input
            className="input"
            placeholder="New album name"
            value={newAlbumName}
            onChange={(event) => setNewAlbumName(event.target.value)}
            maxLength={200}
            autoFocus
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!newAlbumName.trim() || busy}
            aria-label="Create album and add"
          >
            <IconPlus size={17} />
          </button>
        </form>

        <div className="dialog-list">
          {isLoading ? (
            <div className="dialog-loading">
              <IconSpinner size={20} />
            </div>
          ) : albums && albums.length > 0 ? (
            albums.map((album) => (
              <button
                key={album.id}
                type="button"
                className="dialog-album"
                onClick={() => addToExisting.mutate(album.id)}
                disabled={busy}
              >
                <span className="dialog-album-icon">
                  <IconAlbums size={16} />
                </span>
                <span className="dialog-album-name">{album.name}</span>
                <span className="dialog-album-count">{album.assetCount}</span>
              </button>
            ))
          ) : (
            <p className="dialog-hint">No albums yet — create one above.</p>
          )}
        </div>

        <footer className="dialog-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}
