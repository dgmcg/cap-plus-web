// Armazenamento vetorial local no navegador, usando IndexedDB.
// Substitui o LanceDB da versão desktop. Para o volume de uma proposta
// técnica (centenas a poucos milhares de chunks por processo), busca por
// similaridade de cosseno em memória é rápida o suficiente — não precisa
// de índice ANN.

import { openDB, type IDBPDatabase } from "idb";
import type { ChunkDocumento, EvidenciaEncontrada } from "../types";

const DB_NAME = "cap-plus-vetores";
const DB_VERSION = 1;
const STORE = "chunks";

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("propostaId", "propostaId");
      },
    });
  }
  return dbPromise;
}

export async function salvarChunks(chunks: ChunkDocumento[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(STORE, "readwrite");
  await Promise.all(chunks.map((c) => tx.store.put(c)));
  await tx.done;
}

export async function listarChunksDaProposta(
  propostaId: string
): Promise<ChunkDocumento[]> {
  const db = await getDb();
  return db.getAllFromIndex(STORE, "propostaId", propostaId);
}

export async function removerChunksDaProposta(propostaId: string): Promise<void> {
  const chunks = await listarChunksDaProposta(propostaId);
  const db = await getDb();
  const tx = db.transaction(STORE, "readwrite");
  await Promise.all(chunks.map((c) => tx.store.delete(c.id)));
  await tx.done;
}

function similaridadeCosseno(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Busca os N chunks mais similares ao embedding de consulta, dentro de uma
 * proposta específica.
 */
export async function buscarEvidencias(
  propostaId: string,
  embeddingConsulta: number[],
  topN = 5
): Promise<EvidenciaEncontrada[]> {
  const chunks = await listarChunksDaProposta(propostaId);

  const pontuados = chunks
    .filter((c) => c.embedding && c.embedding.length > 0)
    .map((c) => ({
      chunk: c,
      score: similaridadeCosseno(embeddingConsulta, c.embedding!),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  return pontuados.map(({ chunk, score }) => ({
    chunkId: chunk.id,
    arquivoOrigem: chunk.arquivoOrigem,
    pagina: chunk.pagina,
    trecho: chunk.texto,
    similaridade: score,
  }));
}
