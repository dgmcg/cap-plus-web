// Importa a matriz de avaliação (planilha Excel) no navegador via SheetJS.
// Espera colunas (nomes flexíveis, veja MAPA_COLUNAS): grupo, critério,
// descrição, pontuação máxima.

import * as XLSX from "xlsx";
import type { CriterioAvaliacao, MatrizAvaliacao } from "../types";

// Aceita variações comuns de cabeçalho (case-insensitive). Ordem importa:
// candidatos mais específicos vêm primeiro, para matrizes que têm várias
// colunas parecidas (ex.: "Critério Principal" vs "Parâmetros de Avaliação").
const MAPA_COLUNAS: Record<string, string[]> = {
  grupo: [
    "critério principal",
    "criterio principal",
    "grupo",
    "dimensão",
    "dimensao",
    "categoria",
  ],
  descricao: [
    "parâmetros de avaliação",
    "parametros de avaliacao",
    "parâmetro de avaliação",
    "parametro de avaliacao",
    "descrição",
    "descricao",
    "critério",
    "criterio",
    "item",
  ],
  pontuacaoMaxima: [
    "pontuação máxima",
    "pontuacao maxima",
    "pontos",
    "peso",
    "nota máxima",
  ],
};

function normalizarCabecalho(h: string): string {
  return h
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // remove acentos p/ comparação
}

// Converte uma linha da planilha (que pode ter "buracos" — posições sem
// nenhuma célula, não a mesma coisa que uma célula vazia — quando a
// planilha tem células mescladas ou puladas) numa lista densa de strings,
// sem buracos. Usar .map() diretamente aqui quebraria, porque .map() pula
// buracos em arrays esparsos e deixa a posição como undefined no resultado.
function paraLinhaDeStrings(linha: unknown[]): string[] {
  const resultado: string[] = [];
  for (let i = 0; i < linha.length; i++) {
    resultado.push(String(linha[i] ?? ""));
  }
  return resultado;
}

function encontrarColuna(
  cabecalhos: string[],
  candidatos: string[],
  ignorarIndice?: number
): number {
  const normalizados = cabecalhos.map(normalizarCabecalho);
  for (const candidato of candidatos) {
    const alvo = normalizarCabecalho(candidato);
    const idx = normalizados.findIndex((h, i) => {
      if (i === ignorarIndice || h.length === 0) return false;
      // Casamento por conter o texto num sentido ou no outro, mas evitando
      // que células vazias ou cabeçalhos muito curtos deem "match" trivial
      // (ex.: um cabeçalho de 1 letra não deve "conter" um alvo grande).
      return h.includes(alvo) || (h.length >= 3 && alvo.includes(h));
    });
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
    const candidatos = paraLinhaDeStrings(linhas[i] as unknown[]);
    const idxDescricao = encontrarColuna(candidatos, MAPA_COLUNAS.descricao);
    const idxPontuacao = encontrarColuna(candidatos, MAPA_COLUNAS.pontuacaoMaxima);

    // Só consideramos que achamos o cabeçalho se AMBAS as colunas
    // essenciais aparecerem na mesma linha.
    if (idxDescricao !== -1 && idxPontuacao !== -1) {
      // Evita que "grupo" aponte pra mesma coluna já usada como descrição
      // (acontece quando os dois nomes de coluna são parecidos, ex.:
      // "Critério Principal" e "...Critério...").
      const idxGrupo = encontrarColuna(candidatos, MAPA_COLUNAS.grupo, idxDescricao);
      return { linhaIndex: i, idxGrupo, idxDescricao, idxPontuacao };
    }
  }

  return null;
}

// Linhas de totalização (subtotal, total geral, etc.) que aparecem nas
// matrizes, mas não são critérios avaliáveis de verdade.
const PALAVRAS_LINHA_DE_TOTAL = ["subtotal", "total geral", "totais", "total"];

function pareceLinhaDeTotal(descricao: string, grupo: string): boolean {
  const d = normalizarCabecalho(descricao);
  const g = normalizarCabecalho(grupo);
  return PALAVRAS_LINHA_DE_TOTAL.some((p) => d === p || g === p);
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
      .map((l, i) => `Linha ${i + 1}: ${paraLinhaDeStrings(l as unknown[]).join(" | ")}`)
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

    if (pareceLinhaDeTotal(descricao, grupo)) continue;

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
