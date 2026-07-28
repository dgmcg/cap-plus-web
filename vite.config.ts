import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// Em GitHub Pages, o site normalmente fica em
// https://<usuario>.github.io/<nome-do-repo>/ — então o "base" precisa ser
// "/<nome-do-repo>/". Ajuste VITE_BASE_PATH no workflow do GitHub Actions
// (ou aqui) para o nome real do repositório antes do deploy.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH || '/cap-plus-web/',
})
