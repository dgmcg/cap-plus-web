// Motor de avaliação: para cada critério da matriz, busca evidências
// relevantes na proposta (RAG local) e pede ao modelo Ollama uma nota
// sugerida com justificativa, sempre citando de onde tirou a evidência.

import type { AvaliacaoCriterio, ConfiguracaoOllama, CriterioAvaliacao } from "../types";
import { chatCompletar, gerarEmbedding } from "./ollama";
import { buscarEvidencias } from "./vectorStore";

const SYSTEM_PROMPT = `Você é um avaliador técnico da Secretaria Estadual de Saúde de \
Pernambuco (SES-PE), analisando propostas técnicas de Organizações Sociais de Saúde \
(OSS) com base na Lei Estadual nº 15.210/2013 e no Decreto Estadual nº 58.200/2025.

Para cada critério, você recebe trechos extraídos da proposta técnica (evidências). \
Sua tarefa:
1. Avaliar se e o quanto o critério é atendido, EXCLUSIVAMENTE com base nas evidências fornecidas.
2. Nunca inventar ou presumir informação que não esteja no texto das evidências.
3. Se as evidências não permitirem avaliar o critério, dizer isso explicitamente e sugerir nota 0.
4. Responder SOMENTE em JSON válido, no formato:
{"nota": <número entre 0 e a pontuação máxima informada>, "justificativa": "<explicação objetiva, citando trechos relevantes>"}`;

function montarPromptUsuario(
  criterio: CriterioAvaliacao,
  evidencias: { trecho: string; arquivoOrigem: string; pagina: number }[]
): string {
  const blocoEvidencias = evidencias.length
    ? evidencias
        .map(
          (e, i) =>
            `[Evidência ${i + 1} — arquivo: ${e.arquivoOrigem}, página ${e.pagina}]\n${e.trecho}`
        )
        .join("\n\n")
    : "(Nenhuma evidência relevante foi encontrada na proposta para este critério.)";

  return `CRITÉRIO A AVALIAR:
Grupo: ${criterio.grupo}
Descrição: ${criterio.descricao}
Pontuação máxima: ${criterio.pontuacaoMaxima}

EVIDÊNCIAS EXTRAÍDAS DA PROPOSTA:
${blocoEvidencias}

Responda apenas com o JSON pedido.`;
}

function extrairJSON(texto: string): { nota: number; justificativa: string } | null {
  // O modelo às vezes envolve o JSON em texto ou blocos de código; tenta
  // localizar o primeiro objeto JSON válido na resposta.
  const match = texto.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    if (typeof obj.nota === "number" && typeof obj.justificativa === "string") {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}

export interface ProgressoAvaliacao {
  criterioAtual: number;
  totalCriterios: number;
  descricaoCriterio: string;
}

/**
 * Avalia todos os critérios de uma matriz contra uma proposta já indexada
 * (chunks + embeddings salvos no vectorStore), um por um.
 */
export async function avaliarCriterios(
  cfg: ConfiguracaoOllama,
  propostaId: string,
  criterios: CriterioAvaliacao[],
  onProgresso?: (p: ProgressoAvaliacao) => void,
  deveCancelar?: () => boolean
): Promise<AvaliacaoCriterio[]> {
  const resultados: AvaliacaoCriterio[] = [];

  for (let i = 0; i < criterios.length; i++) {
    if (deveCancelar?.()) break;

    const criterio = criterios[i];
    onProgresso?.({
      criterioAtual: i + 1,
      totalCriterios: criterios.length,
      descricaoCriterio: criterio.descricao,
    });

    try {
      const embeddingConsulta = await gerarEmbedding(cfg, criterio.descricao);
      const evidencias = await buscarEvidencias(propostaId, embeddingConsulta, 5);

      const prompt = montarPromptUsuario(criterio, evidencias);
      const resposta = await chatCompletar(cfg, SYSTEM_PROMPT, prompt);
      const parsed = extrairJSON(resposta.texto);

      resultados.push({
        criterioId: criterio.id,
        notaSugeridaIA: parsed
          ? Math.min(Math.max(parsed.nota, 0), criterio.pontuacaoMaxima)
          : null,
        justificativaIA: parsed
          ? parsed.justificativa
          : `Não foi possível interpretar a resposta do modelo. Resposta bruta: ${resposta.texto.slice(0, 500)}`,
        evidencias,
        notaRevisada: null,
        observacaoAvaliador: "",
        status: "avaliado_ia",
      });
    } catch (err) {
      resultados.push({
        criterioId: criterio.id,
        notaSugeridaIA: null,
        justificativaIA: `Erro ao avaliar este critério: ${(err as Error).message}`,
        evidencias: [],
        notaRevisada: null,
        observacaoAvaliador: "",
        status: "pendente",
      });
    }
  }

  return resultados;
}
