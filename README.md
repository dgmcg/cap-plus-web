# CAP+ Web — núcleo (fase 1)

Versão web do CAP+ (avaliação assistida por IA de propostas técnicas de OSS,
SES-PE). Roda inteiramente no navegador: nenhum dado de proposta ou de
avaliação passa pelo servidor de hospedagem — só o código estático da
aplicação fica lá.

## O que está implementado nesta fase (núcleo)

- Importação da matriz de avaliação (Excel)
- Importação de proposta técnica em PDF (multi-arquivo), com extração de
  texto via PDF.js e fallback automático para OCR (Tesseract.js) em páginas
  digitalizadas
- Indexação local dos trechos extraídos (embeddings via Ollama, armazenados
  no IndexedDB do navegador — substitui o LanceDB)
- Avaliação de cada critério via RAG contra o Ollama local, com justificativa
  e citação da evidência (arquivo + página)
- Revisão humana das notas sugeridas
- Exportação do relatório final em .docx (gerado no navegador)

Ainda não incluído nesta fase (ficam para depois, conforme combinado):
consolidação entre múltiplos avaliadores, chat de dúvidas sobre evidências,
integração com Google Sheets/Drive.

## Pré-requisitos no computador do avaliador

1. **Ollama instalado e rodando**, com os modelos baixados:
   ```
   ollama pull qwen2.5:7b
   ollama pull nomic-embed-text
   ```
2. **Liberar a origem desta página no Ollama.** Por padrão o Ollama só aceita
   pedidos de `localhost`. É preciso configurar a variável de ambiente
   `OLLAMA_ORIGINS` com o endereço onde a versão web vai ficar publicada.

   **Windows** (PowerShell, como administrador, configuração permanente):
   ```powershell
   [System.Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS', 'https://SEU-USUARIO.github.io', 'Machine')
   ```
   Depois, reinicie o Ollama (feche pelo ícone na bandeja e abra de novo).

   **macOS:**
   ```bash
   launchctl setenv OLLAMA_ORIGINS "https://SEU-USUARIO.github.io"
   ```

   **Linux (systemd):** edite o serviço do Ollama e adicione
   `Environment="OLLAMA_ORIGINS=https://SEU-USUARIO.github.io"`, depois
   `systemctl daemon-reload && systemctl restart ollama`.

   Troque `https://SEU-USUARIO.github.io` pelo endereço real depois que a
   página estiver publicada no GitHub Pages (passo abaixo). Se quiser testar
   várias origens (produção + desenvolvimento local), separe por vírgula, sem
   espaços.

   Para os ~10 usuários, o ideal é empacotar isso num pequeno script `.bat`
   (Windows) de configuração de máquina, em vez de pedir que cada um digite o
   comando manualmente. Posso gerar esse script assim que o endereço final da
   página estiver definido.

## Rodando localmente (desenvolvimento)

```bash
npm install
npm run dev
```

Abre em `http://localhost:5173`. Para essa URL específica, o Ollama já aceita
por padrão (localhost), então não precisa mexer em `OLLAMA_ORIGINS` para
testar localmente.

## Publicando no GitHub Pages

1. Crie um repositório no GitHub (ex.: `cap-plus-web`) e suba este código.
2. Em **Settings → Pages**, em "Build and deployment", selecione
   **GitHub Actions** como fonte (o workflow em
   `.github/workflows/deploy.yml` já está pronto).
3. Confira se `VITE_BASE_PATH` no workflow bate com o nome do repositório
   (ex.: `/cap-plus-web/`). Se o repositório se chamar diferente, ajuste essa
   linha antes do primeiro deploy.
4. Faça push para a branch `main` — o deploy roda automaticamente.
5. O endereço final será algo como
   `https://SEU-USUARIO.github.io/cap-plus-web/`. Use exatamente esse
   endereço no `OLLAMA_ORIGINS` de cada máquina.

## Ponto de atenção a validar cedo

O GitHub Pages serve em HTTPS. Chamar `http://localhost:11434` (Ollama) a
partir de uma página HTTPS **normalmente funciona**, porque os navegadores
tratam `localhost` como contexto seguro — mas isso deve ser testado
especificamente na imagem/política de navegador padrão da SES-PE antes de um
rollout maior, porque políticas de grupo corporativas às vezes reforçam
regras adicionais de conteúdo misto.

## Estrutura do código

```
src/
  types.ts               tipos centrais (critério, proposta, avaliação...)
  lib/
    ollama.ts             cliente do Ollama local (chat + embeddings)
    pdfExtract.ts          extração de texto + OCR (PDF.js + Tesseract.js)
    vectorStore.ts         armazenamento vetorial local (IndexedDB)
    matrixImport.ts        leitura da planilha de matriz (SheetJS)
    avaliacaoEngine.ts      RAG + prompt de avaliação por critério
    docxExport.ts           geração do relatório final em Word
  App.tsx                  fluxo da aplicação (wizard de 5 passos)
```
