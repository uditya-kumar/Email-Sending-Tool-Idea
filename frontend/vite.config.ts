import path from 'node:path'
import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Domain types, the merge-tag renderer and the IST helpers are compiled by
      // both packages from one source (see shared/). The server resolves the
      // same files through tsconfig; Vite needs it spelled out here.
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
})
