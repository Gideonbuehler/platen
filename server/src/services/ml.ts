import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';

/**
 * Semantic search with CLIP, running in-process via transformers.js (ONNX
 * Runtime). Keeping it in the Node process is a deliberate trade: it costs some
 * throughput versus a dedicated Python service, but it removes a third
 * container from the Unraid stack and there is no RPC hop per image.
 *
 * Everything here is lazily imported. With ENABLE_ML=false — or on a machine
 * where the optional dependency failed to install — nothing is loaded and the
 * rest of the server is unaffected.
 */

const EMBEDDING_DIM = 512;

type VisionPipeline = {
  processor: any;
  model: any;
};
type TextPipeline = {
  tokenizer: any;
  model: any;
};

let vision: VisionPipeline | null = null;
let text: TextPipeline | null = null;
let transformers: any = null;
let mlUnavailableReason: string | null = null;

const ML_CACHE_DIR = '/data/ml-cache';

export type MlState = 'disabled' | 'loading' | 'ready' | 'error';

let state: MlState = 'disabled';
let stateMessage = '';

export function getMlStatus(): { state: MlState; message: string; model: string } {
  return { state, message: stateMessage, model: config.ML_MODEL };
}

/**
 * A half-written model file poisons the cache permanently.
 *
 * If the container is stopped while weights are downloading, transformers.js
 * leaves the partial file in place and every later load fails with an opaque
 * "Protobuf parsing failed" — search stays broken forever with no hint that the
 * fix is simply to download it again. Detecting that signature and clearing the
 * cache makes the next attempt self-healing.
 */
function isCorruptModelError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('Protobuf parsing failed') ||
    message.includes('Failed to load model') ||
    message.includes('invalid model') ||
    message.includes('Deserialize tensor') ||
    message.includes('unexpected end')
  );
}

async function purgeModelCache(): Promise<void> {
  // Only ever the configured model's own directory, never the whole cache.
  const target = join(ML_CACHE_DIR, config.ML_MODEL);
  await rm(target, { recursive: true, force: true }).catch(() => {});
}

async function loadTransformers(): Promise<any> {
  if (transformers) return transformers;
  if (mlUnavailableReason) throw new Error(mlUnavailableReason);

  try {
    transformers = await import('@huggingface/transformers');
    // Models are cached under the mounted data volume so a container rebuild
    // does not re-download ~250 MB of weights.
    transformers.env.cacheDir = '/data/ml-cache';
    transformers.env.allowLocalModels = true;
    return transformers;
  } catch (err) {
    mlUnavailableReason =
      '@huggingface/transformers is not installed. Semantic search is disabled. ' +
      `Original error: ${err instanceof Error ? err.message : String(err)}`;
    throw new Error(mlUnavailableReason);
  }
}

/**
 * Single gate for loading both halves of the model.
 *
 * Everything that needs CLIP goes through here, and concurrent callers share
 * one promise. That matters more than it looks: the embedding worker runs
 * several jobs at once, and without a shared gate each one starts its own load
 * against a cache directory that a first-run download is still writing into.
 * Each then sees a half-written file, calls it corrupt, and deletes the very
 * download in progress — a loop that never converges.
 */
let initPromise: Promise<void> | null = null;
let purgeAttempted = false;

async function loadBoth(): Promise<void> {
  const t = await loadTransformers();

  const [processor, visionModel, tokenizer, textModel] = await Promise.all([
    t.AutoProcessor.from_pretrained(config.ML_MODEL),
    t.CLIPVisionModelWithProjection.from_pretrained(config.ML_MODEL, { dtype: 'fp32' }),
    t.AutoTokenizer.from_pretrained(config.ML_MODEL),
    t.CLIPTextModelWithProjection.from_pretrained(config.ML_MODEL, { dtype: 'fp32' }),
  ]);

  vision = { processor, model: visionModel };
  text = { tokenizer, model: textModel };
}

async function ensureModels(): Promise<void> {
  if (state === 'ready' && vision && text) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    state = 'loading';
    stateMessage = 'Downloading and loading the search model...';

    try {
      await loadBoth();
    } catch (err) {
      // Retry exactly once, and only after clearing a cache we believe is
      // corrupt. Bounded by `purgeAttempted` so a genuinely broken environment
      // cannot turn into an endless download loop.
      if (isCorruptModelError(err) && !purgeAttempted) {
        purgeAttempted = true;
        await purgeModelCache();
        vision = null;
        text = null;
        await loadBoth();
      } else {
        throw err;
      }
    }

    state = 'ready';
    stateMessage = '';
    // A later corruption (a bad disk, a truncated restore) deserves its own
    // chance to self-heal, so the guard is released once a load succeeds.
    purgeAttempted = false;
  })()
    .catch((err) => {
      state = 'error';
      stateMessage = isCorruptModelError(err)
        ? 'The cached model file could not be read. It will be downloaded again on the next attempt.'
        : err instanceof Error
          ? err.message
          : String(err);
      vision = null;
      text = null;
      throw err;
    })
    .finally(() => {
      initPromise = null;
    });

  return initPromise;
}

/**
 * L2-normalises in place. Because every stored vector is unit length, cosine
 * distance in pgvector reduces to a dot product, which is what makes the HNSW
 * index fast.
 */
function normalise(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i]! * vec[i]!;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
  return vec;
}

function assertDim(vec: Float32Array): Float32Array {
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(
      `Model ${config.ML_MODEL} produced ${vec.length}-dim embeddings, but the ` +
        `database column is vector(${EMBEDDING_DIM}). Use a ViT-B/32 CLIP model, ` +
        `or change the column type and re-index.`,
    );
  }
  return vec;
}

/** Embeds an image file. Feed it the preview WebP, not the 50 MP original. */
export async function embedImage(imagePath: string): Promise<Float32Array> {
  await ensureModels();
  const t = await loadTransformers();
  const { processor, model } = vision!;

  const image = await t.RawImage.read(imagePath);
  const inputs = await processor(image);
  const { image_embeds } = await model(inputs);

  return assertDim(normalise(Float32Array.from(image_embeds.data as ArrayLike<number>)));
}

/** Embeds a search phrase into the same space as the image embeddings. */
export async function embedText(query: string): Promise<Float32Array> {
  await ensureModels();
  const { tokenizer, model } = text!;

  const inputs = tokenizer([query], { padding: true, truncation: true });
  const { text_embeds } = await model(inputs);

  return assertDim(normalise(Float32Array.from(text_embeds.data as ArrayLike<number>)));
}

/**
 * A generic "any photo" reference point in the same embedding space.
 *
 * CLIP similarities are not comparable across queries or across images. Some
 * photos sit closer to *all* text than others, and different phrasings sit at
 * different absolute levels — so a fixed cutoff on raw similarity either lets
 * the whole library through or none of it. Searching "airplane" in a library
 * with no aeroplanes still scores every photo around 0.20, which reads as five
 * confident matches.
 *
 * Scoring each hit against this baseline instead cancels both biases: what
 * matters is how much *better* the query describes a photo than a generic
 * phrase does. A photo nothing like the query lands near zero and is dropped.
 */
const BASELINE_PROMPTS = [
  'a photo',
  'a picture',
  'an image',
  'a snapshot',
];

let baselinePromise: Promise<Float32Array> | null = null;

export async function getBaselineEmbedding(): Promise<Float32Array> {
  if (!baselinePromise) {
    baselinePromise = (async () => {
      await ensureModels();
      const { tokenizer, model } = text!;

      const inputs = tokenizer(BASELINE_PROMPTS, { padding: true, truncation: true });
      const { text_embeds } = await model(inputs);

      const flat = Float32Array.from(text_embeds.data as ArrayLike<number>);
      const count = BASELINE_PROMPTS.length;
      const mean = new Float32Array(EMBEDDING_DIM);

      for (let p = 0; p < count; p++) {
        for (let d = 0; d < EMBEDDING_DIM; d++) {
          mean[d] = mean[d]! + flat[p * EMBEDDING_DIM + d]!;
        }
      }
      for (let d = 0; d < EMBEDDING_DIM; d++) mean[d] = mean[d]! / count;

      return normalise(mean);
    })().catch((err) => {
      baselinePromise = null;
      throw err;
    });
  }
  return baselinePromise;
}

/** pgvector's text input format. postgres.js sends it as a string literal. */
export function toVectorLiteral(vec: Float32Array): string {
  return `[${Array.from(vec).join(',')}]`;
}

export function isMlEnabled(): boolean {
  return config.ENABLE_ML;
}

/**
 * Warms the vision model at boot so the first upload is not also the request
 * that pays a 20-second model load. Failure is logged, never fatal.
 */
export async function warmUp(log: (msg: string) => void): Promise<void> {
  if (!config.ENABLE_ML) {
    state = 'disabled';
    stateMessage = 'Semantic search is turned off (ENABLE_ML=false).';
    log('Semantic search is disabled (ENABLE_ML=false).');
    return;
  }
  try {
    log(`Loading CLIP model ${config.ML_MODEL} (first run downloads ~250 MB)...`);

    // Both halves load together. Warming only the vision model is what let a
    // corrupt text model go unnoticed until someone actually searched.
    await ensureModels();

    log('CLIP model ready. Semantic search is available.');
  } catch (err) {
    log(
      `Semantic search unavailable: ${err instanceof Error ? err.message : String(err)}. ` +
        'Uploads and browsing are unaffected.',
    );
  }
}
