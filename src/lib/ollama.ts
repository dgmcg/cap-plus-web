// Cliente Ollama — chama diretamente http://localhost:11434 (ou outro host configurado)
// a partir do navegador. Requer que o usuário tenha configurado OLLAMA_ORIGINS
// liberando a origem desta página. Nenhum dado passa por servidor intermediário.

import type { ConfiguracaoOllama } from "../types";

export class OllamaError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "OllamaError";
    this.cause = cause;
  }
}

async function ollamaFetch(baseUrl: string, path: string, body: unknown) {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new OllamaError(
      "Não foi possível conectar ao Ollama local. Verifique se o Ollama está " +
        "rodando e se a variável OLLAMA_ORIGINS libera esta página (veja " +
        "Configurações > Conexão com Ollama).",
      err
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OllamaError(`Ollama respondeu com erro ${res.status}: ${text}`);
  }
  return res;
}

/** Testa se o Ollama está acessível e lista os modelos instalados. */
export async function testarConexao(baseUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    return (data.models ?? []).map((m: { name: string }) => m.name);
  } catch (err) {
    throw new OllamaError(
      "Não foi possível listar os modelos do Ollama. Confirme que o serviço " +
        "está ativo em " + baseUrl,
      err
    );
  }
}

/** Gera o embedding de um texto usando o modelo de embedding configurado. */
export async function gerarEmbedding(
  cfg: ConfiguracaoOllama,
  texto: string
): Promise<number[]> {
  const res = await ollamaFetch(cfg.baseUrl, "/api/embeddings", {
    model: cfg.modeloEmbedding,
    prompt: texto,
  });
  const data = await res.json();
  return data.embedding as number[];
}

export interface RespostaChat {
  texto: string;
}

/**
 * Envia um prompt de avaliação (com contexto/evidências já embutido) ao
 * modelo de chat e retorna a resposta bruta em texto.
 */
export async function chatCompletar(
  cfg: ConfiguracaoOllama,
  systemPrompt: string,
  userPrompt: string,
  options?: { temperature?: number }
): Promise<RespostaChat> {
  const res = await ollamaFetch(cfg.baseUrl, "/api/chat", {
    model: cfg.modeloChat,
    stream: false,
    options: { temperature: options?.temperature ?? 0.1 },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });
  const data = await res.json();
  return { texto: data.message?.content ?? "" };
}
