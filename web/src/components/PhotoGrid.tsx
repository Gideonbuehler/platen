import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Asset } from '@aperture/shared';
import { assetThumbnailUrl } from '../lib/api';
import { computeLayout, responsiveRowHeight, type LayoutTile } from '../lib/justified';
import { IconCheck, IconHeart, IconPlay } from './Icons';
import './PhotoGrid.css';

interface PhotoGridProps {
  assets: Asset[];
  onOpen: (asset: Asset) => void;
  selection: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
  /** Rendered when the list is empty. */
  empty?: React.ReactNode;
  /** Called when the user scrolls near the bottom. */
  onLoadMore?: () => void;
  loadingMore?: boolean;
  /** Public share pages build thumbnail URLs differently. */
  thumbnailUrl?: (asset: Asset) => string;
  /** Fires with the YYYY-MM-DD of the section currently at the top. */
  onVisibleDateChange?: (date: string) => void;
}

/** Rows rendered above and below the viewport, to hide scroll latency. */
const OVERSCAN_PX = 900;

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function PhotoGrid({
  assets,
  onOpen,
  selection,
  onSelectionChange,
  empty,
  onLoadMore,
  loadingMore,
  thumbnailUrl = (asset) => assetThumbnailUrl(asset.id, asset.updatedAt),
  onVisibleDateChange,
}: PhotoGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  // Anchor for shift-click range selection.
  const lastClickedRef = useRef<string | null>(null);

  // --- measurement --------------------------------------------------------
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);

    return () => observer.disconnect();
  }, []);

  // --- scroll tracking ----------------------------------------------------
  // The window is the scroll container, so the grid stays in normal document
  // flow and the page keeps native scroll behaviour (momentum, scrollbar,
  // find-in-page) instead of a nested overflow div.
  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const element = containerRef.current;
        if (!element) return;
        setScrollTop(Math.max(0, window.scrollY - element.offsetTop));
        setViewportHeight(window.innerHeight);
      });
    };

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // --- layout -------------------------------------------------------------
  const layout = useMemo(
    () =>
      computeLayout(assets, {
        containerWidth: width,
        targetRowHeight: responsiveRowHeight(width),
        gap: 3,
        headerHeight: 52,
        sectionSpacing: 20,
      }),
    [assets, width],
  );

  // --- infinite scroll ----------------------------------------------------
  useEffect(() => {
    if (!onLoadMore || loadingMore || layout.totalHeight === 0) return;
    const remaining = layout.totalHeight - (scrollTop + viewportHeight);
    if (remaining < 1200) onLoadMore();
  }, [scrollTop, viewportHeight, layout.totalHeight, onLoadMore, loadingMore]);

  // --- report the section under the top of the viewport -------------------
  // Drives the scrubber's position indicator. Reported only when it actually
  // changes, so a scroll does not re-render the rail on every frame.
  const lastReportedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!onVisibleDateChange || layout.sections.length === 0) return;

    let current = layout.sections[0]!;
    for (const section of layout.sections) {
      if (section.headerTop <= scrollTop + 8) current = section;
      else break;
    }

    if (lastReportedRef.current !== current.date) {
      lastReportedRef.current = current.date;
      onVisibleDateChange(current.date);
    }
  }, [scrollTop, layout.sections, onVisibleDateChange]);

  // --- selection ----------------------------------------------------------
  const toggle = useCallback(
    (asset: Asset, shiftKey: boolean) => {
      const next = new Set(selection);

      if (shiftKey && lastClickedRef.current) {
        // Range select across the flattened, display-ordered list.
        const order = assets.map((a) => a.id);
        const from = order.indexOf(lastClickedRef.current);
        const to = order.indexOf(asset.id);
        if (from !== -1 && to !== -1) {
          const [start, end] = from < to ? [from, to] : [to, from];
          for (let i = start; i <= end; i++) {
            const id = order[i];
            if (id) next.add(id);
          }
          onSelectionChange(next);
          return;
        }
      }

      if (next.has(asset.id)) next.delete(asset.id);
      else next.add(asset.id);

      lastClickedRef.current = asset.id;
      onSelectionChange(next);
    },
    [assets, selection, onSelectionChange],
  );

  const selectionMode = selection.size > 0;

  const handleTileClick = useCallback(
    (event: React.MouseEvent, asset: Asset) => {
      // Ctrl/Cmd-click always selects; a plain click only selects once the user
      // has already entered selection mode, so browsing stays a single click.
      if (event.metaKey || event.ctrlKey || event.shiftKey || selectionMode) {
        event.preventDefault();
        toggle(asset, event.shiftKey);
      } else {
        onOpen(asset);
      }
    },
    [selectionMode, toggle, onOpen],
  );

  if (assets.length === 0) {
    return (
      <div ref={containerRef} className="grid-empty">
        {empty}
      </div>
    );
  }

  const visibleTop = scrollTop - OVERSCAN_PX;
  const visibleBottom = scrollTop + viewportHeight + OVERSCAN_PX;

  return (
    <div
      ref={containerRef}
      className="photo-grid"
      style={{ height: layout.totalHeight }}
      role="grid"
      aria-label="Photo timeline"
    >
      {layout.sections.map((section) => {
        const sectionBottom =
          section.tiles.length > 0
            ? Math.max(...section.tiles.map((t) => t.top + t.height))
            : section.headerTop + section.headerHeight;

        // Skip whole sections that are nowhere near the viewport.
        if (sectionBottom < visibleTop || section.headerTop > visibleBottom) return null;

        return (
          <div key={section.date}>
            <div className="grid-section-header" style={{ top: section.headerTop }}>
              <h2>{section.label}</h2>
              <span className="grid-section-count">
                {section.tiles.length} {section.tiles.length === 1 ? 'item' : 'items'}
              </span>
            </div>

            {section.tiles.map((tile) => {
              if (tile.top + tile.height < visibleTop || tile.top > visibleBottom) return null;
              return (
                <Tile
                  key={tile.asset.id}
                  tile={tile}
                  selected={selection.has(tile.asset.id)}
                  selectionMode={selectionMode}
                  thumbnailUrl={thumbnailUrl(tile.asset)}
                  onClick={(event) => handleTileClick(event, tile.asset)}
                  onToggleSelect={(event) => {
                    event.stopPropagation();
                    event.preventDefault();
                    toggle(tile.asset, event.shiftKey);
                  }}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

interface TileProps {
  tile: LayoutTile;
  selected: boolean;
  selectionMode: boolean;
  thumbnailUrl: string;
  onClick: (event: React.MouseEvent) => void;
  onToggleSelect: (event: React.MouseEvent) => void;
}

function Tile({ tile, selected, selectionMode, thumbnailUrl, onClick, onToggleSelect }: TileProps) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const { asset } = tile;

  const pending = asset.thumbStatus === 'pending';

  // A thumbnail served from cache — or from a NAS on the same LAN — can finish
  // decoding before React attaches onLoad, in which case the event never fires
  // and the tile would stay at opacity 0 forever. Check completeness on mount
  // as well as listening for the event.
  useEffect(() => {
    const image = imageRef.current;
    if (image?.complete) {
      if (image.naturalWidth > 0) setLoaded(true);
      else setFailed(true);
    }
  }, [thumbnailUrl]);

  return (
    <div
      className={`grid-tile${selected ? ' is-selected' : ''}`}
      style={{ top: tile.top, left: tile.left, width: tile.width, height: tile.height }}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick(event as unknown as React.MouseEvent);
        }
      }}
      role="gridcell"
      tabIndex={0}
      aria-selected={selected}
      aria-label={asset.originalFilename}
    >
      {!loaded && !failed && <div className="grid-tile-placeholder skeleton" />}

      {failed || pending ? (
        <div className="grid-tile-fallback" title={pending ? 'Still processing' : 'Preview unavailable'}>
          <span>{pending ? 'Processing' : 'No preview'}</span>
        </div>
      ) : (
        <img
          ref={imageRef}
          src={thumbnailUrl}
          alt={asset.originalFilename}
          loading="lazy"
          decoding="async"
          draggable={false}
          className={loaded ? 'is-loaded' : ''}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}

      <div className="grid-tile-scrim" />

      {asset.type === 'video' && (
        <div className="grid-tile-video">
          <IconPlay size={13} />
          {asset.durationMs ? <span>{formatDuration(asset.durationMs)}</span> : null}
        </div>
      )}

      {asset.isFavorite && (
        <div className="grid-tile-favorite">
          <IconHeart size={15} filled />
        </div>
      )}

      <button
        type="button"
        className={`grid-tile-check${selected ? ' is-checked' : ''}${selectionMode ? ' is-visible' : ''}`}
        onClick={onToggleSelect}
        aria-label={selected ? 'Deselect' : 'Select'}
      >
        <IconCheck size={13} />
      </button>
    </div>
  );
}
