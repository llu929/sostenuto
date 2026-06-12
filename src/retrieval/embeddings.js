/**
 * embeddings.js — embedding client (Voyage AI by default).
 *
 * The rest of Sostenuto only ever sees two functions:
 *   embed(texts)      → number[][]   (documents, for storage)
 *   embedQuery(text)  → number[]     (queries, for retrieval)
 *
 * Swap providers by constructing your own object with the same shape —
 * everything downstream is dependency-injected.
 *
 * Default model: voyage-3-large at 1024 dims — chosen for strong
 * multilingual quality (memories that mix languages retrieve precisely).
 * IMPORTANT: the dimension here must match `vector(N)` in db/schema.sql.
 * Embedding spaces cannot be mixed: changing models means re-embedding
 * everything.
 */

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

const DEFAULTS = {
  model: "voyage-3-large",
  dimensions: 1024,
  batchSize: 50,
  maxRetries: 3,
};

/**
 * @param {object} cfg
 * @param {string} cfg.apiKey        Voyage API key
 * @param {string} [cfg.model]
 * @param {number} [cfg.dimensions]
 * @param {number} [cfg.batchSize]
 */
export function createEmbedder({ apiKey, ...rest } = {}) {
  if (!apiKey) throw new Error("createEmbedder: apiKey is required");
  const cfg = { ...DEFAULTS, ...rest };

  async function call(texts, inputType) {
    let attempt = 0;
    for (;;) {
      const res = await fetch(VOYAGE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          input: texts,
          model: cfg.model,
          input_type: inputType, // 'document' | 'query' — matters for retrieval quality
          output_dimension: cfg.dimensions,
        }),
      });
      if (res.status === 429 && attempt < cfg.maxRetries) {
        attempt++;
        await new Promise((r) => setTimeout(r, 15_000 * attempt));
        continue;
      }
      if (!res.ok) {
        throw new Error(`Voyage ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const json = await res.json();
      return json.data.map((d) => d.embedding);
    }
  }

  /** Embed documents for storage, batched. */
  async function embed(texts) {
    if (!texts || texts.length === 0) return [];
    const out = [];
    for (let i = 0; i < texts.length; i += cfg.batchSize) {
      out.push(...(await call(texts.slice(i, i + cfg.batchSize), "document")));
    }
    return out;
  }

  /** Embed a single retrieval query. */
  async function embedQuery(text) {
    const [vec] = await call([text], "query");
    return vec;
  }

  return { embed, embedQuery, dimensions: cfg.dimensions, model: cfg.model };
}
