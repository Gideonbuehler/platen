import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface UploadItem {
  id: string;
  file: File;
  status: 'pending' | 'uploading' | 'done' | 'duplicate' | 'error';
  progress: number;
  error?: string;
}

interface UploadsContextValue {
  queue: UploadItem[];
  addFiles: (files: File[]) => void;
  clearFinished: () => void;
}

const UploadsContext = createContext<UploadsContextValue | null>(null);

/**
 * Two at a time.
 *
 * Browsers cap concurrent connections per origin at six; leaving headroom means
 * thumbnails keep loading while an upload runs, so the app does not appear to
 * freeze when someone drops a folder of photos into it.
 */
const CONCURRENCY = 2;

export function UploadsProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<UploadItem[]>([]);
  const queryClient = useQueryClient();

  // The pump reads the queue through a ref so it does not need to be a
  // dependency, which would restart it on every progress tick.
  const queueRef = useRef<UploadItem[]>([]);
  const activeRef = useRef(0);
  const pumpingRef = useRef(false);

  // Ids the pump has already picked up.
  //
  // `update()` goes through setState, so the ref it reads is still one render
  // behind when the pump's inner loop comes round for the next slot. Without a
  // synchronous record of what has been started, filling two concurrent slots
  // would hand the very same file to both of them.
  const startedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  const update = useCallback((id: string, patch: Partial<UploadItem>) => {
    setQueue((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const pump = useCallback(() => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;

    const step = (): void => {
      while (activeRef.current < CONCURRENCY) {
        const next = queueRef.current.find(
          (item) => item.status === 'pending' && !startedRef.current.has(item.id),
        );
        if (!next) break;

        activeRef.current++;
        startedRef.current.add(next.id);
        update(next.id, { status: 'uploading', progress: 0 });

        api
          .uploadFile(next.file, (fraction) => update(next.id, { progress: fraction }))
          .then((result) => {
            update(next.id, {
              status: result.duplicate ? 'duplicate' : 'done',
              progress: 1,
            });
          })
          .catch((error: unknown) => {
            update(next.id, {
              status: 'error',
              error: error instanceof Error ? error.message : 'Upload failed',
            });
          })
          .finally(() => {
            activeRef.current--;
            if (
              queueRef.current.some(
                (item) => item.status === 'pending' && !startedRef.current.has(item.id),
              )
            ) {
              // Give React a tick to flush the status change before re-scanning,
              // otherwise the same item can be picked up twice.
              setTimeout(step, 0);
            } else if (activeRef.current === 0) {
              pumpingRef.current = false;
              // Everything landed — refresh the timeline so new photos appear.
              void queryClient.invalidateQueries({ queryKey: ['assets'] });
              void queryClient.invalidateQueries({ queryKey: ['buckets'] });
            }
          });
      }

      if (activeRef.current === 0) pumpingRef.current = false;
    };

    step();
  }, [update, queryClient]);

  const addFiles = useCallback(
    (files: File[]) => {
      const accepted = files.filter(
        (file) => file.type.startsWith('image/') || file.type.startsWith('video/') || file.type === '',
      );
      if (accepted.length === 0) return;

      const items: UploadItem[] = accepted.map((file) => ({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        status: 'pending',
        progress: 0,
      }));

      setQueue((prev) => [...prev, ...items]);
      queueRef.current = [...queueRef.current, ...items];
      pump();
    },
    [pump],
  );

  const clearFinished = useCallback(() => {
    setQueue((prev) => {
      const kept = prev.filter(
        (item) => item.status === 'pending' || item.status === 'uploading',
      );
      const keptIds = new Set(kept.map((item) => item.id));
      startedRef.current = new Set(
        [...startedRef.current].filter((id) => keptIds.has(id)),
      );
      queueRef.current = kept;
      return kept;
    });
  }, []);

  const value = useMemo(() => ({ queue, addFiles, clearFinished }), [queue, addFiles, clearFinished]);
  return <UploadsContext.Provider value={value}>{children}</UploadsContext.Provider>;
}

export function useUploads(): UploadsContextValue {
  const context = useContext(UploadsContext);
  if (!context) throw new Error('useUploads must be used inside <UploadsProvider>');
  return context;
}
