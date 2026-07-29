// Análise de convergência entre o Edital e a proposta técnica.
//
// O Edital é dividido em pedaços (bem maiores que os usados na busca de
// evidência por critério) e, para reduzir ainda mais a quantidade de
// consultas sequenciais à IA, vários pedaços são agrupados numa mesma
// pergunta ("lote"), pedindo à IA um veredito para cada um de uma vez.
// Nenhuma parte do Edital fica de fora — só é lida em blocos, agrupados.

import type {
  ConfiguracaoOllama,
  EvidenciaEncontrada,
  ItemConvergenciaEdital,
  StatusConvergencia,
} from "../types";
import { chatCompletar, gerarEmbedding } from "./ollama";
import { buscarEvidencias } from "./vectorStore";

const SYSTEM_PROMPT = `Você é um avaliador técnico da Secretaria Estadual de Saúde de \
Pernambuco (SES-PE), verificando se uma proposta técnica de uma Organização Social de \
Saúde (OSS) está em conformidade com o Edital do processo de seleção.

Você recebe VÁRIOS trechos do Edital, numerados, cada um acompanhado de trechos da \
proposta técnica que mais se relacionam com ele (buscados por similaridade). Para CADA \
trecho numerado, você deve:
1. Julgar, com base EXCLUSIVAMENTE nos trechos da proposta fornecidos para aquele \
número, se a proposta atende ao que o Edital exige ali, num âmbito geral (não é \
pontuação de critério, é checagem de conformidade/consistência).
2. Classificar como "convergente" (atende), "inconsistente" (contradição, lacuna ou \
descumprimento claro) ou "nao_verificavel" (não é uma exigência concreta, ou não há \
trechos da proposta suficientes pra avaliar).
3. Nunca inventar informação que não esteja nos trechos fornecidos.

Responda SOMENTE com um JSON contendo uma lista, com um item para CADA número recebido, \
nesta forma exata:
[{"indice": 1, "status": "convergente" | "inconsistente" | "nao_verificavel", "explicacao": "..."}, {"indice": 2, ...}, ...]`;

interface TrechoComEvidencias {
  trecho: string;
  evidencias: EvidenciaEncontrada[];
}

function montarPromptLote(itens: TrechoComEvidencias[]): string {
  const blocos = itens.map((item, i) => {
    const blocoEvidencias = item.evidencias.length
      ? item.evidencias
          .map(
            (e, j) =>
              `  [Trecho da proposta ${j + 1} — arquivo: ${e.arquivoOrigem}, página ${e.pagina}]\n  ${e.trecho}`
          )
          .join("\n\n")
      : "  (Nenhum trecho relacionado foi encontrado na proposta.)";

    return `### Item ${i + 1}
TRECHO DO EDITAL:
${item.trecho}

TRECHOS DA PROPOSTA RELACIONADOS:
${blocoEvidencias}`;
  });

  return (
    blocos.join("\n\n") +
    `\n\nResponda com o JSON de lista pedido, com exatamente ${itens.length} item(ns), um para cada número de 1 a ${itens.length}.`
  );
}

interface VeredictoLote {
  indice: number;
  status: StatusConvergencia;
  explicacao: string;
}

function extrairJSONLote(texto: string): VeredictoLote[] | null {
  const match = texto.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return null;
    const statusValido: StatusConvergencia[] = [
      "convergente",
      "inconsistente",
      "nao_verificavel",
    ];
    const resultado: VeredictoLote[] = [];
    for (const item of arr) {
      if (
        typeof item?.indice === "number" &&
        typeof item?.explicacao === "string" &&
        statusValido.includes(item?.status)
      ) {
        resultado.push({ indice: item.indice, status: item.status, explicacao: item.explicacao });
      }
    }
    return resultado.length > 0 ? resultado : null;
  } catch {
    return null;
  }
}

function extrairJSONItemUnico(
  texto: string
): { status: StatusConvergencia; explicacao: string } | null {
  const match = texto.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    const statusValido: StatusConvergencia[] = [
      "convergente",
      "inconsistente",
      "nao_verificavel",
    ];
    if (typeof obj.explicacao === "string" && statusValido.includes(obj.status)) {
      return { status: obj.status, explicacao: obj.explicacao };
    }
    return null;
  } catch {
    return null;
  }
}

export interface ProgressoConvergencia {
  itemAtual: number;
  totalItens: number;
}

// Trechos do Edital muito curtos costumam ser capa, sumário, cabeçalho de
// página etc. — não valem a pena analisar.
const TAMANHO_MINIMO_TRECHO_EDITAL = 250;

// Quantos trechos de evidência da proposta buscar por trecho do Edital.
// Baixo de propósito: com vários itens agrupados num lote, cada evidência a
// mais soma bastante ao tamanho total do prompt.
const TOP_N_EVIDENCIAS = 1;

async function buscarEvidenciasDoTrecho(
  cfg: ConfiguracaoOllama,
  propostaId: string,
  texto: string
) {
  const embeddingConsulta = await gerarEmbedding(cfg, texto);
  return buscarEvidencias(propostaId, embeddingConsulta, TOP_N_EVIDENCIAS);
}

function calcularNumCtx(caracteresTotais: number): number {
  return Math.min(32768, Math.max(4096, Math.ceil(caracteresTotais / 3) + 3000));
}

/** Processa um único trecho (fallback usado quando o processamento em lote falha). */
async function processarTrechoIndividual(
  cfg: ConfiguracaoOllama,
  propostaId: string,
  trecho: { arquivoOrigem: string; pagina: number; texto: string }
): Promise<ItemConvergenciaEdital> {
  try {
    const evidencias = await buscarEvidenciasDoTrecho(cfg, propostaId, trecho.texto);
    const prompt = montarPromptLote([{ trecho: trecho.texto, evidencias }])
      // Reaproveita o formato de item único (mais simples e confiável que o de lista) para o fallback:
      .replace(
        `Responda com o JSON de lista pedido, com exatamente 1 item(ns), um para cada número de 1 a 1.`,
        `Responda SOMENTE com um JSON no formato {"status": "convergente"|"inconsistente"|"nao_verificavel", "explicacao": "..."}.`
      );
    const numCtx = calcularNumCtx(trecho.texto.length + evidencias.reduce((s, e) => s + e.trecho.length, 0));
    const resposta = await chatCompletar(cfg, SYSTEM_PROMPT, prompt, { numCtx });
    const parsed = extrairJSONItemUnico(resposta.texto);
    return {
      id: crypto.randomUUID(),
      trechoEdital: trecho.texto,
      arquivoEdital: trecho.arquivoOrigem,
      paginaEdital: trecho.pagina,
      status: parsed?.status ?? "nao_verificavel",
      explicacao:
        parsed?.explicacao ??
        `Não foi possível interpretar a resposta do modelo (mesmo processando individualmente). Resposta bruta: ${resposta.texto.slice(0, 300)}`,
      evidenciasProposta: evidencias,
    };
  } catch (err) {
    return {
      id: crypto.randomUUID(),
      trechoEdital: trecho.texto,
      arquivoEdital: trecho.arquivoOrigem,
      paginaEdital: trecho.pagina,
      status: "nao_verificavel",
      explicacao: `Erro ao analisar este trecho individualmente: ${(err as Error).message}`,
      evidenciasProposta: [],
    };
  }
}

export async function analisarConvergenciaEdital(
  cfg: ConfiguracaoOllama,
  propostaId: string,
  trechosEdital: { arquivoOrigem: string; pagina: number; texto: string }[],
  tamanhoLote = 4,
  onProgresso?: (p: ProgressoConvergencia) => void,
  deveCancelar?: () => boolean
): Promise<ItemConvergenciaEdital[]> {
  const trechosRelevantes = trechosEdital.filter(
    (t) => t.texto.trim().length >= TAMANHO_MINIMO_TRECHO_EDITAL
  );

  const resultados: ItemConvergenciaEdital[] = [];
  let processados = 0;

  for (let inicio = 0; inicio < trechosRelevantes.length; inicio += tamanhoLote) {
    if (deveCancelar?.()) break;

    const lote = trechosRelevantes.slice(inicio, inicio + tamanhoLote);

    onProgresso?.({ itemAtual: processados + 1, totalItens: trechosRelevantes.length });

    try {
      // Busca evidência de cada trecho do lote (uma consulta de embedding
      // por trecho — rápida — mas todas entram numa ÚNICA consulta de chat).
      const itensComEvidencias: TrechoComEvidencias[] = [];
      for (const trecho of lote) {
        const evidencias = await buscarEvidenciasDoTrecho(cfg, propostaId, trecho.texto);
        itensComEvidencias.push({ trecho: trecho.texto, evidencias });
      }

      const caracteresTotais = itensComEvidencias.reduce(
        (soma, item) =>
          soma + item.trecho.length + item.evidencias.reduce((s, e) => s + e.trecho.length, 0),
        0
      );
      const numCtx = calcularNumCtx(caracteresTotais);

      const prompt = montarPromptLote(itensComEvidencias);
      const resposta = await chatCompletar(cfg, SYSTEM_PROMPT, prompt, { numCtx });
      const veredictos = extrairJSONLote(resposta.texto);

      if (veredictos && veredictos.length > 0) {
        for (let i = 0; i < lote.length; i++) {
          const veredicto = veredictos.find((v) => v.indice === i + 1);
          const trecho = lote[i];
          resultados.push({
            id: crypto.randomUUID(),
            trechoEdital: trecho.texto,
            arquivoEdital: trecho.arquivoOrigem,
            paginaEdital: trecho.pagina,
            status: veredicto?.status ?? "nao_verificavel",
            explicacao:
              veredicto?.explicacao ??
              "O modelo não retornou um veredito para este item dentro do lote " +
                "(pode acontecer em lotes maiores) — considere reduzir o tamanho do lote.",
            evidenciasProposta: itensComEvidencias[i].evidencias,
          });
        }
      } else {
        // O lote inteiro falhou em ser interpretado — reprocessa cada
        // trecho individualmente, para não perder nenhum item.
        for (const trecho of lote) {
          if (deveCancelar?.()) break;
          resultados.push(await processarTrechoIndividual(cfg, propostaId, trecho));
        }
      }
    } catch (err) {
      // Erro na chamada do lote inteiro (ex.: contexto excedido mesmo
      // assim) — tenta cada trecho individualmente antes de desistir.
      console.warn("Lote falhou, reprocessando individualmente:", err);
      for (const trecho of lote) {
        if (deveCancelar?.()) break;
        resultados.push(await processarTrechoIndividual(cfg, propostaId, trecho));
      }
    }

    processados += lote.length;
  }

  return resultados;
}
