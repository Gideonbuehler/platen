/**
 * Turns a drop into a flat list of real files.
 *
 * `DataTransfer.files` is a trap for folder drops: the browser puts the folder
 * itself in the list as a zero-byte entry with no MIME type, and any attempt to
 * read it fails — which surfaces as a generic network error at send time, with
 * nothing to suggest the real cause. The Entries API is the only way to walk
 * into a dropped directory.
 */

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: (file: File) => void, failure: (error: unknown) => void) => void;
  createReader?: () => {
    readEntries: (
      success: (entries: FileSystemEntryLike[]) => void,
      failure: (error: unknown) => void,
    ) => void;
  };
}

/** Guard against a pathological drop (a symlink loop, or someone's entire home
 *  directory) turning into an unbounded walk. */
const MAX_FILES = 20_000;
const MAX_DEPTH = 12;

function entryToFile(entry: FileSystemEntryLike): Promise<File | null> {
  return new Promise((resolve) => {
    if (!entry.file) return resolve(null);
    entry.file(
      (file) => resolve(file),
      () => resolve(null), // unreadable; the uploader reports it per-file
    );
  });
}

/** readEntries hands back at most 100 entries per call, so it must be drained
 *  in a loop until it returns nothing. Missing this silently truncates any
 *  folder with more than 100 photos in it — which is most of them. */
function readAllEntries(entry: FileSystemEntryLike): Promise<FileSystemEntryLike[]> {
  return new Promise((resolve) => {
    const reader = entry.createReader?.();
    if (!reader) return resolve([]);

    const collected: FileSystemEntryLike[] = [];
    const readBatch = (): void => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) return resolve(collected);
          collected.push(...batch);
          readBatch();
        },
        () => resolve(collected),
      );
    };
    readBatch();
  });
}

async function walk(entry: FileSystemEntryLike, out: File[], depth: number): Promise<void> {
  if (out.length >= MAX_FILES || depth > MAX_DEPTH) return;

  if (entry.isFile) {
    const file = await entryToFile(entry);
    if (file) out.push(file);
    return;
  }

  if (entry.isDirectory) {
    const children = await readAllEntries(entry);
    for (const child of children) {
      if (out.length >= MAX_FILES) return;
      await walk(child, out, depth + 1);
    }
  }
}

/**
 * Must be called with the entries captured synchronously from the drop event —
 * a DataTransfer is emptied as soon as the handler returns, so anything read
 * after the first `await` comes back empty.
 */
export async function expandDroppedEntries(
  entries: (FileSystemEntryLike | null)[],
): Promise<File[]> {
  const files: File[] = [];
  for (const entry of entries) {
    if (entry) await walk(entry, files, 0);
  }
  return files;
}

/** Grabs the entries out of a drop event before the DataTransfer is neutered. */
export function captureEntries(dataTransfer: DataTransfer): (FileSystemEntryLike | null)[] {
  return Array.from(dataTransfer.items ?? []).map((item) => {
    const get = (item as unknown as { webkitGetAsEntry?: () => FileSystemEntryLike | null })
      .webkitGetAsEntry;
    return typeof get === 'function' ? get.call(item) : null;
  });
}
