import type { AIClient } from "./planning";

export const EMBEDDING_MODEL = "@cf/baai/bge-large-en-v1.5";

export interface ReflectionMemoryRecord {
  id: string;
  namespace: string;
  text: string;
  mood: number;
  createdAt: number;
}

export async function retrieveRelevantReflections(
  ai: AIClient,
  index: VectorizeIndex,
  namespace: string,
  query: string,
  records: ReflectionMemoryRecord[],
) {
  if (records.length === 0) return [];

  let selected: ReflectionMemoryRecord[] = [];
  try {
    const embedding = (await ai.run(EMBEDDING_MODEL, { text: query })) as {
      data?: number[][];
    };
    const vector = embedding.data?.[0];
    if (!vector) throw new Error("Reflection query embedding was empty");

    const matches = await index.query(vector, {
      namespace,
      topK: Math.min(10, records.length),
      returnMetadata: "none",
    });
    const recordsById = new Map(records.map((record) => [record.id, record]));
    selected = matches.matches
      .map((match) => recordsById.get(match.id))
      .filter((record): record is ReflectionMemoryRecord => Boolean(record));
  } catch (error) {
    console.error("Vector reflection retrieval failed", error);
  }

  if (selected.length === 0) selected = records.slice(-5);
  return selected.map(({ text, mood, createdAt }) => ({
    text,
    mood,
    createdAt,
  }));
}
