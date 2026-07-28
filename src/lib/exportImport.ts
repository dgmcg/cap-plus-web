// Exporta e importa a avaliação completa (matriz + notas + justificativas +
// análise de convergência com o Edital, se houver) num único arquivo JSON
// autocontido. Permite que uma pessoa rode a avaliação com IA uma única vez
// e distribua o resultado para os avaliadores revisarem — sem que cada um
// precise ter Ollama configurado ou rodar a IA de novo.

import type { AnaliseConvergenciaEdital, MatrizAvaliacao, SessaoAvaliacao } from "../types";

const VERSAO_FORMATO = 1;

export interface ExportacaoAvaliacaoIA {
  versao: number;
  nomeProposta: string;
  matriz: MatrizAvaliacao;
  sessao: SessaoAvaliacao;
  convergenciaEdital?: AnaliseConvergenciaEdital;
}

export class ImportacaoAvaliacaoError extends Error {}

export function gerarJsonAvaliacao(
  nomeProposta: string,
  matriz: MatrizAvaliacao,
  sessao: SessaoAvaliacao,
  convergenciaEdital?: AnaliseConvergenciaEdital
): Blob {
  const dados: ExportacaoAvaliacaoIA = {
    versao: VERSAO_FORMATO,
    nomeProposta,
    matriz,
    sessao,
    convergenciaEdital,
  };
  return new Blob([JSON.stringify(dados, null, 2)], {
    type: "application/json",
  });
}

export async function importarAvaliacaoJson(arquivo: File): Promise<ExportacaoAvaliacaoIA> {
  let texto: string;
  try {
    texto = await arquivo.text();
  } catch (err) {
    throw new ImportacaoAvaliacaoError(
      "Não consegui ler o arquivo selecionado: " + (err as Error).message
    );
  }

  let dados: unknown;
  try {
    dados = JSON.parse(texto);
  } catch {
    throw new ImportacaoAvaliacaoError(
      "Este arquivo não é um JSON válido. Confirme que é o arquivo exportado " +
        "pelo CAP+ Web (extensão .json), sem edições manuais que possam ter " +
        "quebrado a formatação."
    );
  }

  const d = dados as Partial<ExportacaoAvaliacaoIA> | null;

  if (
    !d ||
    typeof d !== "object" ||
    !d.matriz ||
    !Array.isArray(d.matriz.criterios) ||
    !d.sessao ||
    !Array.isArray(d.sessao.avaliacoes)
  ) {
    throw new ImportacaoAvaliacaoError(
      "Este arquivo não parece ser uma avaliação exportada pelo CAP+ Web — " +
        "faltam informações essenciais (a lista de critérios da matriz e/ou " +
        "as avaliações). Confirme se é o arquivo .json certo."
    );
  }

  return d as ExportacaoAvaliacaoIA;
}
