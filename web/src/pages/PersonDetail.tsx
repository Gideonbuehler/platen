import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Asset } from '@aperture/shared';
import { IconCheck, IconChevronLeft, IconSpinner, IconUsers } from '../components/Icons';
import { Lightbox } from '../components/Lightbox';
import { PhotoGrid } from '../components/PhotoGrid';
import { api, faceThumbnailUrl } from '../lib/api';
import './People.css';

export function PersonDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [editing, setEditing] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const { data: person, isLoading } = useQuery({
    queryKey: ['person', id],
    queryFn: () => api.person(id!),
    enabled: Boolean(id),
  });

  const { data: page } = useQuery({
    queryKey: ['person-assets', id],
    queryFn: () => api.personAssets(id!),
    enabled: Boolean(id),
  });

  // Seed the input once the person loads, without clobbering an in-progress edit.
  useEffect(() => {
    if (person && !editing) setName(person.name ?? '');
  }, [person, editing]);

  const rename = useMutation({
    mutationFn: (value: string) => api.updatePerson(id!, { name: value || null }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['person', id] });
      void queryClient.invalidateQueries({ queryKey: ['people'] });
      setEditing(false);
    },
  });

  const hide = useMutation({
    mutationFn: () => api.updatePerson(id!, { isHidden: true }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['people'] });
      navigate('/people');
    },
  });

  const assets = page?.items ?? [];

  const openAt = useCallback(
    (asset: Asset) => setLightboxIndex(assets.findIndex((a) => a.id === asset.id)),
    [assets],
  );

  if (isLoading || !person) {
    return (
      <div className="people-loading">
        <IconSpinner size={26} />
      </div>
    );
  }

  return (
    <>
      <Link to="/people" className="album-back">
        <IconChevronLeft size={16} />
        People
      </Link>

      <header className="person-detail-header">
        <div className="person-detail-avatar">
          {person.coverFaceId ? (
            <img src={faceThumbnailUrl(person.coverFaceId)} alt="" />
          ) : (
            <div className="person-avatar-empty">
              <IconUsers size={26} />
            </div>
          )}
        </div>

        <div className="person-detail-meta">
          {editing ? (
            <form
              className="person-name-form"
              onSubmit={(event) => {
                event.preventDefault();
                rename.mutate(name.trim());
              }}
            >
              <input
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Add a name"
                maxLength={120}
                autoFocus
              />
              <button type="submit" className="btn btn-primary btn-icon" aria-label="Save name">
                <IconCheck size={17} />
              </button>
            </form>
          ) : (
            <button type="button" className="person-detail-name" onClick={() => setEditing(true)}>
              {person.name ?? 'Add a name'}
            </button>
          )}

          <p className="people-subtitle">
            {person.assetCount} {person.assetCount === 1 ? 'photo' : 'photos'} ·{' '}
            {person.faceCount} {person.faceCount === 1 ? 'face' : 'faces'}
          </p>
        </div>

        <button type="button" className="btn btn-secondary" onClick={() => hide.mutate()}>
          Hide this person
        </button>
      </header>

      <PhotoGrid
        assets={assets}
        onOpen={openAt}
        selection={selection}
        onSelectionChange={setSelection}
        empty={
          <div className="people-empty">
            <IconUsers size={38} />
            <h2>No photos</h2>
            <p>The photos this person appeared in may have been deleted.</p>
          </div>
        }
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
