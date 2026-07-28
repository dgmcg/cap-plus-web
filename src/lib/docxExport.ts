// Gera o relatório final em .docx inteiramente no navegador, usando a
// biblioteca "docx". Substitui a geração de Word que hoje roda no processo
// Node.js da versão desktop.

import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type {
  AnaliseConvergenciaEdital,
  AvaliacaoCriterio,
  CriterioAvaliacao,
  SessaoAvaliacao,
  StatusConvergencia,
} from "../types";

// O formato do Word (.docx) é, por baixo dos panos, um arquivo XML. O
// padrão XML proíbe certos caracteres de controle (fora tab/quebra de
// linha/retorno de carro) — e texto vindo de OCR de PDF escaneado às vezes
// contém "lixo" invisível desse tipo. Sem essa limpeza, o Word recusa abrir
// o arquivo com um erro apontando pra uma posição dentro do document.xml.
function limparTextoParaXml(texto: string): string {
  // eslint-disable-next-line no-control-regex
  return texto.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, "");
}

function celula(texto: string, opts?: { negrito?: boolean; largura?: number }): TableCell {
  return new TableCell({
    width: opts?.largura ? { size: opts.largura, type: WidthType.PERCENTAGE } : undefined,
    children: [
      new Paragraph({
        children: [new TextRun({ text: limparTextoParaXml(texto), bold: opts?.negrito ?? false })],
      }),
    ],
  });
}

function paragrafo(texto: string): Paragraph {
  return new Paragraph({ text: limparTextoParaXml(texto) });
}

const ROTULO_STATUS: Record<StatusConvergencia, string> = {
  convergente: "Convergente",
  inconsistente: "Inconsistente",
  nao_verificavel: "Não verificável",
};

function construirSecaoConvergencia(convergencia: AnaliseConvergenciaEdital): Paragraph[] {
  const paragrafos: Paragraph[] = [
    new Paragraph({ text: "", spacing: { before: 300 } }),
    new Paragraph({
      text: "Análise de Convergência: Edital x Proposta",
      heading: HeadingLevel.HEADING_1,
    }),
    paragrafo(
      "Verificação automática, em âmbito geral, de aderência da proposta ao que o " +
        `Edital (${convergencia.editalNomeArquivos.join(", ")}) exige — não substitui ` +
        "a avaliação por critério da matriz, é uma checagem complementar de " +
        "consistência. Revise cada apontamento antes de considerá-lo definitivo."
    ),
    new Paragraph({ text: "" }),
  ];

  const inconsistentes = convergencia.itens.filter((i) => i.status === "inconsistente");
  const naoVerificaveis = convergencia.itens.filter((i) => i.status === "nao_verificavel");
  const convergentes = convergencia.itens.filter((i) => i.status === "convergente");

  paragrafos.push(
    paragrafo(
      `Resumo: ${convergentes.length} trecho(s) convergente(s), ` +
        `${inconsistentes.length} inconsistência(s) apontada(s), ` +
        `${naoVerificaveis.length} trecho(s) não verificável(is).`
    ),
    new Paragraph({ text: "" })
  );

  if (inconsistentes.length > 0) {
    paragrafos.push(
      new Paragraph({ text: "Inconsistências apontadas", heading: HeadingLevel.HEADING_2 })
    );
    for (const item of inconsistentes) {
      paragrafos.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `[${ROTULO_STATUS[item.status]}] Edital (${item.arquivoEdital}, p. ${item.paginaEdital}): `,
              bold: true,
            }),
            new TextRun({ text: limparTextoParaXml(item.trechoEdital.slice(0, 400)) }),
          ],
        }),
        paragrafo(`Análise: ${item.explicacao}`),
        new Paragraph({ text: "" })
      );
    }
  }

  return paragrafos;
}

export async function gerarRelatorioDocx(
  sessao: SessaoAvaliacao,
  criterios: CriterioAvaliacao[],
  nomeProposta: string,
  convergencia?: AnaliseConvergenciaEdital
): Promise<Blob> {
  const porCriterio = new Map<string, AvaliacaoCriterio>();
  for (const a of sessao.avaliacoes) porCriterio.set(a.criterioId, a);

  const linhasTabela: TableRow[] = [
    new TableRow({
      children: [
        celula("Grupo", { negrito: true, largura: 15 }),
        celula("Critério", { negrito: true, largura: 35 }),
        celula("Pontuação máxima", { negrito: true, largura: 12 }),
        celula("Nota sugerida (IA)", { negrito: true, largura: 12 }),
        celula("Nota final (revisada)", { negrito: true, largura: 13 }),
        celula("Justificativa / observação", { negrito: true, largura: 25 }),
      ],
    }),
  ];

  let totalMaximo = 0;
  let totalFinal = 0;

  for (const criterio of criterios) {
    const av = porCriterio.get(criterio.id);
    const notaFinal = av?.notaRevisada ?? av?.notaSugeridaIA ?? 0;
    totalMaximo += criterio.pontuacaoMaxima;
    totalFinal += notaFinal;

    linhasTabela.push(
      new TableRow({
        children: [
          celula(criterio.grupo),
          celula(criterio.descricao),
          celula(String(criterio.pontuacaoMaxima)),
          celula(av?.notaSugeridaIA?.toString() ?? "—"),
          celula(notaFinal.toString()),
          celula(
            [av?.justificativaIA, av?.observacaoAvaliador].filter(Boolean).join(" | ") || "—"
          ),
        ],
      })
    );
  }

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            text: "Relatório de Avaliação Técnica de Proposta OSS",
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER,
          }),
          new Paragraph({
            text: "Secretaria Estadual de Saúde de Pernambuco (SES-PE)",
            alignment: AlignmentType.CENTER,
          }),
          new Paragraph({
            text: "Base legal: Lei Estadual nº 15.210/2013 e Decreto Estadual nº 58.200/2025",
            alignment: AlignmentType.CENTER,
          }),
          new Paragraph({ text: "" }),
          paragrafo(`Proposta avaliada: ${nomeProposta}`),
          paragrafo(`Matriz utilizada: ${sessao.matrizNomeArquivo}`),
          paragrafo(`Avaliador: ${sessao.avaliadorNome}`),
          paragrafo(`Modelo de IA utilizado (apoio): ${sessao.modeloIA}`),
          new Paragraph({
            text: `Data de emissão: ${new Date().toLocaleDateString("pt-BR")}`,
          }),
          new Paragraph({ text: "" }),
          new Paragraph({
            text: "Nota: as notas sugeridas pela IA são um apoio à análise e foram " +
              "revisadas por avaliador humano antes da consolidação deste relatório.",
          }),
          new Paragraph({ text: "" }),
          new Table({ rows: linhasTabela, width: { size: 100, type: WidthType.PERCENTAGE } }),
          new Paragraph({ text: "" }),
          new Paragraph({
            children: [
              new TextRun({
                text: `Pontuação total: ${totalFinal} / ${totalMaximo}`,
                bold: true,
              }),
            ],
          }),
          ...(convergencia ? construirSecaoConvergencia(convergencia) : []),
        ],
      },
    ],
  });

  return Packer.toBlob(doc);
}

export function baixarBlob(blob: Blob, nomeArquivo: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nomeArquivo;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
