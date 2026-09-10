import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SearchHit } from '@aperture/shared';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { badRequest } from '../lib/errors.js';
import { assetColumnsWithExif, toAssetDto, type AssetRow } from '../lib/mappers.js';
import { auth, requireAuth } from '../middleware/auth.js';
import { embedText, toVectorLiteral } from '../services/ml.js';

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
        threshold: z.number().min(0).max(1).default(0.18),
        limit: z.number().int().min(1).max(200).default(80),
      })
      .parse(request.body);

    if (!config.ENABLE_ML) {
      throw badRequest('Semantic search is disabled on this server (ENABLE_ML=false).');
    }

    const vector = toVectorLiteral(await embedText(body.query));
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

    return rows.map(
      (row): SearchHit => ({ asset: toAssetDto(row), score: 1 - Number(row.distance) }),
    );
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
    return {
      enabled: config.ENABLE_ML,
      model: config.ML_MODEL,
      total: row?.total ?? 0,
      indexed: row?.indexed ?? 0,
    };
  });
}
