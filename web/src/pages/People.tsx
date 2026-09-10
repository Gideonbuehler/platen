import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconCheck, IconSpinner, IconUsers } from '../components/Icons';
import { api, faceThumbnailUrl } from '../lib/api';
import './People.css';

export function PeoplePage() {
  const queryClient = useQueryClient();
  const [merging, setMerging] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data: status } = useQuery({
    queryKey: ['face-status'],
    queryFn: api.faceStatus,
    // Follow along while a first scan works through the library.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 5_000;
      return data.state === 'loading' || data.pending > 0 ? 5_000 : false;
    },
  });

  const { data: people, isLoading } = useQuery({ queryKey: ['people'], queryFn: api.people });

  const rescan = useMutation({
    mutationFn: () => api.rescanFaces(false),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['face-status'] }),
  });

  const merge = useMutation({
    mutationFn: ({ target, sources }: { target: string; sources: string[] }) =>
      api.mergePeople(target, sources),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['people'] });
      setSelected(new Set());
      setMerging(false);
    },
  });

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  if (isLoading) {
    return (
      <div className="people-loading">
        <IconSpinner size={26} />
      </div>
    );
  }

  if (status && !status.enabled) {
    return (
      <>
        <header className="people-header">
          <h1>People</h1>
        </header>
        <div className="people-empty">
          <IconUsers size={40} />
          <h2>Face grouping is turned off</h2>
          <p>
            Set <code>ENABLE_FACES=true</code> on the server to group photos by who is in them.
            It downloads about 190 MB of models and adds a little CPU work per photo.
          </p>
        </div>
      </>
    );
  }

  const scanning = status && (status.state === 'loading' || status.pending > 0);

  return (
    <>
      <header className="people-header">
        <div>
          <h1>People</h1>
          {people && people.length > 0 && (
            <p className="people-subtitle">
              {people.length} {people.length === 1 ? 'person' : 'people'} found
            </p>
          )}
        </div>

        <div className="people-actions">
          {people && people.length > 1 && (
            <button
              type="button"
              className={`btn ${merging ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => {
                setMerging((v) => !v);
                setSelected(new Set());
              }}
            >
              {merging ? 'Cancel' : 'Merge people'}
            </button>
          )}
        </div>
      </header>

      {scanning && status && (
        <div className="people-scanning">
          <IconSpinner size={15} />
          <span>
            {status.state === 'loading'
              ? 'Loading face models…'
              : `Scanning photos for faces — ${status.scanned.toLocaleString()} of ${status.total.toLocaleString()} done`}
          </span>
        </div>
      )}

      {merging && (
        <div className="people-merge-bar">
          <span>
            {selected.size === 0
              ? 'Pick the people who are the same person.'
              : `${selected.size} selected — the first one keeps its name.`}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={selected.size < 2 || merge.isPending}
            onClick={() => {
              const [target, ...sources] = [...selected];
              if (target && sources.length > 0) merge.mutate({ target, sources });
            }}
          >
            Merge {selected.size > 1 ? selected.size : ''}
          </button>
        </div>
      )}

      {people && people.length === 0 ? (
        <div className="people-empty">
          <IconUsers size={40} />
          <h2>No people yet</h2>
          <p>
            {status && status.pending > 0
              ? 'Still scanning your library. People appear as faces are found and grouped.'
              : 'Nobody has been recognised in enough photos yet. A face needs to turn up more than once before it becomes a person.'}
          </p>
          {status && status.pending === 0 && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => rescan.mutate()}
              disabled={rescan.isPending}
            >
              Scan for faces
            </button>
          )}
        </div>
      ) : (
        <div className="people-grid">
          {people?.map((person) => {
            const isSelected = selected.has(person.id);
            const content = (
              <>
                <div className={`person-avatar${isSelected ? ' is-selected' : ''}`}>
                  {person.coverFaceId ? (
                    <img src={faceThumbnailUrl(person.coverFaceId)} alt="" loading="lazy" />
                  ) : (
                    <div className="person-avatar-empty">
                      <IconUsers size={22} />
                    </div>
                  )}
                  {merging && isSelected && (
                    <span className="person-check">
                      <IconCheck size={14} />
                    </span>
                  )}
                </div>
                <span className="person-name">{person.name ?? 'Unnamed'}</span>
                <span className="person-count">
                  {person.assetCount} {person.assetCount === 1 ? 'photo' : 'photos'}
                </span>
              </>
            );

            return merging ? (
              <button
                key={person.id}
                type="button"
                className="person-card"
                onClick={() => toggle(person.id)}
              >
                {content}
              </button>
            ) : (
              <Link key={person.id} to={`/people/${person.id}`} className="person-card">
                {content}
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
