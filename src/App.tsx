import { useRef, useState } from "react";
import "./App.css";
import type {
  AnaliseConvergenciaEdital,
  AvaliacaoCriterio,
  ConfiguracaoOllama,
  MatrizAvaliacao,
  SessaoAvaliacao,
} from "./types";
import { importarMatriz, MatrizImportError } from "./lib/matrixImport";
import { dividirEmChunks, encerrarOcr, extrairTextoPDF } from "./lib/pdfExtract";
import { gerarEmbeddingComDivisao, testarConexao } from "./lib/ollama";
import { salvarChunks } from "./lib/vectorStore";
import { avaliarCriterios } from "./lib/avaliacaoEngine";
import { analisarConvergenciaEdital } from "./lib/convergenciaEngine";
import { baixarBlob, gerarRelatorioDocx } from "./lib/docxExport";
import {
  gerarJsonAvaliacao,
  importarAvaliacaoJson,
  ImportacaoAvaliacaoError,
} from "./lib/exportImport";

type Etapa = "config" | "matriz" | "proposta" | "avaliando" | "revisao";

const CONFIG_PADRAO: ConfiguracaoOllama = {
  baseUrl: "http://localhost:11434",
  modeloChat: "qwen2.5:7b",
  modeloEmbedding: "nomic-embed-text",
};

// Tamanho padrão de cada pedaço do Edital (em caracteres) para a análise de
// convergência. Bem maior que o usado nos trechos da proposta (~3.200),
// de propósito — aqui a prioridade é ter poucos pedaços (poucas consultas
// sequenciais à IA), não granularidade fina.
const TAMANHO_PADRAO_TRECHO_EDITAL = 12000;

function novoId() {
  return crypto.randomUUID();
}

interface TrechoEdital {
  arquivoOrigem: string;
  pagina: number;
  texto: string;
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
  const [indexando, setIndexando] = useState(false);
  const [progressoIndexacao, setProgressoIndexacao] = useState("");
  const [prontoParaAvaliar, setProntoParaAvaliar] = useState(false);

  // Edital (opcional) — dividido em pedaços grandes e configuráveis, cada
  // um comparado com evidências buscadas na proposta (RAG), igual à
  // avaliação por critério, só que com pedaços bem maiores. Vários pedaços
  // são agrupados numa mesma consulta à IA (tamanhoLoteEdital) pra reduzir
  // ainda mais a quantidade de idas e vindas.
  const [tamanhoTrechoEdital, setTamanhoTrechoEdital] = useState(TAMANHO_PADRAO_TRECHO_EDITAL);
  const [tamanhoLoteEdital, setTamanhoLoteEdital] = useState(4);
  const [trechosEdital, setTrechosEdital] = useState<TrechoEdital[]>([]);
  const [nomesArquivosEdital, setNomesArquivosEdital] = useState<string[]>([]);
  const [processandoEdital, setProcessandoEdital] = useState(false);
  const [progressoEdital, setProgressoEdital] = useState("");

  const [progressoAvaliacao, setProgressoAvaliacao] = useState("");
  const [sessao, setSessao] = useState<SessaoAvaliacao | null>(null);
  const [convergencia, setConvergencia] = useState<AnaliseConvergenciaEdital | null>(null);
  const canceladoRef = useRef(false);
  const [cancelando, setCancelando] = useState(false);

  // Importação de uma avaliação já feita por outra pessoa (JSON) — permite
  // pular direto pra revisão, sem precisar de Ollama conectado.
  const [erroImportacaoJson, setErroImportacaoJson] = useState<string | null>(null);
  const [importando, setImportando] = useState(false);

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
      if (err instanceof MatrizImportError) {
        setErroMatriz(err.message);
      } else {
        setErroMatriz(
          "Não consegui ler este arquivo como planilha Excel (erro técnico: " +
            (err as Error).message +
            "). Isso costuma acontecer quando o arquivo não está num .xlsx " +
            "válido — por exemplo, é um .xls antigo salvo com extensão " +
            "errada, tem proteção de senha, ou foi corrompido na cópia. " +
            "Tente abrir a planilha no Excel e usar 'Arquivo > Salvar Como > " +
            "Pasta de Trabalho do Excel (*.xlsx)' com um nome novo, depois " +
            "importe esse arquivo novo."
        );
      }
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
        let trechosIgnorados = 0;
        for (let i = 0; i < chunks.length; i++) {
          const c = chunks[i];
          try {
            // Tenta gerar o embedding; se o trecho for grande demais pro
            // contexto do modelo, essa função divide automaticamente e
            // tenta de novo em pedaços menores, sem perder conteúdo.
            const partes = await gerarEmbeddingComDivisao(cfg, c.texto);
            for (const parte of partes) {
              chunksComEmbedding.push({
                id: novoId(),
                propostaId,
                arquivoOrigem: arquivo.name,
                pagina: c.pagina,
                texto: parte.texto,
                embedding: parte.embedding,
              });
            }
          } catch (err) {
            // Só chega aqui se nem dividindo repetidamente foi possível
            // (extremamente raro) — aí sim esse pedaço específico é
            // ignorado, para não travar a indexação inteira.
            trechosIgnorados++;
            console.warn(
              `Trecho ${i + 1} de ${arquivo.name} ignorado (erro ao gerar embedding):`,
              err
            );
          }
          if (i % 5 === 0) {
            setProgressoIndexacao(
              `Gerando embeddings de ${arquivo.name}: ${i + 1}/${chunks.length}` +
                (trechosIgnorados > 0 ? ` (${trechosIgnorados} trecho(s) ignorado(s))` : "")
            );
          }
        }
        await salvarChunks(chunksComEmbedding);
        if (trechosIgnorados > 0) {
          setProgressoIndexacao(
            `Atenção: ${trechosIgnorados} trecho(s) de ${arquivo.name} não puderam ` +
              "ser indexados mesmo após tentativas de divisão, e foram ignorados. " +
              "A avaliação pode ficar incompleta para partes desse documento."
          );
        }
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

  async function handleProcessarEdital(arquivos: FileList) {
    setProcessandoEdital(true);
    try {
      const novosTrechos: TrechoEdital[] = [];
      const novosNomes: string[] = [];
      let arquivoIdx = 0;
      for (const arquivo of Array.from(arquivos)) {
        arquivoIdx++;
        novosNomes.push(arquivo.name);
        const paginas = await extrairTextoPDF(arquivo, (p) => {
          setProgressoEdital(
            `Arquivo ${arquivoIdx}/${arquivos.length} (${arquivo.name}) — ` +
              `${p.etapa === "ocr" ? "OCR" : "lendo texto"} página ${p.paginaAtual}/${p.totalPaginas}`
          );
        });
        // Overlap proporcional (~8%) ao tamanho do pedaço escolhido.
        const sobreposicao = Math.round(tamanhoTrechoEdital * 0.08);
        const chunks = dividirEmChunks(paginas, tamanhoTrechoEdital, sobreposicao);
        for (const c of chunks) {
          novosTrechos.push({ arquivoOrigem: arquivo.name, pagina: c.pagina, texto: c.texto });
        }
      }
      await encerrarOcr();
      setTrechosEdital(novosTrechos);
      setNomesArquivosEdital(novosNomes);
      const totalConsultas = Math.ceil(novosTrechos.length / tamanhoLoteEdital);
      setProgressoEdital(
        `Edital processado: ${novosTrechos.length} trecho(s), agrupados de ` +
          `${tamanhoLoteEdital} em ${tamanhoLoteEdital} — são aproximadamente ` +
          `${totalConsultas} consulta(s) sequencial(is) à IA durante a avaliação ` +
          "(cada uma pode levar de dezenas de segundos a alguns minutos, dependendo da máquina)."
      );
    } catch (err) {
      setProgressoEdital("Erro ao processar o Edital: " + (err as Error).message);
    } finally {
      setProcessandoEdital(false);
    }
  }

  async function handleAvaliar() {
    if (!matriz) return;
    canceladoRef.current = false;
    setCancelando(false);
    setEtapa("avaliando");

    const avaliacoes: AvaliacaoCriterio[] = await avaliarCriterios(
      cfg,
      propostaId,
      matriz.criterios,
      (p) =>
        setProgressoAvaliacao(
          `Avaliando critérios — ${p.criterioAtual}/${p.totalCriterios}: ${p.descricaoCriterio}`
        ),
      () => canceladoRef.current
    );

    setSessao({
      id: novoId(),
      propostaId,
      matrizNomeArquivo: matriz.nomeArquivo,
      avaliadorNome: "",
      modeloIA: cfg.modeloChat,
      avaliacoes,
      criadoEm: new Date().toISOString(),
      atualizadoEm: new Date().toISOString(),
    });

    if (trechosEdital.length > 0 && !canceladoRef.current) {
      const itens = await analisarConvergenciaEdital(
        cfg,
        propostaId,
        trechosEdital,
        tamanhoLoteEdital,
        (p) =>
          setProgressoAvaliacao(
            `Analisando convergência com o Edital — trecho ${p.itemAtual}/${p.totalItens}`
          ),
        () => canceladoRef.current
      );
      setConvergencia({
        editalNomeArquivos: nomesArquivosEdital,
        itens,
        geradoEm: new Date().toISOString(),
      });
    } else {
      setConvergencia(null);
    }

    setEtapa("revisao");
  }

  function handleCancelar() {
    canceladoRef.current = true;
    setCancelando(true);
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

  function atualizarAvaliadorNome(nome: string) {
    setSessao((prev) => (prev ? { ...prev, avaliadorNome: nome } : prev));
  }

  async function handleExportarDocx() {
    if (!sessao || !matriz) return;
    const blob = await gerarRelatorioDocx(
      sessao,
      matriz.criterios,
      nomeProposta,
      convergencia ?? undefined
    );
    const nomeArquivo = `Avaliacao_${nomeProposta.replace(/\s+/g, "_")}_${new Date()
      .toISOString()
      .slice(0, 10)}.docx`;
    baixarBlob(blob, nomeArquivo);
  }

  function handleExportarJson() {
    if (!sessao || !matriz) return;
    const blob = gerarJsonAvaliacao(nomeProposta, matriz, sessao, convergencia ?? undefined);
    const nomeArquivo = `Avaliacao_IA_${nomeProposta.replace(/\s+/g, "_")}_${new Date()
      .toISOString()
      .slice(0, 10)}.json`;
    baixarBlob(blob, nomeArquivo);
  }

  async function handleImportarAvaliacao(arquivo: File) {
    setImportando(true);
    setErroImportacaoJson(null);
    try {
      const dados = await importarAvaliacaoJson(arquivo);
      setMatriz(dados.matriz);
      setSessao(dados.sessao);
      setNomeProposta(dados.nomeProposta);
      setConvergencia(dados.convergenciaEdital ?? null);
      setEtapa("revisao");
    } catch (err) {
      if (err instanceof ImportacaoAvaliacaoError) {
        setErroImportacaoJson(err.message);
      } else {
        setErroImportacaoJson("Erro inesperado ao importar: " + (err as Error).message);
      }
    } finally {
      setImportando(false);
    }
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
        <>
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

          <section className="cartao" style={{ marginTop: 16 }}>
            <h2>Já tem uma avaliação pronta?</h2>
            <p className="ajuda">
              Se outra pessoa já rodou a avaliação com IA e te enviou o arquivo{" "}
              <code>.json</code> exportado, importe aqui para ir direto pra revisão —
              não precisa estar conectado ao Ollama para revisar.
            </p>
            <input
              type="file"
              accept=".json"
              disabled={importando}
              onChange={(e) => e.target.files?.[0] && handleImportarAvaliacao(e.target.files[0])}
            />
            {importando && <p className="status-progresso">Importando...</p>}
            {erroImportacaoJson && <p className="status-erro">{erroImportacaoJson}</p>}
          </section>
        </>
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
        <>
          <section className="cartao">
            <h2>3. Importar proposta técnica (PDF)</h2>
            <label>
              Nome da OSS / proponente
              <input value={nomeProposta} onChange={(e) => setNomeProposta(e.target.value)} />
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
          </section>

          <section className="cartao" style={{ marginTop: 16 }}>
            <h2>3b. Edital (opcional) — análise de convergência</h2>
            <p className="ajuda">
              Se anexar o Edital, a IA varre o texto dele em pedaços e aponta, num
              âmbito geral, se a proposta está em conformidade ou se há
              inconsistências — separado da pontuação por critério da matriz.
            </p>
            <label>
              Tamanho de cada pedaço do Edital (caracteres)
              <input
                type="number"
                min={3000}
                step={1000}
                value={tamanhoTrechoEdital}
                onChange={(e) => setTamanhoTrechoEdital(Number(e.target.value))}
              />
            </label>
            <label>
              Quantos pedaços agrupar por consulta à IA
              <input
                type="number"
                min={1}
                max={10}
                value={tamanhoLoteEdital}
                onChange={(e) => setTamanhoLoteEdital(Number(e.target.value))}
              />
            </label>
            <p className="ajuda">
              Agrupar mais pedaços por consulta = menos idas e vindas à IA (mais
              rápido no total), mas cada consulta fica mais pesada e — em lotes muito
              grandes — o modelo pode errar o formato da resposta com mais frequência
              (o sistema reprocessa automaticamente item por item quando isso acontece,
              então nada se perde, só fica mais lento nesses casos). {tamanhoLoteEdital}{" "}
              é um valor equilibrado para começar.
            </p>
            <input
              type="file"
              accept=".pdf"
              multiple
              disabled={processandoEdital}
              onChange={(e) => e.target.files && handleProcessarEdital(e.target.files)}
            />
            {processandoEdital && <p className="status-progresso">{progressoEdital}</p>}
            {!processandoEdital && progressoEdital && (
              <p className="status-ok">{progressoEdital}</p>
            )}
          </section>

          <div className="botoes" style={{ marginTop: 16 }}>
            <button onClick={() => setEtapa("matriz")}>Voltar</button>
            <button
              className="botao-primario"
              onClick={handleAvaliar}
              disabled={!prontoParaAvaliar || !nomeProposta || indexando || processandoEdital}
            >
              Rodar avaliação com IA
            </button>
          </div>
        </>
      )}

      {etapa === "avaliando" && (
        <section className="cartao">
          <h2>Avaliando...</h2>
          <p className="status-progresso">{progressoAvaliacao}</p>
          {cancelando ? (
            <p className="status-erro">
              Cancelando após o item atual terminar — o que já foi avaliado não será
              perdido.
            </p>
          ) : (
            <button onClick={handleCancelar}>Cancelar</button>
          )}
        </section>
      )}

      {etapa === "revisao" && sessao && matriz && (
        <section className="cartao cartao-larga">
          <h2>4. Revisão das notas sugeridas pela IA</h2>

          <label>
            Nome do avaliador (quem está revisando agora)
            <input
              value={sessao.avaliadorNome}
              onChange={(e) => atualizarAvaliadorNome(e.target.value)}
            />
          </label>

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

          {convergencia && (
            <div style={{ marginTop: 28 }}>
              <h2>Análise de Convergência: Edital x Proposta</h2>
              <p className="ajuda">
                Edital(is): {convergencia.editalNomeArquivos.join(", ")} — verificação
                automática de conformidade geral, complementar à tabela de critérios acima.
              </p>
              <table className="tabela-revisao">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Trecho do Edital</th>
                    <th>Análise da IA</th>
                  </tr>
                </thead>
                <tbody>
                  {convergencia.itens.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <span className={`etiqueta-status etiqueta-${item.status}`}>
                          {rotuloStatusConvergencia(item.status)}
                        </span>
                        <br />
                        <small>
                          {item.arquivoEdital}, p. {item.paginaEdital}
                        </small>
                      </td>
                      <td className="celula-justificativa">
                        {item.trechoEdital.slice(0, 300)}
                        {item.trechoEdital.length > 300 ? "..." : ""}
                      </td>
                      <td className="celula-justificativa">{item.explicacao}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="botoes">
            <button onClick={() => setEtapa("proposta")}>Voltar</button>
            <button className="botao-primario" onClick={handleExportarDocx}>
              Exportar relatório (.docx)
            </button>
            <button onClick={handleExportarJson}>Exportar avaliação (.json)</button>
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

function rotuloStatusConvergencia(status: "convergente" | "inconsistente" | "nao_verificavel") {
  switch (status) {
    case "convergente":
      return "Convergente";
    case "inconsistente":
      return "Inconsistente";
    case "nao_verificavel":
      return "Não verificável";
  }
}
