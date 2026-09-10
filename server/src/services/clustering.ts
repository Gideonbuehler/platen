import { config } from '../config.js';
import { sql } from '../db/index.js';

/**
 * Incremental face clustering.
 *
 * Each new face is compared against faces already assigned to a person and
 * joins the nearest one that is close enough; otherwise it starts a new
 * person. This is deliberately online rather than a periodic global re-cluster:
 *
 *  - it runs as part of the normal job queue, so a library that grows by ten
 *    photos a day never needs a re-clustering pass at all;
 *  - names survive. A global re-cluster reshuffles group membership, and a
 *    person the user has named must not silently absorb someone else or split
 *    in two because an unrelated photo was added.
 *
 * The cost is order-dependence — the same faces arriving in a different order
 * can produce slightly different groups — which is why the UI offers merge.
 */

export interface ClusterResult {
  personId: string;
  created: boolean;
}

/**
 * Finds the person for a face, creating one if nothing matches.
 *
 * Confirmed faces are weighted ahead of unconfirmed ones: once someone has
 * said "this is Anna", that face is a far better anchor for the identity than
 * anything the clusterer guessed, so matching against it is preferred even if
 * an unconfirmed face happens to sit marginally closer.
 */
export async function assignFaceToPerson(
  faceId: string,
  ownerId: string,
  embedding: string,
): Promise<ClusterResult> {
  const maxDistance = 1 - config.FACE_MATCH_THRESHOLD;

  const matches = await sql<{ person_id: string; distance: number; is_confirmed: boolean }[]>`
    SELECT f.person_id,
           (f.embedding <=> ${embedding}::vector) AS distance,
           f.is_confirmed
    FROM faces f
    JOIN assets a ON a.id = f.asset_id
    WHERE a.owner_id = ${ownerId}
      AND a.deleted_at IS NULL
      AND f.person_id IS NOT NULL
      AND f.id <> ${faceId}
      AND f.embedding IS NOT NULL
      AND (f.embedding <=> ${embedding}::vector) < ${maxDistance}
    ORDER BY f.is_confirmed DESC, f.embedding <=> ${embedding}::vector
    LIMIT 1
  `;

  const match = matches[0];
  if (match) {
    await sql`UPDATE faces SET person_id = ${match.person_id} WHERE id = ${faceId}`;
    await sql`UPDATE people SET updated_at = now() WHERE id = ${match.person_id}`;
    return { personId: match.person_id, created: false };
  }

  const [person] = await sql<{ id: string }[]>`
    INSERT INTO people (owner_id, cover_face_id)
    VALUES (${ownerId}, ${faceId})
    RETURNING id
  `;
  if (!person) throw new Error('Could not create a person record');

  await sql`UPDATE faces SET person_id = ${person.id} WHERE id = ${faceId}`;
  return { personId: person.id, created: true };
}

/**
 * Removes people who no longer have any faces.
 *
 * Deleting a photo can empty a group, and an unnamed person with nothing in it
 * is pure noise. Named people are kept regardless — the user asserted that
 * person exists, and the name should survive re-scanning their photos.
 */
export async function pruneEmptyPeople(ownerId: string): Promise<number> {
  const removed = await sql`
    DELETE FROM people p
    WHERE p.owner_id = ${ownerId}
      AND p.name IS NULL
      AND NOT EXISTS (SELECT 1 FROM faces f WHERE f.person_id = p.id)
    RETURNING p.id
  `;
  return removed.length;
}

/** Keeps each person's avatar pointing at a face that still exists. */
export async function refreshCoverFaces(ownerId: string): Promise<void> {
  await sql`
    UPDATE people p
    SET cover_face_id = (
      -- Prefer a confirmed face, then the most confidently detected one.
      SELECT f.id FROM faces f
      WHERE f.person_id = p.id AND f.thumb_path IS NOT NULL
      ORDER BY f.is_confirmed DESC, f.score DESC
      LIMIT 1
    )
    WHERE p.owner_id = ${ownerId}
      AND (
        p.cover_face_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM faces f WHERE f.id = p.cover_face_id)
      )
  `;
}

/**
 * Merges one person into another, keeping the target's name.
 *
 * Every moved face is marked confirmed: the user has just asserted these are
 * the same individual, and that judgement must outrank anything the clusterer
 * later infers, or the two groups would drift apart again.
 */
export async function mergePeople(
  ownerId: string,
  targetId: string,
  sourceIds: string[],
): Promise<number> {
  return sql.begin(async (tx) => {
    const owned = await tx<{ id: string }[]>`
      SELECT id FROM people
      WHERE owner_id = ${ownerId} AND id = ANY(${[targetId, ...sourceIds]}::uuid[])
    `;
    if (owned.length !== sourceIds.length + 1) {
      throw new Error('One or more people do not belong to this account');
    }

    const moved = await tx`
      UPDATE faces SET person_id = ${targetId}, is_confirmed = true
      WHERE person_id = ANY(${sourceIds}::uuid[])
      RETURNING id
    `;

    await tx`DELETE FROM people WHERE id = ANY(${sourceIds}::uuid[])`;
    await tx`UPDATE people SET updated_at = now() WHERE id = ${targetId}`;

    return moved.length;
  });
}
