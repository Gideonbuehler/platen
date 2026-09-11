import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Asset } from '@platen/shared';
import { AddToAlbumDialog } from '../components/AddToAlbumDialog';
import { IconArchive, IconHeart, IconPhotos, IconSpinner, IconTrash } from '../components/Icons';
import { Lightbox } from '../components/Lightbox';
import { MemoriesStrip } from '../components/MemoriesStrip';
import { PhotoGrid } from '../components/PhotoGrid';
import { SelectionBar } from '../components/SelectionBar';
import { TimelineScrubber } from '../components/TimelineScrubber';
import { api } from '../lib/api';
import { useTimeline, type TimelineVariant } from '../hooks/useTimeline';
import './Timeline.css';

const COPY: Record<
  TimelineVariant,
  { title: string; emptyTitle: string; emptyBody: string; icon: typeof IconPhotos }
> = {
  all: {
    title: 'Photos',
    emptyTitle: 'Nothing here yet',
    emptyBody: 'Drop photos anywhere on this page, or set up automatic backup in the mobile app.',
    icon: IconPhotos,
  },
  favorites: {
    title: 'Favourites',
    emptyTitle: 'No favourites yet',
    emptyBody: 'Tap the heart on a photo to keep it here.',
    icon: IconHeart,
  },
  archive: {
    title: 'Archive',
    emptyTitle: 'Archive is empty',
    emptyBody: 'Archived photos stay in your library but are hidden from the main timeline.',
    icon: IconArchive,
  },
  trash: {
    title: 'Trash',
    emptyTitle: 'Trash is empty',
    emptyBody: 'Deleted photos wait here for 30 days before they are removed for good.',
    icon: IconTrash,
  },
};

export function TimelinePage({ variant }: { variant: TimelineVariant }) {
  // Set by the scrubber. Changing it restarts the list at that date rather
  // than making the user scroll everything in between.
  const [jumpFrom, setJumpFrom] = useState<string | undefined>(undefined);
  const [visibleDate, setVisibleDate] = useState<string | null>(null);

  const {
    assets,
    isLoading,
    isError,
    error,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    toggleFavorite,
    deleteAssets,
    restoreAssets,
    archiveAssets,
  } = useTimeline(variant, jumpFrom);

  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  /**
   * A memory opens its own viewer over its own list.
   *
   * Reusing the timeline's would mean swiping out of 2019 and straight into
   * last Tuesday — "next" inside a memory means the next photo from that day,
   * which is a different list entirely.
   */
  const [memoryView, setMemoryView] = useState<{ assets: Asset[]; index: number } | null>(null);
  const [albumDialogOpen, setAlbumDialogOpen] = useState(false);

  const copy = COPY[variant];

  // Total count for the header, cheap enough to fetch separately and far more
  // honest than counting the pages loaded so far.
  const { data: buckets } = useQuery({
    queryKey: ['buckets', variant],
    queryFn: () =>
      api.buckets(
        variant === 'favorites'
          ? { favorite: true }
          : variant === 'archive'
            ? { archived: true }
            : variant === 'trash'
              ? { trashed: true }
              : {},
      ),
  });

  const total = useMemo(
    () => buckets?.reduce((sum, bucket) => sum + bucket.count, 0) ?? 0,
    [buckets],
  );

  const selectedIds = useMemo(() => [...selection], [selection]);
  const clearSelection = useCallback(() => setSelection(new Set()), []);

  const openAt = useCallback(
    (asset: Asset) => setLightboxIndex(assets.findIndex((a) => a.id === asset.id)),
    [assets],
  );

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (isLoading) {
    return (
      <div className="timeline-loading">
        <IconSpinner size={26} />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="timeline-error card">
        <h2>Could not load your photos</h2>
        <p>{error instanceof Error ? error.message : 'Unknown error'}</p>
      </div>
    );
  }

  return (
    <>
      <header className="timeline-header">
        <div>
          <h1>{copy.title}</h1>
          {total > 0 && (
            <p className="timeline-subtitle">
              {total.toLocaleString()} {total === 1 ? 'item' : 'items'}
            </p>
          )}
        </div>
      </header>

      {variant === 'all' && (
        <MemoriesStrip onOpen={(memoryAssets, index) => setMemoryView({ assets: memoryAssets, index })} />
      )}

      <PhotoGrid
        assets={assets}
        onOpen={openAt}
        selection={selection}
        onSelectionChange={setSelection}
        onLoadMore={loadMore}
        loadingMore={isFetchingNextPage}
        onVisibleDateChange={setVisibleDate}
        empty={
          <div className="timeline-empty">
            <copy.icon size={40} />
            <h2>{copy.emptyTitle}</h2>
            <p>{copy.emptyBody}</p>
          </div>
        }
      />

      {isFetchingNextPage && (
        <div className="timeline-more">
          <IconSpinner size={20} />
        </div>
      )}

      {buckets && buckets.length > 1 && (
        <TimelineScrubber
          buckets={buckets}
          activeDate={visibleDate}
          onJump={(date) => {
            // Buckets are local dates; the API wants an instant. End-of-day
            // UTC covers every photo taken on that date whatever its offset.
            setJumpFrom(`${date}T23:59:59.999Z`);
            window.scrollTo({ top: 0 });
          }}
        />
      )}

      <SelectionBar
        count={selection.size}
        variant={variant === 'trash' ? 'trash' : 'default'}
        onClear={clearSelection}
        onFavorite={() => {
          for (const id of selectedIds) {
            const asset = assets.find((a) => a.id === id);
            if (asset && !asset.isFavorite) toggleFavorite.mutate({ asset });
          }
          clearSelection();
        }}
        onAddToAlbum={() => setAlbumDialogOpen(true)}
        onArchive={() => {
          archiveAssets.mutate({ ids: selectedIds, archived: variant !== 'archive' });
          clearSelection();
        }}
        onDelete={() => {
          deleteAssets.mutate({ ids: selectedIds });
          clearSelection();
        }}
        onRestore={() => {
          restoreAssets.mutate(selectedIds);
          clearSelection();
        }}
        onDeleteForever={() => {
          if (
            window.confirm(
              `Permanently delete ${selectedIds.length} item(s)? This cannot be undone.`,
            )
          ) {
            deleteAssets.mutate({ ids: selectedIds, permanent: true });
            clearSelection();
          }
        }}
      />

      {albumDialogOpen && (
        <AddToAlbumDialog
          assetIds={selectedIds}
          onClose={() => setAlbumDialogOpen(false)}
          onDone={() => {
            setAlbumDialogOpen(false);
            clearSelection();
          }}
        />
      )}

      {lightboxIndex !== null && assets[lightboxIndex] && (
        <Lightbox
          assets={assets}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onToggleFavorite={(asset) => toggleFavorite.mutate({ asset })}
          onDelete={(asset) => {
            deleteAssets.mutate({ ids: [asset.id] });
            // Stay in the viewer on the next photo, unless that was the last one.
            setLightboxIndex((current) =>
              current === null ? null : current >= assets.length - 1 ? null : current,
            );
          }}
        />
      )}

      {memoryView && (
        <Lightbox
          assets={memoryView.assets}
          index={memoryView.index}
          onIndexChange={(index) => setMemoryView((current) => (current ? { ...current, index } : null))}
          onClose={() => setMemoryView(null)}
          onToggleFavorite={(asset) => toggleFavorite.mutate({ asset })}
          onDelete={(asset) => {
            deleteAssets.mutate({ ids: [asset.id] });
            setMemoryView(null);
          }}
        />
      )}
    </>
  );
}
