import { useQuery } from '@tanstack/react-query';
import type { Asset, Memory } from '@aperture/shared';
import { api, assetThumbnailUrl } from '../lib/api';
import './MemoriesStrip.css';

/**
 * "On this day" — the same date in earlier years.
 *
 * The date sent is the browser's, not the server's. A NAS running UTC and a
 * viewer in Chicago disagree about what day it is for six hours out of every
 * twenty-four, and on a feature whose entire premise is "today", being a day
 * out is the whole bug.
 */
function localToday(): { month: number; day: number } {
  const now = new Date();
  return { month: now.getMonth() + 1, day: now.getDate() };
}

function label(memory: Memory): string {
  return memory.yearsAgo === 1 ? 'A year ago' : `${memory.yearsAgo} years ago`;
}

function longDate(date: string): string {
  // Parsed as UTC and read back as UTC: this is a calendar date, not an
  // instant, and letting the local timezone shift it would move the label off
  // the day the photos were actually taken.
  const parsed = new Date(`${date}T00:00:00Z`);
  return parsed.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function MemoriesStrip({ onOpen }: { onOpen: (assets: Asset[], index: number) => void }) {
  const { month, day } = localToday();

  const { data: memories } = useQuery({
    queryKey: ['memories', month, day],
    queryFn: () => api.memories(month, day),
    // The answer only changes at midnight, and a wrong answer is merely a
    // missing strip, so there is no reason to refetch this on every focus.
    staleTime: 60 * 60 * 1000,
  });

  if (!memories || memories.length === 0) return null;

  return (
    <section className="memories" aria-label="On this day">
      <h2 className="memories-title">On this day</h2>

      <div className="memories-row">
        {memories.map((memory) => {
          const cover = memory.assets[0];
          if (!cover) return null;

          return (
            <button
              key={memory.year}
              type="button"
              className="memories-card"
              onClick={() => onOpen(memory.assets, 0)}
            >
              <img
                src={assetThumbnailUrl(cover.id, cover.updatedAt)}
                alt=""
                loading="lazy"
                decoding="async"
              />

              <div className="memories-card-body">
                <span className="memories-card-years">{label(memory)}</span>
                <span className="memories-card-date">{longDate(memory.date)}</span>
              </div>

              {memory.assetCount > 1 && (
                <span className="memories-card-count">{memory.assetCount}</span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
