// Extração de texto de PDF 100% no navegador.
// - Camada de texto nativa: PDF.js
// - Páginas digitalizadas (sem camada de texto, ou com pouquíssimo texto):
//   renderiza a página como imagem e roda OCR com Tesseract.js
//
// Substitui o uso de Poppler (nativo) da versão desktop.

import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.mjs?url";
import { createWorker, type Worker } from "tesseract.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

// Limiar: se a página tiver menos que isso de caracteres na camada de texto,
// consideramos que é uma página digitalizada (imagem) e mandamos pro OCR.
const LIMIAR_CARACTERES_TEXTO_NATIVO = 20;

export interface PaginaExtraida {
  pagina: number;
  texto: string;
  origemOCR: boolean;
}

export interface ProgressoExtracao {
  paginaAtual: number;
  totalPaginas: number;
  etapa: "lendo_texto" | "ocr";
}

let ocrWorkerPromise: Promise<Worker> | null = null;

async function getOcrWorker(): Promise<Worker> {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker("por"); // português
  }
  return ocrWorkerPromise;
}

/** Libera o worker de OCR (chamar ao fim do processamento de um lote). */
export async function encerrarOcr(): Promise<void> {
  if (ocrWorkerPromise) {
    const worker = await ocrWorkerPromise;
    await worker.terminate();
    ocrWorkerPromise = null;
  }
}

async function ocrDaPagina(
  page: pdfjsLib.PDFPageProxy,
  escala = 2.2
): Promise<string> {
  const viewport = page.getViewport({ scale: escala });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Não foi possível criar contexto de canvas para OCR");

  await page.render({ canvasContext: ctx, viewport, canvas }).promise;

  const worker = await getOcrWorker();
  const { data } = await worker.recognize(canvas);
  return data.text;
}

/**
 * Extrai o texto de todas as páginas de um PDF (arquivo já em memória, File
 * ou ArrayBuffer). Faz fallback automático para OCR página a página.
 */
export async function extrairTextoPDF(
  arquivo: File,
  onProgresso?: (p: ProgressoExtracao) => void
): Promise<PaginaExtraida[]> {
  const buffer = await arquivo.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
  const totalPaginas = doc.numPages;
  const resultado: PaginaExtraida[] = [];

  for (let i = 1; i <= totalPaginas; i++) {
    const page = await doc.getPage(i);

    onProgresso?.({ paginaAtual: i, totalPaginas, etapa: "lendo_texto" });
    const conteudo = await page.getTextContent();
    const textoNativo = conteudo.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .trim();

    if (textoNativo.length >= LIMIAR_CARACTERES_TEXTO_NATIVO) {
      resultado.push({ pagina: i, texto: textoNativo, origemOCR: false });
    } else {
      onProgresso?.({ paginaAtual: i, totalPaginas, etapa: "ocr" });
      const textoOcr = await ocrDaPagina(page);
      resultado.push({ pagina: i, texto: textoOcr.trim(), origemOCR: true });
    }
  }

  return resultado;
}

/**
 * Quebra o texto de todas as páginas em chunks para embedding/RAG.
 *
 * Usa contagem de CARACTERES, não de palavras — importante porque o texto
 * extraído de tabelas em PDF às vezes vem "colado" sem espaços entre
 * células, o que faria uma divisão por palavras gerar um único "token"
 * gigante e estourar o limite de contexto do modelo de embedding. Aqui o
 * tamanho do chunk nunca ultrapassa `tamanhoAlvoChars`, mesmo sem espaços.
 */
export function dividirEmChunks(
  paginas: PaginaExtraida[],
  tamanhoAlvoChars = 3200,
  sobreposicaoChars = 400
): { pagina: number; texto: string }[] {
  const chunks: { pagina: number; texto: string }[] = [];

  for (const pagina of paginas) {
    const texto = pagina.texto.trim();
    if (texto.length === 0) continue;

    let inicio = 0;
    while (inicio < texto.length) {
      let fim = Math.min(inicio + tamanhoAlvoChars, texto.length);

      // Se não chegamos ao fim do texto, tenta cortar num espaço em vez de
      // no meio de uma palavra — procura o último espaço dentro da janela.
      if (fim < texto.length) {
        const ultimoEspaco = texto.lastIndexOf(" ", fim);
        // Só usa o espaço se ele não estiver perto demais do início (senão
        // o chunk ficaria minúsculo); caso contrário, aceita o corte "seco".
        if (ultimoEspaco > inicio + tamanhoAlvoChars * 0.5) {
          fim = ultimoEspaco;
        }
      }

      const trecho = texto.slice(inicio, fim).trim();
      if (trecho.length > 0) {
        chunks.push({ pagina: pagina.pagina, texto: trecho });
      }

      if (fim >= texto.length) break;
      inicio = Math.max(fim - sobreposicaoChars, inicio + 1);
    }
  }

  return chunks;
}
