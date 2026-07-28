// Tipos centrais do CAP+ Web

export interface CriterioAvaliacao {
  id: string;
  grupo: string;          // ex: "Capacidade Técnica", "Qualificação da Equipe"
  descricao: string;
  pontuacaoMaxima: number;
  pesoRelativo?: number;
}

export interface MatrizAvaliacao {
  nomeArquivo: string;
  criterios: CriterioAvaliacao[];
  importadoEm: string; // ISO date
}

export interface ChunkDocumento {
  id: string;
  propostaId: string;
  arquivoOrigem: string;
  pagina: number;
  texto: string;
  embedding?: number[];
}

export interface PropostaImportada {
  id: string;
  nome: string; // nome da OSS / proponente
  arquivos: {
    nomeArquivo: string;
    totalPaginas: number;
    origemOCR: boolean; // true se passou por OCR (PDF digitalizado)
  }[];
  criadoEm: string;
}

export interface EvidenciaEncontrada {
  chunkId: string;
  arquivoOrigem: string;
  pagina: number;
  trecho: string;
  similaridade: number;
}

export interface AvaliacaoCriterio {
  criterioId: string;
  notaSugeridaIA: number | null;
  justificativaIA: string;
  evidencias: EvidenciaEncontrada[];
  notaRevisada: number | null; // preenchida pelo avaliador humano
  observacaoAvaliador: string;
  status: "pendente" | "avaliado_ia" | "revisado";
}

export interface SessaoAvaliacao {
  id: string;
  propostaId: string;
  matrizNomeArquivo: string;
  avaliadorNome: string;
  modeloIA: string;
  avaliacoes: AvaliacaoCriterio[];
  criadoEm: string;
  atualizadoEm: string;
}

export interface ConfiguracaoOllama {
  baseUrl: string;      // ex: http://localhost:11434
  modeloChat: string;   // ex: qwen2.5:7b
  modeloEmbedding: string; // ex: nomic-embed-text
}

export type StatusConvergencia = "convergente" | "inconsistente" | "nao_verificavel";

export interface ItemConvergenciaEdital {
  id: string;
  trechoEdital: string;
  arquivoEdital: string;
  paginaEdital: number;
  status: StatusConvergencia;
  explicacao: string;
  evidenciasProposta: EvidenciaEncontrada[];
}

export interface AnaliseConvergenciaEdital {
  editalNomeArquivos: string[];
  itens: ItemConvergenciaEdital[];
  geradoEm: string; // ISO date
}
