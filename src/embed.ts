import { config, embeddingsEnabled } from "./config.js";

const ENDPOINT = "https://api.openai.com/v1/embeddings";
const BATCH_SIZE = 96;
const MAX_RETRIES = 5;

/** Cosine over unit vectors is a dot product, so we normalize once at write time. */
function normalize(vec: number[]): Float32Array {
  let sumSquares = 0;
  for (const v of vec) sumSquares += v * v;
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) throw new Error("Embedding API returned a zero vector");
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  let lastError = "";
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.openaiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: config.embedModel, input: texts }),
    });

    if (response.ok) {
      const body = (await response.json()) as { data: { index: number; embedding: number[] }[] };
      const ordered = [...body.data].sort((a, b) => a.index - b.index);
      if (ordered.length !== texts.length) {
        throw new Error(`Embedding API returned ${ordered.length} vectors for ${texts.length} inputs`);
      }
      return ordered.map((d) => normalize(d.embedding));
    }

    lastError = `${response.status} ${await response.text().catch(() => "")}`.slice(0, 300);
    // 429 and 5xx are the retryable shapes; anything else is a bad request we should not paper over.
    if (response.status !== 429 && response.status < 500) break;
    await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
  }
  throw new Error(`Embedding request failed after ${MAX_RETRIES} attempts: ${lastError}`);
}

export async function embedTexts(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Float32Array[]> {
  if (!embeddingsEnabled()) throw new Error("OPENAI_API_KEY is not set; cannot embed");
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    out.push(...(await embedBatch(texts.slice(i, i + BATCH_SIZE))));
    onProgress?.(Math.min(i + BATCH_SIZE, texts.length), texts.length);
  }
  return out;
}

export async function embedQuery(query: string): Promise<Float32Array> {
  const [vec] = await embedTexts([query]);
  return vec;
}

export function dot(a: Float32Array, b: Float32Array): number {
  // A dimension mismatch is a data-integrity failure, not a low score: returning -1 would let a
  // corrupt vector rank normally.
  if (a.length !== b.length) {
    throw new Error(`Embedding dimension mismatch: query ${a.length} vs stored ${b.length}. Re-run sync after an EMBED_MODEL change.`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
