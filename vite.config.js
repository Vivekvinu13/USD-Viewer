import { defineConfig } from 'vite';

// Relative base so the built site works from any sub-path or static host.
export default defineConfig({ base: './', server: { proxy: { '/api': 'http://localhost:8000' } },
  preview: { proxy: { '/api': 'http://localhost:8000' } },
  build: { chunkSizeWarningLimit: 1500 } });
