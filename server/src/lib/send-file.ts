import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { FastifyReply } from 'fastify';
import { notFound } from './errors.js';

/** Derivatives and originals never change in place, so they can be cached hard. */
export const IMMUTABLE_PRIVATE = 'private, max-age=31536000, immutable';

/**
 * Parses a single `bytes=` range against a file of `size` bytes.
 *
 * Returns null when the header is absent or in a form we do not serve (several
 * ranges, another unit), which means "send the whole file", and 'unsatisfiable'
 * for a range that lies outside the file.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, startRaw = '', endRaw = ''] = match;
  // "bytes=-" names no bytes at all; ignoring it is what RFC 9110 asks.
  if (startRaw === '' && endRaw === '') return null;

  let start: number;
  let end: number;
  if (startRaw === '') {
    // Suffix range: "bytes=-500" means the last 500 bytes.
    start = Math.max(0, size - Number(endRaw));
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw ? Math.min(Number(endRaw), size - 1) : size - 1;
  }

  if (start > end || start >= size) return 'unsatisfiable';
  return { start, end };
}

/** Sends a file with range support — required for seekable <video>. */
export async function sendFile(
  reply: FastifyReply,
  absolutePath: string,
  contentType: string,
  options: { rangeHeader?: string; downloadName?: string; cacheControl: string },
): Promise<FastifyReply> {
  let info;
  try {
    info = await stat(absolutePath);
  } catch {
    throw notFound('That file is not available yet.');
  }

  reply.header('Content-Type', contentType);
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Cache-Control', options.cacheControl);
  reply.header('ETag', `"${info.size}-${info.mtimeMs}"`);

  if (options.downloadName) {
    const safe = basename(options.downloadName).replace(/["\\\r\n]/g, '');
    reply.header('Content-Disposition', `attachment; filename="${safe}"`);
  }

  const range = parseRange(options.rangeHeader, info.size);
  if (range === 'unsatisfiable') {
    reply.header('Content-Range', `bytes */${info.size}`);
    return reply.code(416).send();
  }
  if (range) {
    reply.header('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`);
    reply.header('Content-Length', range.end - range.start + 1);
    return reply.code(206).send(createReadStream(absolutePath, range));
  }

  reply.header('Content-Length', info.size);
  return reply.send(createReadStream(absolutePath));
}
