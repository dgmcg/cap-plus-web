// Análise de convergência entre o Edital e a proposta técnica.
//
// Percorre o Edital em pedaços (bem maiores que os usados na busca de
// evidência por critério, propositalmente — aqui a ideia é reduzir a
// quantidade de consultas sequenciais à IA, não ter granularidade fina) e,
// para cada pedaço, busca evidência correspondente na proposta já indexada
// (RAG local), perguntando ao modelo se a proposta está em conformidade ou
// se há inconsistência com aquele trecho do Edital. Como o Edital inteiro é
// percorrido em pedaços (não cortado num limite fixo), nenhuma parte do
// documento fica de fora — só analisada em blocos maiores.

import type {
  ConfiguracaoOllama,
  ItemConvergenciaEdital,
  StatusConvergencia,
} from "../types";
import { chatCompletar, gerarEmbedding } from "./ollama";
import { buscarEvidencias } from "./vectorStore";

const SYSTEM_PROMPT = `Você é um avaliador técnico da Secretaria Estadual de Saúde de \
Pernambuco (SES-PE), verificando se uma proposta técnica de uma Organização Social de \
Saúde (OSS) está em conformidade com o Edital do processo de seleção.

Você recebe um trecho do Edital (pode ser um bloco relativamente extenso, cobrindo \
várias exigências) e trechos extraídos da proposta técnica que mais se relacionam com \
esse trecho do Edital (buscados automaticamente por similaridade). Sua tarefa:
1. Julgar, com base EXCLUSIVAMENTE nos trechos da proposta fornecidos, se a proposta \
atende ao que esse trecho do Edital exige, num âmbito geral (não se trata de pontuação \
de critério, é uma checagem de conformidade/consistência).
2. Classificar como:
   - "convergente": a proposta atende ou está alinhada ao que o Edital pede neste trecho.
   - "inconsistente": há uma contradição, lacuna clara ou descumprimento em relação ao \
que o Edital exige.
   - "nao_verificavel": o trecho do Edital não é uma exigência concreta que dê pra \
checar (ex.: é só um trecho introdutório, definição, ou os trechos da proposta \
fornecidos não têm relação suficiente para avaliar).
3. Se o trecho do Edital cobrir várias exigências diferentes, dê um veredito conjunto \
mas cite na explicação quais exigências específicas motivaram esse veredito.
4. Nunca inventar informação que não esteja nos trechos fornecidos.
5. Responder SOMENTE em JSON válido, no formato:
{"status": "convergente" | "inconsistente" | "nao_verificavel", "explicacao": "<explicação objetiva e direta, citando as exigências específicas relevantes>"}`;

function montarPromptUsuario(
  trechoEdital: string,
  evidencias: { trecho: string; arquivoOrigem: string; pagina: number }[]
): string {
  const blocoEvidencias = evidencias.length
    ? evidencias
        .map(
          (e, i) =>
            `[Trecho da proposta ${i + 1} — arquivo: ${e.arquivoOrigem}, página ${e.pagina}]\n${e.trecho}`
        )
        .join("\n\n")
    : "(Nenhum trecho relacionado foi encontrado na proposta.)";

  return `TRECHO DO EDITAL A VERIFICAR:
${trechoEdital}

TRECHOS DA PROPOSTA RELACIONADOS (buscados por similaridade):
${blocoEvidencias}

Responda apenas com o JSON pedido.`;
}

function extrairJSON(
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
// página etc. — não valem a pena analisar (e só custam tempo de processamento).
const TAMANHO_MINIMO_TRECHO_EDITAL = 250;

// Quantos trechos de evidência da proposta buscar por trecho do Edital.
// Mantido baixo porque, com pedaços de Edital grandes, o prompt já fica
// longo por conta própria — cada evidência a mais soma bastante ao tamanho
// total enviado ao modelo.
const TOP_N_EVIDENCIAS = 2;

export async function analisarConvergenciaEdital(
  cfg: ConfiguracaoOllama,
  propostaId: string,
  trechosEdital: { arquivoOrigem: string; pagina: number; texto: string }[],
  onProgresso?: (p: ProgressoConvergencia) => void,
  deveCancelar?: () => boolean
): Promise<ItemConvergenciaEdital[]> {
  const trechosRelevantes = trechosEdital.filter(
    (t) => t.texto.trim().length >= TAMANHO_MINIMO_TRECHO_EDITAL
  );

  // Calcula uma janela de contexto (num_ctx) grande o suficiente pro maior
  // trecho do Edital + as evidências da proposta + o prompt do sistema,
  // baseada no tamanho real dos pedaços que essa análise vai usar (que
  // pode ser bem maior que o padrão usado na avaliação por critério).
  const maiorTrecho = Math.max(...trechosRelevantes.map((t) => t.texto.length), 1000);
  const numCtx = Math.min(32768, Math.max(4096, Math.ceil(maiorTrecho / 3) + 4000));

  const resultados: ItemConvergenciaEdital[] = [];

  for (let i = 0; i < trechosRelevantes.length; i++) {
    if (deveCancelar?.()) break;

    const trecho = trechosRelevantes[i];
    onProgresso?.({ itemAtual: i + 1, totalItens: trechosRelevantes.length });

    try {
      const embeddingConsulta = await gerarEmbedding(cfg, trecho.texto);
      const evidencias = await buscarEvidencias(propostaId, embeddingConsulta, TOP_N_EVIDENCIAS);
      const prompt = montarPromptUsuario(trecho.texto, evidencias);
      const resposta = await chatCompletar(cfg, SYSTEM_PROMPT, prompt, { numCtx });
      const parsed = extrairJSON(resposta.texto);

      resultados.push({
        id: crypto.randomUUID(),
        trechoEdital: trecho.texto,
        arquivoEdital: trecho.arquivoOrigem,
        paginaEdital: trecho.pagina,
        status: parsed?.status ?? "nao_verificavel",
        explicacao:
          parsed?.explicacao ??
          `Não foi possível interpretar a resposta do modelo. Resposta bruta: ${resposta.texto.slice(0, 400)}`,
        evidenciasProposta: evidencias,
      });
    } catch (err) {
      resultados.push({
        id: crypto.randomUUID(),
        trechoEdital: trecho.texto,
        arquivoEdital: trecho.arquivoOrigem,
        paginaEdital: trecho.pagina,
        status: "nao_verificavel",
        explicacao: `Erro ao analisar este trecho: ${(err as Error).message}`,
        evidenciasProposta: [],
      });
    }
  }

  return resultados;
}
