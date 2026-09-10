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

let visionPromise: Promise<VisionPipeline> | null = null;
let textPromise: Promise<TextPipeline> | null = null;
let transformers: any = null;
let mlUnavailableReason: string | null = null;

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

async function getVision(): Promise<VisionPipeline> {
  if (!visionPromise) {
    visionPromise = (async () => {
      const t = await loadTransformers();
      const [processor, model] = await Promise.all([
        t.AutoProcessor.from_pretrained(config.ML_MODEL),
        t.CLIPVisionModelWithProjection.from_pretrained(config.ML_MODEL, { dtype: 'fp32' }),
      ]);
      return { processor, model };
    })().catch((err) => {
      visionPromise = null; // let a later job retry after, say, a network blip
      throw err;
    });
  }
  return visionPromise;
}

async function getText(): Promise<TextPipeline> {
  if (!textPromise) {
    textPromise = (async () => {
      const t = await loadTransformers();
      const [tokenizer, model] = await Promise.all([
        t.AutoTokenizer.from_pretrained(config.ML_MODEL),
        t.CLIPTextModelWithProjection.from_pretrained(config.ML_MODEL, { dtype: 'fp32' }),
      ]);
      return { tokenizer, model };
    })().catch((err) => {
      textPromise = null;
      throw err;
    });
  }
  return textPromise;
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
  const t = await loadTransformers();
  const { processor, model } = await getVision();

  const image = await t.RawImage.read(imagePath);
  const inputs = await processor(image);
  const { image_embeds } = await model(inputs);

  return assertDim(normalise(Float32Array.from(image_embeds.data as ArrayLike<number>)));
}

/** Embeds a search phrase into the same space as the image embeddings. */
export async function embedText(query: string): Promise<Float32Array> {
  const { tokenizer, model } = await getText();

  const inputs = tokenizer([query], { padding: true, truncation: true });
  const { text_embeds } = await model(inputs);

  return assertDim(normalise(Float32Array.from(text_embeds.data as ArrayLike<number>)));
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
    log('Semantic search is disabled (ENABLE_ML=false).');
    return;
  }
  try {
    log(`Loading CLIP model ${config.ML_MODEL} (first run downloads ~250 MB)...`);
    await getVision();
    log('CLIP model ready. Semantic search is available.');
  } catch (err) {
    log(
      `Semantic search unavailable: ${err instanceof Error ? err.message : String(err)}. ` +
        'Uploads and browsing are unaffected.',
    );
  }
}
