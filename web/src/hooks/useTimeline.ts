import { useCallback, useMemo } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Asset, Page } from '@aperture/shared';
import { api } from '../lib/api';

export type TimelineVariant = 'all' | 'favorites' | 'archive' | 'trash';

const FILTERS: Record<TimelineVariant, Record<string, boolean>> = {
  all: {},
  favorites: { favorite: true },
  archive: { archived: true },
  trash: { trashed: true },
};

/**
 * Cursor-paged timeline with the mutations that act on it.
 *
 * Favourite and delete both update the cache optimistically: on a LAN the round
 * trip is quick, but a heart that waits for the server still feels broken.
 */
export function useTimeline(variant: TimelineVariant, from?: string) {
  const queryClient = useQueryClient();
  const filters = FILTERS[variant];

  // `from` is part of the key so jumping to a date starts a fresh list rather
  // than appending to whatever was already loaded.
  const queryKey = useMemo(() => ['assets', variant, from ?? 'top'] as const, [variant, from]);

  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.timeline({
        ...filters,
        cursor: pageParam,
        // Only the first page is anchored to the jump date; after that the
        // cursor carries the position and `from` would fight it.
        from: pageParam ? undefined : from,
        limit: 120,
      }),
    getNextPageParam: (lastPage: Page<Asset>) => lastPage.nextCursor ?? undefined,
  });

  const assets = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );

  /** Applies a change to every cached page in place. */
  const patchCache = useCallback(
    (ids: Set<string>, patch: Partial<Asset> | 'remove') => {
      queryClient.setQueryData<{ pages: Page<Asset>[]; pageParams: unknown[] }>(
        queryKey,
        (previous) => {
          if (!previous) return previous;
          return {
            ...previous,
            pages: previous.pages.map((page) => ({
              ...page,
              items:
                patch === 'remove'
                  ? page.items.filter((item) => !ids.has(item.id))
                  : page.items.map((item) => (ids.has(item.id) ? { ...item, ...patch } : item)),
            })),
          };
        },
      );
    },
    [queryClient, queryKey],
  );

  const toggleFavorite = useMutation({
    mutationFn: ({ asset }: { asset: Asset }) =>
      api.updateAsset(asset.id, { isFavorite: !asset.isFavorite }),
    onMutate: ({ asset }) => {
      patchCache(new Set([asset.id]), { isFavorite: !asset.isFavorite });
      return { asset };
    },
    onError: (_error, { asset }) => {
      patchCache(new Set([asset.id]), { isFavorite: asset.isFavorite });
    },
    onSettled: () => {
      // The favourites view is a different query key, so refresh it too.
      void queryClient.invalidateQueries({ queryKey: ['assets', 'favorites'] });
    },
  });

  const deleteAssets = useMutation({
    mutationFn: ({ ids, permanent }: { ids: string[]; permanent?: boolean }) =>
      api.deleteAssets(ids, permanent),
    onMutate: ({ ids }) => {
      patchCache(new Set(ids), 'remove');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['assets'] });
      void queryClient.invalidateQueries({ queryKey: ['buckets'] });
    },
  });

  const restoreAssets = useMutation({
    mutationFn: (ids: string[]) => api.restoreAssets(ids),
    onMutate: (ids) => {
      patchCache(new Set(ids), 'remove');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['assets'] });
    },
  });

  const archiveAssets = useMutation({
    mutationFn: ({ ids, archived }: { ids: string[]; archived: boolean }) =>
      Promise.all(ids.map((id) => api.updateAsset(id, { isArchived: archived }))),
    onMutate: ({ ids }) => {
      patchCache(new Set(ids), 'remove');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['assets'] });
    },
  });

  return {
    assets,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: query.fetchNextPage,
    toggleFavorite,
    deleteAssets,
    restoreAssets,
    archiveAssets,
  };
}
