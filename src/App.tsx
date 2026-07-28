import { useState } from "react";
import "./App.css";
import type {
  AvaliacaoCriterio,
  ConfiguracaoOllama,
  MatrizAvaliacao,
  SessaoAvaliacao,
} from "./types";
import { importarMatriz, MatrizImportError } from "./lib/matrixImport";
import { dividirEmChunks, encerrarOcr, extrairTextoPDF } from "./lib/pdfExtract";
import { gerarEmbedding, testarConexao } from "./lib/ollama";
import { salvarChunks } from "./lib/vectorStore";
import { avaliarCriterios } from "./lib/avaliacaoEngine";
import { baixarBlob, gerarRelatorioDocx } from "./lib/docxExport";

type Etapa = "config" | "matriz" | "proposta" | "avaliando" | "revisao";

const CONFIG_PADRAO: ConfiguracaoOllama = {
  baseUrl: "http://localhost:11434",
  modeloChat: "qwen2.5:7b",
  modeloEmbedding: "nomic-embed-text",
};

function novoId() {
  return crypto.randomUUID();
}

export default function App() {
  const [etapa, setEtapa] = useState<Etapa>("config");
  const [cfg, setCfg] = useState<ConfiguracaoOllama>(CONFIG_PADRAO);
  const [statusConexao, setStatusConexao] = useState<
    { ok: boolean; mensagem: string } | null
  >(null);
  const [testando, setTestando] = useState(false);

  const [matriz, setMatriz] = useState<MatrizAvaliacao | null>(null);
  const [erroMatriz, setErroMatriz] = useState<string | null>(null);

  const [nomeProposta, setNomeProposta] = useState("");
  const [propostaId] = useState(novoId);
  const [avaliadorNome, setAvaliadorNome] = useState("");
  const [indexando, setIndexando] = useState(false);
  const [progressoIndexacao, setProgressoIndexacao] = useState("");
  const [prontoParaAvaliar, setProntoParaAvaliar] = useState(false);

  const [progressoAvaliacao, setProgressoAvaliacao] = useState("");
  const [sessao, setSessao] = useState<SessaoAvaliacao | null>(null);

  async function handleTestarConexao() {
    setTestando(true);
    setStatusConexao(null);
    try {
      const modelos = await testarConexao(cfg.baseUrl);
      const temChat = modelos.some((m) => m.startsWith(cfg.modeloChat.split(":")[0]));
      const temEmbed = modelos.some((m) =>
        m.startsWith(cfg.modeloEmbedding.split(":")[0])
      );
      setStatusConexao({
        ok: true,
        mensagem: `Conectado. Modelos instalados: ${modelos.join(", ") || "(nenhum)"}. ${
          temChat ? "" : `⚠ modelo de chat "${cfg.modeloChat}" não encontrado — rode "ollama pull ${cfg.modeloChat}". `
        }${temEmbed ? "" : `⚠ modelo de embedding "${cfg.modeloEmbedding}" não encontrado — rode "ollama pull ${cfg.modeloEmbedding}".`}`,
      });
    } catch (err) {
      setStatusConexao({ ok: false, mensagem: (err as Error).message });
    } finally {
      setTestando(false);
    }
  }

  async function handleImportarMatriz(arquivo: File) {
    setErroMatriz(null);
    try {
      const m = await importarMatriz(arquivo);
      setMatriz(m);
    } catch (err) {
      if (err instanceof MatrizImportError) setErroMatriz(err.message);
      else setErroMatriz("Erro inesperado ao ler a planilha: " + (err as Error).message);
    }
  }

  async function handleIndexarProposta(arquivos: FileList) {
    setIndexando(true);
    setProntoParaAvaliar(false);
    try {
      let arquivoIdx = 0;
      for (const arquivo of Array.from(arquivos)) {
        arquivoIdx++;
        const paginas = await extrairTextoPDF(arquivo, (p) => {
          setProgressoIndexacao(
            `Arquivo ${arquivoIdx}/${arquivos.length} (${arquivo.name}) — ` +
              `${p.etapa === "ocr" ? "OCR" : "lendo texto"} página ${p.paginaAtual}/${p.totalPaginas}`
          );
        });
        const chunks = dividirEmChunks(paginas);

        setProgressoIndexacao(
          `Gerando embeddings de ${chunks.length} trechos de ${arquivo.name}...`
        );
        const chunksComEmbedding = [];
        for (let i = 0; i < chunks.length; i++) {
          const c = chunks[i];
          const embedding = await gerarEmbedding(cfg, c.texto);
          chunksComEmbedding.push({
            id: novoId(),
            propostaId,
            arquivoOrigem: arquivo.name,
            pagina: c.pagina,
            texto: c.texto,
            embedding,
          });
          if (i % 5 === 0) {
            setProgressoIndexacao(
              `Gerando embeddings de ${arquivo.name}: ${i + 1}/${chunks.length}`
            );
          }
        }
        await salvarChunks(chunksComEmbedding);
      }
      await encerrarOcr();
      setProgressoIndexacao("Indexação concluída.");
      setProntoParaAvaliar(true);
    } catch (err) {
      setProgressoIndexacao("Erro na indexação: " + (err as Error).message);
    } finally {
      setIndexando(false);
    }
  }

  async function handleAvaliar() {
    if (!matriz) return;
    setEtapa("avaliando");
    const avaliacoes: AvaliacaoCriterio[] = await avaliarCriterios(
      cfg,
      propostaId,
      matriz.criterios,
      (p) =>
        setProgressoAvaliacao(
          `Critério ${p.criterioAtual}/${p.totalCriterios}: ${p.descricaoCriterio}`
        )
    );

    setSessao({
      id: novoId(),
      propostaId,
      matrizNomeArquivo: matriz.nomeArquivo,
      avaliadorNome,
      modeloIA: cfg.modeloChat,
      avaliacoes,
      criadoEm: new Date().toISOString(),
      atualizadoEm: new Date().toISOString(),
    });
    setEtapa("revisao");
  }

  function atualizarAvaliacao(criterioId: string, patch: Partial<AvaliacaoCriterio>) {
    setSessao((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        atualizadoEm: new Date().toISOString(),
        avaliacoes: prev.avaliacoes.map((a) =>
          a.criterioId === criterioId ? { ...a, ...patch } : a
        ),
      };
    });
  }

  async function handleExportar() {
    if (!sessao || !matriz) return;
    const blob = await gerarRelatorioDocx(sessao, matriz.criterios, nomeProposta);
    const nomeArquivo = `Avaliacao_${nomeProposta.replace(/\s+/g, "_")}_${new Date()
      .toISOString()
      .slice(0, 10)}.docx`;
    baixarBlob(blob, nomeArquivo);
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>CAP+ Web</h1>
        <p>Avaliação assistida por IA de propostas técnicas de OSS — SES-PE</p>
        <p className="aviso-privacidade">
          Nenhum dado da proposta ou da avaliação sai do seu computador. Toda a
          análise roda no seu navegador e no seu Ollama local.
        </p>
      </header>

      <nav className="passos">
        {(["config", "matriz", "proposta", "avaliando", "revisao"] as Etapa[]).map(
          (e, i) => (
            <span key={e} className={etapa === e ? "passo-ativo" : "passo"}>
              {i + 1}. {rotuloEtapa(e)}
            </span>
          )
        )}
      </nav>

      {etapa === "config" && (
        <section className="cartao">
          <h2>1. Conexão com o Ollama local</h2>
          <label>
            Endereço do Ollama
            <input
              value={cfg.baseUrl}
              onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })}
            />
          </label>
          <label>
            Modelo de chat (avaliação)
            <input
              value={cfg.modeloChat}
              onChange={(e) => setCfg({ ...cfg, modeloChat: e.target.value })}
            />
          </label>
          <label>
            Modelo de embedding
            <input
              value={cfg.modeloEmbedding}
              onChange={(e) => setCfg({ ...cfg, modeloEmbedding: e.target.value })}
            />
          </label>
          <button onClick={handleTestarConexao} disabled={testando}>
            {testando ? "Testando..." : "Testar conexão"}
          </button>
          {statusConexao && (
            <p className={statusConexao.ok ? "status-ok" : "status-erro"}>
              {statusConexao.mensagem}
            </p>
          )}
          <p className="ajuda">
            Se der erro de conexão, confirme que o Ollama está aberto e que a
            variável <code>OLLAMA_ORIGINS</code> inclui o endereço desta página.
          </p>
          <button
            className="botao-primario"
            onClick={() => setEtapa("matriz")}
            disabled={!statusConexao?.ok}
          >
            Avançar
          </button>
        </section>
      )}

      {etapa === "matriz" && (
        <section className="cartao">
          <h2>2. Importar matriz de avaliação (Excel)</h2>
          <input
            type="file"
            accept=".xlsx,.xls"
            onChange={(e) => e.target.files?.[0] && handleImportarMatriz(e.target.files[0])}
          />
          {erroMatriz && <p className="status-erro">{erroMatriz}</p>}
          {matriz && (
            <p className="status-ok">
              {matriz.criterios.length} critérios importados de {matriz.nomeArquivo}.
            </p>
          )}
          <div className="botoes">
            <button onClick={() => setEtapa("config")}>Voltar</button>
            <button
              className="botao-primario"
              onClick={() => setEtapa("proposta")}
              disabled={!matriz}
            >
              Avançar
            </button>
          </div>
        </section>
      )}

      {etapa === "proposta" && (
        <section className="cartao">
          <h2>3. Importar proposta técnica (PDF)</h2>
          <label>
            Nome da OSS / proponente
            <input value={nomeProposta} onChange={(e) => setNomeProposta(e.target.value)} />
          </label>
          <label>
            Seu nome (avaliador)
            <input value={avaliadorNome} onChange={(e) => setAvaliadorNome(e.target.value)} />
          </label>
          <input
            type="file"
            accept=".pdf"
            multiple
            onChange={(e) => e.target.files && handleIndexarProposta(e.target.files)}
          />
          {indexando && <p className="status-progresso">{progressoIndexacao}</p>}
          {!indexando && progressoIndexacao && (
            <p className="status-ok">{progressoIndexacao}</p>
          )}
          <div className="botoes">
            <button onClick={() => setEtapa("matriz")}>Voltar</button>
            <button
              className="botao-primario"
              onClick={handleAvaliar}
              disabled={!prontoParaAvaliar || !nomeProposta || indexando}
            >
              Rodar avaliação com IA
            </button>
          </div>
        </section>
      )}

      {etapa === "avaliando" && (
        <section className="cartao">
          <h2>Avaliando critérios...</h2>
          <p className="status-progresso">{progressoAvaliacao}</p>
        </section>
      )}

      {etapa === "revisao" && sessao && matriz && (
        <section className="cartao cartao-larga">
          <h2>4. Revisão das notas sugeridas pela IA</h2>
          <table className="tabela-revisao">
            <thead>
              <tr>
                <th>Critério</th>
                <th>Nota máx.</th>
                <th>Nota IA</th>
                <th>Justificativa da IA</th>
                <th>Nota final</th>
                <th>Observação</th>
              </tr>
            </thead>
            <tbody>
              {matriz.criterios.map((crit) => {
                const av = sessao.avaliacoes.find((a) => a.criterioId === crit.id);
                if (!av) return null;
                return (
                  <tr key={crit.id}>
                    <td>
                      <strong>{crit.grupo}</strong>
                      <br />
                      {crit.descricao}
                    </td>
                    <td>{crit.pontuacaoMaxima}</td>
                    <td>{av.notaSugeridaIA ?? "—"}</td>
                    <td className="celula-justificativa">{av.justificativaIA}</td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        max={crit.pontuacaoMaxima}
                        value={av.notaRevisada ?? av.notaSugeridaIA ?? 0}
                        onChange={(e) =>
                          atualizarAvaliacao(crit.id, {
                            notaRevisada: Number(e.target.value),
                            status: "revisado",
                          })
                        }
                      />
                    </td>
                    <td>
                      <textarea
                        value={av.observacaoAvaliador}
                        onChange={(e) =>
                          atualizarAvaliacao(crit.id, { observacaoAvaliador: e.target.value })
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="botoes">
            <button onClick={() => setEtapa("proposta")}>Voltar</button>
            <button className="botao-primario" onClick={handleExportar}>
              Exportar relatório (.docx)
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function rotuloEtapa(e: Etapa): string {
  switch (e) {
    case "config":
      return "Conexão";
    case "matriz":
      return "Matriz";
    case "proposta":
      return "Proposta";
    case "avaliando":
      return "Avaliação";
    case "revisao":
      return "Revisão";
  }
}
