import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SearchHit } from '@aperture/shared';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { assetColumnsWithExif, toAssetDto, type AssetRow } from '../lib/mappers.js';
import { auth, requireAuth } from '../middleware/auth.js';
import { embedText, getMlStatus, toVectorLiteral } from '../services/ml.js';

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /**
   * Natural-language search over CLIP embeddings.
   *
   * `<=>` is pgvector's cosine *distance*, so similarity is 1 - distance. We
   * filter on distance rather than similarity because only the former can use
   * the HNSW index.
   */
  app.post('/', async (request) => {
    const { userId } = auth(request);
    const body = z
      .object({
        query: z.string().min(1).max(300),
        threshold: z.number().min(0).max(1).default(0.15),
        limit: z.number().int().min(1).max(200).default(80),
      })
      .parse(request.body);

    if (!config.ENABLE_ML) {
      throw badRequest('Semantic search is disabled on this server (ENABLE_ML=false).');
    }

    const status = getMlStatus();
    if (status.state === 'loading') {
      throw new HttpError(
        503,
        'model_loading',
        'The search model is still loading. This takes a few minutes the first time.',
      );
    }

    let vector: string;
    try {
      vector = toVectorLiteral(await embedText(body.query));
    } catch (err) {
      // A model that cannot load is not an unexpected server fault; say so
      // plainly rather than returning an opaque 500.
      throw new HttpError(
        503,
        'model_unavailable',
        `Search is temporarily unavailable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const maxDistance = 1 - body.threshold;

    const rows = await sql<(AssetRow & { distance: number })[]>`
      SELECT ${sql.unsafe(assetColumnsWithExif())}, (em.embedding <=> ${vector}::vector) AS distance
      FROM asset_embeddings em
      JOIN assets a ON a.id = em.asset_id
      LEFT JOIN asset_exif e ON e.asset_id = a.id
      WHERE a.owner_id = ${userId}
        AND a.deleted_at IS NULL
        AND (em.embedding <=> ${vector}::vector) < ${maxDistance}
      ORDER BY em.embedding <=> ${vector}::vector
      LIMIT ${body.limit}
    `;

    const hits = rows.map(
      (row): SearchHit => ({ asset: toAssetDto(row), score: 1 - Number(row.distance) }),
    );
    if (hits.length === 0) return hits;

    /**
     * Cut relative to the best match, not on an absolute score.
     *
     * CLIP similarities live in a narrow band — an unrelated photo scores about
     * 0.19 and a good match about 0.30 — so any fixed threshold either admits
     * the whole library or rejects all of it, and the right value shifts with
     * the phrasing of the query. Anchoring the cutoff to the top hit behaves
     * consistently whether the library holds three photos or fifty thousand.
     *
     * When everything scores about the same, nothing is meaningfully more
     * relevant than anything else, and the whole set is returned rather than an
     * arbitrary slice of it.
     */
    const RELATIVE_WINDOW = 0.05;
    const best = hits[0]!.score;
    const floor = Math.max(body.threshold, best - RELATIVE_WINDOW);

    return hits.filter((hit) => hit.score >= floor);
  });

  /**
   * Plain metadata search: filename, camera, place. Always available, and it is
   * what the UI falls back to when ML is off or the model is still loading.
   */
  app.get('/metadata', async (request) => {
    const { userId } = auth(request);
    const { q, limit } = z
      .object({ q: z.string().min(1).max(200), limit: z.coerce.number().int().min(1).max(200).default(80) })
      .parse(request.query);

    const pattern = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;

    const rows = await sql<AssetRow[]>`
      SELECT ${sql.unsafe(assetColumnsWithExif())}
      FROM assets a
      LEFT JOIN asset_exif e ON e.asset_id = a.id
      WHERE a.owner_id = ${userId}
        AND a.deleted_at IS NULL
        AND (
          a.original_filename ILIKE ${pattern}
          OR e.make  ILIKE ${pattern}
          OR e.model ILIKE ${pattern}
          OR e.city  ILIKE ${pattern}
          OR e.country ILIKE ${pattern}
        )
      ORDER BY a.taken_at DESC
      LIMIT ${limit}
    `;
    return rows.map(toAssetDto);
  });

  /** Progress indicator for the UI: how much of the library is indexed. */
  app.get('/status', async (request) => {
    const { userId } = auth(request);
    const [row] = await sql<{ total: number; indexed: number }[]>`
      SELECT
        COUNT(*)::int AS total,
        COUNT(em.asset_id)::int AS indexed
      FROM assets a
      LEFT JOIN asset_embeddings em ON em.asset_id = a.id
      WHERE a.owner_id = ${userId} AND a.deleted_at IS NULL
    `;
    const status = getMlStatus();
    return {
      enabled: config.ENABLE_ML,
      model: status.model,
      state: status.state,
      message: status.message,
      total: row?.total ?? 0,
      indexed: row?.indexed ?? 0,
      /** Assets still waiting on an embedding job. */
      pending: Math.max(0, (row?.total ?? 0) - (row?.indexed ?? 0)),
    };
  });
}
