import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TimelineBucket } from '@platen/shared';
import './TimelineScrubber.css';

interface TimelineScrubberProps {
  buckets: TimelineBucket[];
  /** Date currently at the top of the viewport, as YYYY-MM-DD. */
  activeDate: string | null;
  /** Asked to load the timeline starting at this date. */
  onJump: (date: string) => void;
}

interface Tick {
  /** First date in this month, YYYY-MM-DD. */
  date: string;
  year: number;
  month: number;
  label: string;
  /** Fraction down the rail, 0..1. */
  offset: number;
  /** Whether this tick starts a new year, which gets a heavier label. */
  startsYear: boolean;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Positions ticks by cumulative photo count rather than by elapsed time.
 *
 * A calendar-proportional rail devotes the same space to a month with four
 * photos as to a holiday with six hundred, so most of it is empty and the
 * dense parts are impossible to hit. Weighting by count makes the rail match
 * what is actually being scrolled through.
 */
function buildTicks(buckets: TimelineBucket[]): { ticks: Tick[]; total: number } {
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  if (total === 0) return { ticks: [], total: 0 };

  const ticks: Tick[] = [];
  let cumulative = 0;
  let lastKey = '';
  let lastYear = -1;

  // Buckets arrive newest-first, which is the direction the rail runs.
  for (const bucket of buckets) {
    const [yearStr, monthStr] = bucket.date.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr);
    const key = `${year}-${month}`;

    if (key !== lastKey) {
      ticks.push({
        date: bucket.date,
        year,
        month,
        label: MONTH_NAMES[month - 1] ?? '',
        offset: cumulative / total,
        startsYear: year !== lastYear,
      });
      lastKey = key;
      lastYear = year;
    }
    cumulative += bucket.count;
  }

  return { ticks, total };
}

export function TimelineScrubber({ buckets, activeDate, onJump }: TimelineScrubberProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [hoverOffset, setHoverOffset] = useState<number | null>(null);

  const { ticks, total } = useMemo(() => buildTicks(buckets), [buckets]);

  /** Where the current scroll position sits on the rail, 0..1. */
  const activeOffset = useMemo(() => {
    if (!activeDate || total === 0) return 0;
    let cumulative = 0;
    for (const bucket of buckets) {
      if (bucket.date <= activeDate) return cumulative / total;
      cumulative += bucket.count;
    }
    return 1;
  }, [activeDate, buckets, total]);

  /** Nearest bucket date to a fraction down the rail. */
  const dateAtOffset = useCallback(
    (offset: number): string | null => {
      if (total === 0) return null;
      const target = offset * total;
      let cumulative = 0;
      for (const bucket of buckets) {
        cumulative += bucket.count;
        if (cumulative >= target) return bucket.date;
      }
      return buckets[buckets.length - 1]?.date ?? null;
    },
    [buckets, total],
  );

  const offsetFromEvent = useCallback((clientY: number): number => {
    const rail = railRef.current;
    if (!rail) return 0;
    const rect = rail.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
  }, []);

  // Pointer events are captured on the window so a drag survives the pointer
  // leaving the narrow rail, which it will constantly.
  useEffect(() => {
    if (!dragging) return;

    const onMove = (event: PointerEvent) => {
      const offset = offsetFromEvent(event.clientY);
      setHoverOffset(offset);
      const date = dateAtOffset(offset);
      if (date) onJump(date);
    };
    const onUp = () => {
      setDragging(false);
      setHoverOffset(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragging, offsetFromEvent, dateAtOffset, onJump]);

  if (ticks.length < 2) return null;

  const previewOffset = hoverOffset ?? activeOffset;
  const previewDate = dateAtOffset(previewOffset);

  return (
    <div
      ref={railRef}
      className={`scrubber${dragging ? ' is-dragging' : ''}`}
      onPointerDown={(event) => {
        event.preventDefault();
        setDragging(true);
        const offset = offsetFromEvent(event.clientY);
        setHoverOffset(offset);
        const date = dateAtOffset(offset);
        if (date) onJump(date);
      }}
      onPointerMove={(event) => {
        if (!dragging) setHoverOffset(offsetFromEvent(event.clientY));
      }}
      onPointerLeave={() => {
        if (!dragging) setHoverOffset(null);
      }}
      role="slider"
      aria-label="Jump to date"
      aria-valuetext={previewDate ?? undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(activeOffset * 100)}
      tabIndex={0}
      onKeyDown={(event) => {
        // Keyboard stepping moves a month at a time, which is the unit the
        // labels are in — stepping by percent would feel arbitrary.
        const index = ticks.findIndex((tick) => tick.offset >= activeOffset);
        const current = index === -1 ? ticks.length - 1 : index;
        if (event.key === 'ArrowDown' || event.key === 'PageDown') {
          event.preventDefault();
          onJump(ticks[Math.min(ticks.length - 1, current + 1)]!.date);
        } else if (event.key === 'ArrowUp' || event.key === 'PageUp') {
          event.preventDefault();
          onJump(ticks[Math.max(0, current - 1)]!.date);
        }
      }}
    >
      <div className="scrubber-track" />

      {ticks.map((tick) => (
        <div
          key={`${tick.year}-${tick.month}`}
          className={`scrubber-tick${tick.startsYear ? ' is-year' : ''}`}
          style={{ top: `${tick.offset * 100}%` }}
        >
          <span className="scrubber-tick-line" />
          {tick.startsYear && <span className="scrubber-tick-label">{tick.year}</span>}
        </div>
      ))}

      {/* The current position, and — while scrubbing — the date under the
          pointer, which is the only feedback that makes dragging usable. */}
      <div className="scrubber-thumb" style={{ top: `${previewOffset * 100}%` }} />

      {(dragging || hoverOffset !== null) && previewDate && (
        <div className="scrubber-bubble" style={{ top: `${previewOffset * 100}%` }}>
          {new Date(`${previewDate}T12:00:00Z`).toLocaleDateString(undefined, {
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC',
          })}
        </div>
      )}
    </div>
  );
}
