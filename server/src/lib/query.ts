import { z } from 'zod';

/**
 * A boolean query-string parameter.
 *
 * Not `z.coerce.boolean()`: that is JavaScript truthiness, so every non-empty
 * string — "false" and "0" included — comes out true, and `?trashed=false`
 * returned the trash.
 */
export const queryBoolean = z
  .enum(['true', 'false', '1', '0'], { message: 'Expected true or false' })
  .transform((value) => value === 'true' || value === '1');
