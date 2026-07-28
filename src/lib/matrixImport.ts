// Importa a matriz de avaliação (planilha Excel) no navegador via SheetJS.
// Espera colunas (nomes flexíveis, veja MAPA_COLUNAS): grupo, critério,
// descrição, pontuação máxima.

import * as XLSX from "xlsx";
import type { CriterioAvaliacao, MatrizAvaliacao } from "../types";

// Aceita variações comuns de cabeçalho (case-insensitive).
const MAPA_COLUNAS: Record<string, string[]> = {
  grupo: ["grupo", "dimensão", "dimensao", "categoria"],
  descricao: ["critério", "criterio", "descrição", "descricao", "item"],
  pontuacaoMaxima: ["pontuação máxima", "pontuacao maxima", "pontos", "peso", "nota máxima"],
};

function normalizarCabecalho(h: string): string {
  return h
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // remove acentos p/ comparação
}

function encontrarColuna(
  cabecalhos: string[],
  candidatos: string[]
): number {
  const normalizados = cabecalhos.map(normalizarCabecalho);
  for (const candidato of candidatos) {
    const alvo = normalizarCabecalho(candidato);
    const idx = normalizados.findIndex((h) => h.includes(alvo) || alvo.includes(h));
    if (idx !== -1) return idx;
  }
  return -1;
}

export class MatrizImportError extends Error {}

export async function importarMatriz(arquivo: File): Promise<MatrizAvaliacao> {
  const buffer = await arquivo.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const primeiraAba = workbook.SheetNames[0];
  const planilha = workbook.Sheets[primeiraAba];

  const linhas: unknown[][] = XLSX.utils.sheet_to_json(planilha, {
    header: 1,
    blankrows: false,
  });

  if (linhas.length < 2) {
    throw new MatrizImportError(
      "A planilha parece vazia ou não tem linhas de dados abaixo do cabeçalho."
    );
  }

  const cabecalhos = (linhas[0] as string[]).map((c) => String(c ?? ""));
  const idxGrupo = encontrarColuna(cabecalhos, MAPA_COLUNAS.grupo);
  const idxDescricao = encontrarColuna(cabecalhos, MAPA_COLUNAS.descricao);
  const idxPontuacao = encontrarColuna(cabecalhos, MAPA_COLUNAS.pontuacaoMaxima);

  if (idxDescricao === -1 || idxPontuacao === -1) {
    throw new MatrizImportError(
      "Não encontrei as colunas de critério e/ou pontuação máxima na " +
        "planilha. Colunas encontradas: " + cabecalhos.join(", ")
    );
  }

  const criterios: CriterioAvaliacao[] = [];
  for (let i = 1; i < linhas.length; i++) {
    const linha = linhas[i] as unknown[];
    const descricao = String(linha[idxDescricao] ?? "").trim();
    if (!descricao) continue;

    const pontuacaoMaxima = Number(linha[idxPontuacao] ?? 0);
    const grupo = idxGrupo !== -1 ? String(linha[idxGrupo] ?? "").trim() : "Geral";

    criterios.push({
      id: `crit-${i}`,
      grupo: grupo || "Geral",
      descricao,
      pontuacaoMaxima: Number.isFinite(pontuacaoMaxima) ? pontuacaoMaxima : 0,
    });
  }

  if (criterios.length === 0) {
    throw new MatrizImportError("Nenhum critério válido foi encontrado na planilha.");
  }

  return {
    nomeArquivo: arquivo.name,
    criterios,
    importadoEm: new Date().toISOString(),
  };
}
