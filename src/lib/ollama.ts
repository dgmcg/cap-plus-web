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
 * Gera o embedding de um texto, dividindo-o recursivamente ao meio se o
 * Ollama recusar por o texto ser grande demais para o contexto do modelo
 * (em vez de simplesmente desistir e perder aquele trecho da proposta).
 * Só desiste de verdade se um pedaço já pequeno (menos de `tamanhoMinimo`
 * caracteres) ainda assim falhar.
 */
export async function gerarEmbeddingComDivisao(
  cfg: ConfiguracaoOllama,
  texto: string,
  profundidadeMaxima = 4,
  tamanhoMinimo = 300
): Promise<{ texto: string; embedding: number[] }[]> {
  try {
    const embedding = await gerarEmbedding(cfg, texto);
    return [{ texto, embedding }];
  } catch (err) {
    const excedeuContexto =
      err instanceof OllamaError &&
      /context length|context window|exceeds/i.test(err.message);

    if (!excedeuContexto || profundidadeMaxima <= 0 || texto.length < tamanhoMinimo) {
      throw err;
    }

    const meio = Math.floor(texto.length / 2);
    let corte = texto.lastIndexOf(" ", meio);
    if (corte < texto.length * 0.2) corte = meio; // sem espaço bom por perto; corta seco
    const parte1 = texto.slice(0, corte).trim();
    const parte2 = texto.slice(corte).trim();

    const resultados: { texto: string; embedding: number[] }[] = [];
    if (parte1) {
      resultados.push(
        ...(await gerarEmbeddingComDivisao(cfg, parte1, profundidadeMaxima - 1, tamanhoMinimo))
      );
    }
    if (parte2) {
      resultados.push(
        ...(await gerarEmbeddingComDivisao(cfg, parte2, profundidadeMaxima - 1, tamanhoMinimo))
      );
    }
    return resultados;
  }
}

/**
 * Envia um prompt de avaliação (com contexto/evidências já embutido) ao
 * modelo de chat e retorna a resposta bruta em texto.
 */
export async function chatCompletar(
  cfg: ConfiguracaoOllama,
  systemPrompt: string,
  userPrompt: string,
  options?: { temperature?: number; numCtx?: number }
): Promise<RespostaChat> {
  const res = await ollamaFetch(cfg.baseUrl, "/api/chat", {
    model: cfg.modeloChat,
    stream: false,
    options: {
      temperature: options?.temperature ?? 0.1,
      ...(options?.numCtx ? { num_ctx: options.numCtx } : {}),
    },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });
  const data = await res.json();
  return { texto: data.message?.content ?? "" };
}
