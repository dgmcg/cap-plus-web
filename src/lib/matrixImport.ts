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

// Quantidade de linhas iniciais em que vamos procurar o cabeçalho de verdade.
// Cobre planilhas que têm título, nome da unidade, linhas em branco, etc.
// antes da linha com os nomes das colunas.
const MAX_LINHAS_PARA_PROCURAR_CABECALHO = 15;

interface CabecalhoEncontrado {
  linhaIndex: number;
  idxGrupo: number;
  idxDescricao: number;
  idxPontuacao: number;
}

/**
 * Procura, entre as primeiras linhas da planilha, qual delas é o cabeçalho
 * de verdade (a que tem as colunas de critério e pontuação máxima). Isso
 * cobre o caso comum de planilhas institucionais que começam com uma linha
 * de título (ex.: nome da unidade de saúde) antes do cabeçalho.
 */
function localizarCabecalho(linhas: unknown[][]): CabecalhoEncontrado | null {
  const limite = Math.min(linhas.length, MAX_LINHAS_PARA_PROCURAR_CABECALHO);

  for (let i = 0; i < limite; i++) {
    const candidatos = (linhas[i] as unknown[]).map((c) => String(c ?? ""));
    const idxDescricao = encontrarColuna(candidatos, MAPA_COLUNAS.descricao);
    const idxPontuacao = encontrarColuna(candidatos, MAPA_COLUNAS.pontuacaoMaxima);

    // Só consideramos que achamos o cabeçalho se AMBAS as colunas
    // essenciais aparecerem na mesma linha.
    if (idxDescricao !== -1 && idxPontuacao !== -1) {
      const idxGrupo = encontrarColuna(candidatos, MAPA_COLUNAS.grupo);
      return { linhaIndex: i, idxGrupo, idxDescricao, idxPontuacao };
    }
  }

  return null;
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

  const cabecalho = localizarCabecalho(linhas);

  if (!cabecalho) {
    const primeirasLinhas = linhas
      .slice(0, Math.min(linhas.length, MAX_LINHAS_PARA_PROCURAR_CABECALHO))
      .map((l, i) => `Linha ${i + 1}: ${(l as unknown[]).map((c) => String(c ?? "")).join(" | ")}`)
      .join("\n");
    throw new MatrizImportError(
      "Não encontrei uma linha com as colunas de critério e pontuação máxima " +
        `nas primeiras ${MAX_LINHAS_PARA_PROCURAR_CABECALHO} linhas da planilha. ` +
        "Conteúdo encontrado:\n" + primeirasLinhas
    );
  }

  const { linhaIndex, idxGrupo, idxDescricao, idxPontuacao } = cabecalho;

  const criterios: CriterioAvaliacao[] = [];
  for (let i = linhaIndex + 1; i < linhas.length; i++) {
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
