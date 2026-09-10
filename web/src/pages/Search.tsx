import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Asset } from '@aperture/shared';
import { IconSearch, IconSpinner } from '../components/Icons';
import { Lightbox } from '../components/Lightbox';
import { PhotoGrid } from '../components/PhotoGrid';
import { api } from '../lib/api';
import './Search.css';

/** Example prompts, to teach what semantic search can actually do. */
const SUGGESTIONS = [
  'sunset over water',
  'snow covered mountains',
  'birthday cake and candles',
  'dog on a beach',
  'city street at night',
  'plate of food',
];

export function SearchPage() {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());

  const { data: status } = useQuery({ queryKey: ['search-status'], queryFn: api.searchStatus });

  // Debounce so a fast typist does not queue a CLIP text encode per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), 350);
    return () => clearTimeout(timer);
  }, [input]);

  const semantic = status?.enabled ?? false;

  const { data: results, isFetching } = useQuery({
    queryKey: ['search', query, semantic],
    queryFn: async () => {
      if (semantic) {
        const hits = await api.search(query);
        return hits.map((hit) => hit.asset);
      }
      return api.searchMetadata(query);
    },
    enabled: query.length > 0,
  });

  const assets = results ?? [];

  const openAt = useCallback(
    (asset: Asset) => setLightboxIndex(assets.findIndex((a) => a.id === asset.id)),
    [assets],
  );

  const indexProgress =
    status && status.total > 0 ? Math.round((status.indexed / status.total) * 100) : 100;

  return (
    <>
      <header className="search-header">
        <h1>Search</h1>

        <div className="search-field">
          <IconSearch size={18} />
          <input
            className="search-input"
            placeholder={
              semantic ? 'Describe a photo — “red umbrella in the rain”' : 'Filename, camera, place…'
            }
            value={input}
            onChange={(event) => setInput(event.target.value)}
            autoFocus
          />
          {isFetching && <IconSpinner size={17} />}
        </div>

        {semantic && status && status.indexed < status.total && (
          <p className="search-indexing">
            Indexing your library for search — {indexProgress}% done (
            {status.indexed.toLocaleString()} of {status.total.toLocaleString()}). Results improve as
            it finishes.
          </p>
        )}

        {!semantic && (
          <p className="search-indexing">
            Semantic search is off, so this searches filenames and camera details only. Enable it by
            setting <code>ENABLE_ML=true</code> on the server.
          </p>
        )}
      </header>

      {query.length === 0 ? (
        <div className="search-suggestions">
          <p>Try searching for…</p>
          <div className="search-chips">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="search-chip"
                onClick={() => setInput(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          {assets.length > 0 && (
            <p className="search-count">
              {assets.length} {assets.length === 1 ? 'result' : 'results'}
            </p>
          )}

          <PhotoGrid
            assets={assets}
            onOpen={openAt}
            selection={selection}
            onSelectionChange={setSelection}
            empty={
              isFetching ? (
                <IconSpinner size={26} />
              ) : (
                <div className="search-empty">
                  <IconSearch size={38} />
                  <h2>No matches</h2>
                  <p>
                    {semantic
                      ? 'Try describing the scene differently — colours, objects, or the place.'
                      : 'Try part of a filename, or a camera model.'}
                  </p>
                </div>
              )
            }
          />
        </>
      )}

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
