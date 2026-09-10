import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { config } from '../config.js';

/**
 * Face detection and recognition.
 *
 * Two InsightFace models run through onnxruntime, which is already present as
 * a dependency of the CLIP stack — so this adds capability without adding a
 * container or a second runtime:
 *
 *   SCRFD 10G   detection: boxes plus five landmarks, ~17 MB
 *   ArcFace r50 recognition: a 512-d identity vector, ~174 MB
 *
 * Identity vectors are only comparable when faces are presented to the
 * recogniser the same way every time, which is what the alignment step below
 * is for. Skipping it and feeding in a plain crop is the usual reason
 * home-grown face grouping produces clusters that look arbitrary.
 *
 * Note on licensing: the InsightFace models are published for non-commercial
 * research use. Fine for a personal library; check before shipping a product.
 */

const MODELS = {
  detection: {
    url: 'https://huggingface.co/immich-app/buffalo_l/resolve/main/detection/model.onnx',
    file: 'detection.onnx',
    minBytes: 16_000_000,
  },
  recognition: {
    url: 'https://huggingface.co/immich-app/buffalo_l/resolve/main/recognition/model.onnx',
    file: 'recognition.onnx',
    minBytes: 170_000_000,
  },
} as const;

const MODEL_DIR = '/data/ml-cache/faces';

/** Detector input is a fixed 640x640 letterbox. */
const DET_SIZE = 640;
const NMS_IOU = 0.4;

/** ArcFace expects a 112x112 crop with the face at these five positions. */
const ARCFACE_REFERENCE: [number, number][] = [
  [38.2946, 51.6963], // left eye
  [73.5318, 51.5014], // right eye
  [56.0252, 71.7366], // nose tip
  [41.5493, 92.3655], // left mouth corner
  [70.7299, 92.2041], // right mouth corner
];

export interface DetectedFace {
  /** Pixel box on the image that was scanned. */
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  /** Five landmarks in pixels: eyes, nose, mouth corners. */
  landmarks: [number, number][];
  /** L2-normalised 512-d identity vector. */
  embedding: Float32Array;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type FaceState = 'disabled' | 'loading' | 'ready' | 'error';

let state: FaceState = 'disabled';
let stateMessage = '';
let ort: any = null;
let detector: any = null;
let recognizer: any = null;
let initPromise: Promise<void> | null = null;

export function getFaceStatus(): { state: FaceState; message: string } {
  return { state, message: stateMessage };
}

// ---------------------------------------------------------------------------
// Model download
// ---------------------------------------------------------------------------

/**
 * Downloads to a temporary name and renames on completion.
 *
 * An interrupted download must never be mistaken for a usable model: a partial
 * file left at the final path loads as "Protobuf parsing failed" and stays
 * broken until someone deletes it by hand. Renaming only after the bytes are
 * all present makes a half-finished download simply not exist.
 */
async function ensureModel(spec: { url: string; file: string; minBytes: number }): Promise<string> {
  const finalPath = join(MODEL_DIR, spec.file);

  const existing = await stat(finalPath).catch(() => null);
  if (existing && existing.size >= spec.minBytes) return finalPath;
  if (existing) await rm(finalPath, { force: true }); // truncated leftover

  await mkdir(dirname(finalPath), { recursive: true });
  const partPath = `${finalPath}.part`;
  await rm(partPath, { force: true });

  const response = await fetch(spec.url);
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${spec.file}: HTTP ${response.status}`);
  }

  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partPath));

  const written = await stat(partPath);
  if (written.size < spec.minBytes) {
    await rm(partPath, { force: true });
    throw new Error(
      `${spec.file} downloaded only ${written.size} bytes, expected at least ${spec.minBytes}.`,
    );
  }

  await rename(partPath, finalPath);
  return finalPath;
}

async function loadModels(): Promise<void> {
  ort = await import('onnxruntime-node');

  const [detPath, recPath] = await Promise.all([
    ensureModel(MODELS.detection),
    ensureModel(MODELS.recognition),
  ]);

  const options = {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all' as const,
    // One thread per session; the job worker already governs concurrency, and
    // letting ORT spawn a pool per session starves everything else on a NAS.
    intraOpNumThreads: 1,
  };

  [detector, recognizer] = await Promise.all([
    ort.InferenceSession.create(detPath, options),
    ort.InferenceSession.create(recPath, options),
  ]);
}

export async function ensureFaceModels(): Promise<void> {
  if (state === 'ready' && detector && recognizer) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    state = 'loading';
    stateMessage = 'Downloading and loading face models (~190 MB)...';
    await loadModels();
    state = 'ready';
    stateMessage = '';
  })()
    .catch((err) => {
      state = 'error';
      stateMessage = err instanceof Error ? err.message : String(err);
      detector = null;
      recognizer = null;
      throw err;
    })
    .finally(() => {
      initPromise = null;
    });

  return initPromise;
}

export async function warmUpFaces(log: (msg: string) => void): Promise<void> {
  if (!config.ENABLE_FACES) {
    state = 'disabled';
    stateMessage = 'Face grouping is turned off (ENABLE_FACES=false).';
    return;
  }
  try {
    log('Loading face models (first run downloads ~190 MB)...');
    await ensureFaceModels();
    log('Face models ready.');
  } catch (err) {
    log(`Face grouping unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
}

function bilinearSample(
  image: RawImage,
  x: number,
  y: number,
  channel: number,
): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;

  const clampX = (v: number) => Math.min(Math.max(v, 0), image.width - 1);
  const clampY = (v: number) => Math.min(Math.max(v, 0), image.height - 1);

  const fx = x - x0;
  const fy = y - y0;

  const at = (px: number, py: number) =>
    image.data[(clampY(py) * image.width + clampX(px)) * 3 + channel]!;

  const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * Least-squares 2D similarity transform (scale, rotation, translation) mapping
 * `from` onto `to`.
 *
 * Reflection is deliberately excluded — a mirrored face is a different face,
 * and allowing it would let the fit "succeed" on a bad landmark set. Solved in
 * closed form rather than via SVD: for a similarity transform in two
 * dimensions the normal equations collapse to two dot products.
 */
function similarityTransform(
  from: [number, number][],
  to: [number, number][],
): { a: number; b: number; tx: number; ty: number } {
  const n = from.length;
  let mfx = 0;
  let mfy = 0;
  let mtx = 0;
  let mty = 0;

  for (let i = 0; i < n; i++) {
    mfx += from[i]![0];
    mfy += from[i]![1];
    mtx += to[i]![0];
    mty += to[i]![1];
  }
  mfx /= n;
  mfy /= n;
  mtx /= n;
  mty /= n;

  let num1 = 0; // sum(x*u + y*v)
  let num2 = 0; // sum(x*v - y*u)
  let den = 0; // sum(x^2 + y^2)

  for (let i = 0; i < n; i++) {
    const x = from[i]![0] - mfx;
    const y = from[i]![1] - mfy;
    const u = to[i]![0] - mtx;
    const v = to[i]![1] - mty;

    num1 += x * u + y * v;
    num2 += x * v - y * u;
    den += x * x + y * y;
  }

  if (den === 0) return { a: 1, b: 0, tx: 0, ty: 0 };

  const a = num1 / den;
  const b = num2 / den;

  return {
    a,
    b,
    tx: mtx - (a * mfx - b * mfy),
    ty: mty - (b * mfx + a * mfy),
  };
}

/**
 * Warps a face onto the canonical 112x112 ArcFace layout.
 *
 * The transform is inverted and applied per output pixel so every destination
 * pixel is filled exactly once — a forward warp would leave holes wherever the
 * source is being magnified.
 */
function alignFace(image: RawImage, landmarks: [number, number][]): Float32Array {
  const { a, b, tx, ty } = similarityTransform(landmarks, ARCFACE_REFERENCE);
  const det = a * a + b * b;
  if (det === 0) throw new Error('Degenerate face landmarks');

  // NCHW float tensor, normalised the way ArcFace was trained.
  const out = new Float32Array(3 * 112 * 112);
  const plane = 112 * 112;

  for (let oy = 0; oy < 112; oy++) {
    for (let ox = 0; ox < 112; ox++) {
      const du = ox - tx;
      const dv = oy - ty;
      const sx = (a * du + b * dv) / det;
      const sy = (-b * du + a * dv) / det;

      const index = oy * 112 + ox;
      for (let c = 0; c < 3; c++) {
        out[c * plane + index] = (bilinearSample(image, sx, sy, c) - 127.5) / 127.5;
      }
    }
  }

  return out;
}

function iou(a: DetectionBox, b: DetectionBox): number {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);

  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (overlap === 0) return 0;

  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  return overlap / (areaA + areaB - overlap);
}

interface DetectionBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
  landmarks: [number, number][];
}

function nonMaxSuppression(boxes: DetectionBox[], threshold: number): DetectionBox[] {
  const sorted = [...boxes].sort((p, q) => q.score - p.score);
  const kept: DetectionBox[] = [];

  for (const candidate of sorted) {
    if (kept.every((k) => iou(k, candidate) < threshold)) kept.push(candidate);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

interface OutputGroup {
  scores: Float32Array;
  boxes: Float32Array;
  kps: Float32Array;
  stride: number;
}

/**
 * Sorts the detector's nine output tensors into per-stride groups.
 *
 * SCRFD emits three tensors per feature level and the ONNX output names are
 * opaque numbers, so they are classified by shape instead: trailing dimension
 * 1 is a score, 4 a box, 10 the five landmarks. Row count identifies the
 * stride, since a coarser level has proportionally fewer anchors.
 */
function groupOutputs(results: Record<string, any>): OutputGroup[] {
  const scores: { rows: number; data: Float32Array }[] = [];
  const boxes: { rows: number; data: Float32Array }[] = [];
  const kps: { rows: number; data: Float32Array }[] = [];

  for (const tensor of Object.values(results)) {
    const dims: number[] = tensor.dims;
    const last = dims[dims.length - 1]!;
    const rows = tensor.data.length / last;
    const entry = { rows, data: tensor.data as Float32Array };

    if (last === 1) scores.push(entry);
    else if (last === 4) boxes.push(entry);
    else if (last === 10) kps.push(entry);
  }

  const byRowsDesc = (a: { rows: number }, b: { rows: number }) => b.rows - a.rows;
  scores.sort(byRowsDesc);
  boxes.sort(byRowsDesc);
  kps.sort(byRowsDesc);

  // Most anchors is the finest stride.
  const strides = [8, 16, 32];
  return strides.map((stride, i) => ({
    stride,
    scores: scores[i]!.data,
    boxes: boxes[i]!.data,
    kps: kps[i]!.data,
  }));
}

async function detect(image: RawImage): Promise<DetectionBox[]> {
  // Letterbox into the fixed detector input, preserving aspect ratio so faces
  // are not stretched into shapes the model never saw in training.
  const scale = Math.min(DET_SIZE / image.width, DET_SIZE / image.height);
  const scaledW = Math.round(image.width * scale);
  const scaledH = Math.round(image.height * scale);

  const resized = await sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 3 },
  })
    .resize(scaledW, scaledH, { fit: 'fill' })
    .extend({
      top: 0,
      left: 0,
      bottom: DET_SIZE - scaledH,
      right: DET_SIZE - scaledW,
      background: { r: 0, g: 0, b: 0 },
    })
    .raw()
    .toBuffer();

  const input = new Float32Array(3 * DET_SIZE * DET_SIZE);
  const plane = DET_SIZE * DET_SIZE;
  for (let i = 0; i < plane; i++) {
    input[i] = (resized[i * 3]! - 127.5) / 128;
    input[plane + i] = (resized[i * 3 + 1]! - 127.5) / 128;
    input[2 * plane + i] = (resized[i * 3 + 2]! - 127.5) / 128;
  }

  const tensor = new ort.Tensor('float32', input, [1, 3, DET_SIZE, DET_SIZE]);
  const results = await detector.run({ [detector.inputNames[0]]: tensor });

  const groups = groupOutputs(results);
  const candidates: DetectionBox[] = [];

  for (const group of groups) {
    const gridSize = DET_SIZE / group.stride;
    const anchorsPerCell = group.scores.length / (gridSize * gridSize);

    for (let i = 0; i < group.scores.length; i++) {
      const score = group.scores[i]!;
      if (score < config.FACE_MIN_SCORE) continue;

      // Anchors are laid out row-major, with `anchorsPerCell` repeats per cell.
      const cell = Math.floor(i / anchorsPerCell);
      const cx = (cell % gridSize) * group.stride;
      const cy = Math.floor(cell / gridSize) * group.stride;

      // The regression head predicts distances from the anchor centre to each
      // edge, in stride units.
      const b = i * 4;
      const x1 = cx - group.boxes[b]! * group.stride;
      const y1 = cy - group.boxes[b + 1]! * group.stride;
      const x2 = cx + group.boxes[b + 2]! * group.stride;
      const y2 = cy + group.boxes[b + 3]! * group.stride;

      const k = i * 10;
      const landmarks: [number, number][] = [];
      for (let p = 0; p < 5; p++) {
        landmarks.push([
          cx + group.kps[k + p * 2]! * group.stride,
          cy + group.kps[k + p * 2 + 1]! * group.stride,
        ]);
      }

      // Undo the letterbox so coordinates refer to the original image.
      candidates.push({
        x1: x1 / scale,
        y1: y1 / scale,
        x2: x2 / scale,
        y2: y2 / scale,
        score,
        landmarks: landmarks.map(([x, y]) => [x / scale, y / scale] as [number, number]),
      });
    }
  }

  return nonMaxSuppression(candidates, NMS_IOU);
}

// ---------------------------------------------------------------------------
// Public pipeline
// ---------------------------------------------------------------------------

/**
 * Finds every face in an image and returns an identity vector for each.
 *
 * Run this against the preview rather than the original: the detector works at
 * 640px regardless, and decoding a 60 MP RAW-derived JPEG for it would be pure
 * waste.
 */
export async function detectFaces(imagePath: string): Promise<DetectedFace[]> {
  await ensureFaceModels();

  const { data, info } = await sharp(imagePath)
    .rotate()
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });

  const image: RawImage = { data, width: info.width, height: info.height };
  const detections = await detect(image);

  const faces: DetectedFace[] = [];

  for (const detection of detections) {
    const width = detection.x2 - detection.x1;
    const height = detection.y2 - detection.y1;

    // Tiny faces are usually strangers in the background, and they embed
    // poorly enough to pollute clusters rather than fill them.
    if (Math.min(width, height) < config.FACE_MIN_SIZE_PX) continue;

    const aligned = alignFace(image, detection.landmarks);
    const tensor = new ort.Tensor('float32', aligned, [1, 3, 112, 112]);
    const output = await recognizer.run({ [recognizer.inputNames[0]]: tensor });

    // The recogniser has a single output whose name varies by model export, so
    // it is taken positionally rather than by key.
    const embeddingTensor = Object.values(output)[0] as { data: ArrayLike<number> };
    const raw = Float32Array.from(embeddingTensor.data);

    // Unit length, so cosine similarity is a plain dot product and pgvector's
    // cosine index behaves predictably.
    let sum = 0;
    for (let i = 0; i < raw.length; i++) sum += raw[i]! * raw[i]!;
    const norm = Math.sqrt(sum) || 1;
    for (let i = 0; i < raw.length; i++) raw[i] = raw[i]! / norm;

    faces.push({
      x: detection.x1,
      y: detection.y1,
      width,
      height,
      score: detection.score,
      landmarks: detection.landmarks,
      embedding: raw,
    });
  }

  return faces;
}

/**
 * Writes a square crop of a face for the People UI.
 *
 * Padded out by 40% because a tight detector box cuts off hair and chin, which
 * makes the avatars hard to tell apart at thumbnail size.
 */
export async function writeFaceCrop(
  imagePath: string,
  face: DetectedFace,
  outputPath: string,
): Promise<void> {
  const meta = await sharp(imagePath).rotate().metadata();
  const imageWidth = meta.width ?? 0;
  const imageHeight = meta.height ?? 0;
  if (!imageWidth || !imageHeight) throw new Error('Could not read image dimensions for face crop');

  const centreX = face.x + face.width / 2;
  const centreY = face.y + face.height / 2;
  const size = Math.max(face.width, face.height) * 1.4;

  const left = Math.round(Math.max(0, centreX - size / 2));
  const top = Math.round(Math.max(0, centreY - size / 2));
  const cropWidth = Math.round(Math.min(size, imageWidth - left));
  const cropHeight = Math.round(Math.min(size, imageHeight - top));

  await mkdir(dirname(outputPath), { recursive: true });
  await sharp(imagePath)
    .rotate()
    .extract({ left, top, width: Math.max(1, cropWidth), height: Math.max(1, cropHeight) })
    .resize(160, 160, { fit: 'cover' })
    .webp({ quality: 82 })
    .toFile(outputPath);
}
