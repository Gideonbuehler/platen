import type { Asset } from '@aperture/shared';

/**
 * Justified ("Flickr-style") row layout.
 *
 * Every row is scaled so it fills the container edge to edge, which means each
 * photo keeps its true aspect ratio while the grid still has clean left and
 * right margins. A rigid square grid is easier, but it crops every panorama and
 * every portrait, and that is exactly what makes most self-hosted galleries
 * look like a file listing rather than a photo album.
 */

export interface LayoutTile {
  asset: Asset;
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface LayoutSection {
  /** "2026-09-09" */
  date: string;
  label: string;
  headerTop: number;
  headerHeight: number;
  tiles: LayoutTile[];
}

export interface LayoutResult {
  sections: LayoutSection[];
  totalHeight: number;
}

export interface LayoutOptions {
  containerWidth: number;
  targetRowHeight: number;
  gap: number;
  headerHeight: number;
  sectionSpacing: number;
}

/** Photos with no recorded dimensions still need a sane box. */
const FALLBACK_RATIO = 3 / 2;

function aspectRatio(asset: Asset): number {
  if (!asset.width || !asset.height || asset.width <= 0 || asset.height <= 0) {
    return FALLBACK_RATIO;
  }
  const ratio = asset.width / asset.height;
  // Clamp extreme panoramas: without this, one 10:1 shot forces a row so short
  // that everything beside it becomes a thumbnail sliver.
  return Math.min(Math.max(ratio, 0.4), 4);
}

function formatDateLabel(iso: string): string {
  const date = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(date.getTime())) return iso;

  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((startOfToday.getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86_400_000);

  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';

  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString(undefined, {
    weekday: days < 7 ? 'long' : undefined,
    month: 'long',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
}

/**
 * The wall-clock time the camera recorded, as a Date whose *UTC* fields carry
 * the capture time.
 *
 * The server stores a true instant plus the original UTC offset (null when the
 * file did not record one). Shifting by that offset and then reading UTC fields
 * reproduces exactly what the camera's clock said — so a photo taken at 11pm on
 * holiday stays on that day's row, instead of jumping a day because the viewer
 * is in a different timezone from the shot.
 */
export function captureWallClock(takenAt: string, offset: string | null): Date {
  const instant = new Date(takenAt);
  if (Number.isNaN(instant.getTime())) return new Date(0);
  if (!offset) return instant;

  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(offset.trim());
  if (!match) return instant;

  const sign = match[1] === '-' ? -1 : 1;
  const minutes = sign * (Number(match[2]) * 60 + Number(match[3]));
  return new Date(instant.getTime() + minutes * 60_000);
}

/** Calendar date the photo was taken, as YYYY-MM-DD. */
export function localDateKey(takenAt: string, offset: string | null = null): string {
  const date = captureWallClock(takenAt, offset);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

/** "18:32" as the camera recorded it, for the info panel. */
export function formatCaptureTime(takenAt: string, offset: string | null): string {
  const date = captureWallClock(takenAt, offset);
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * Lays a single day's photos into justified rows.
 *
 * The greedy fill is the standard approach: keep adding photos until the row,
 * once scaled to the container width, would be shorter than the target height;
 * that is the point where one more photo makes the row too cramped.
 */
function layoutRows(
  assets: Asset[],
  startTop: number,
  options: LayoutOptions,
): { tiles: LayoutTile[]; height: number } {
  const { containerWidth, targetRowHeight, gap } = options;
  const tiles: LayoutTile[] = [];

  let row: Asset[] = [];
  let rowRatioSum = 0;
  let top = startTop;

  const flush = (isLastRow: boolean): void => {
    if (row.length === 0) return;

    const totalGap = gap * (row.length - 1);
    const available = containerWidth - totalGap;

    // Scale the row to fill the width. The last row of a section is the
    // exception: stretching three photos across a full-width row would blow
    // them up far beyond every row above, so it keeps the target height unless
    // it happens to be nearly full already.
    let rowHeight = available / rowRatioSum;
    if (isLastRow && rowHeight > targetRowHeight * 1.5) {
      rowHeight = targetRowHeight;
    }

    let left = 0;
    row.forEach((asset, index) => {
      const width = rowHeight * aspectRatio(asset);
      // Absorb rounding drift into the final tile so rows end flush.
      const isLast = index === row.length - 1;
      const finalWidth =
        isLast && !isLastRow ? Math.max(1, containerWidth - left) : Math.round(width);

      tiles.push({
        asset,
        top: Math.round(top),
        left: Math.round(left),
        width: finalWidth,
        height: Math.round(rowHeight),
      });
      left += Math.round(width) + gap;
    });

    top += Math.round(rowHeight) + gap;
    row = [];
    rowRatioSum = 0;
  };

  for (const asset of assets) {
    row.push(asset);
    rowRatioSum += aspectRatio(asset);

    const totalGap = gap * (row.length - 1);
    const projectedHeight = (containerWidth - totalGap) / rowRatioSum;

    if (projectedHeight < targetRowHeight) flush(false);
  }
  flush(true);

  return { tiles, height: top - startTop };
}

/**
 * Builds the full timeline layout: day headers plus justified rows beneath each.
 *
 * Returns absolute positions so the caller can render this into a single
 * position:relative container and virtualise by simple top/bottom comparison —
 * no nested scroll containers, no per-row measurement.
 */
export function computeLayout(assets: Asset[], options: LayoutOptions): LayoutResult {
  if (options.containerWidth <= 0 || assets.length === 0) {
    return { sections: [], totalHeight: 0 };
  }

  // Assets arrive newest-first from the API; preserve that order within days.
  const groups = new Map<string, Asset[]>();
  for (const asset of assets) {
    const key = localDateKey(asset.takenAt, asset.takenAtOffset);
    const bucket = groups.get(key);
    if (bucket) bucket.push(asset);
    else groups.set(key, [asset]);
  }

  const sections: LayoutSection[] = [];
  let cursor = 0;

  for (const [date, groupAssets] of groups) {
    const headerTop = cursor;
    cursor += options.headerHeight;

    const { tiles, height } = layoutRows(groupAssets, cursor, options);
    cursor += height + options.sectionSpacing;

    sections.push({
      date,
      label: formatDateLabel(date),
      headerTop,
      headerHeight: options.headerHeight,
      tiles,
    });
  }

  return { sections, totalHeight: Math.max(0, cursor - options.sectionSpacing) };
}

/**
 * Picks a row height that suits the viewport. Phones get shorter rows (more
 * photos on screen without each one becoming a postage stamp); wide desktop
 * displays get taller rows so a 4K monitor does not show 12 tiny photos per row.
 */
export function responsiveRowHeight(containerWidth: number): number {
  if (containerWidth < 500) return 130;
  if (containerWidth < 900) return 170;
  if (containerWidth < 1600) return 210;
  return 250;
}
