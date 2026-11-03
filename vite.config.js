import { defineConfig } from 'vite';

// Relative base so the built site works from any sub-path or static host.
export default defineConfig({ base: './', build: { chunkSizeWarningLimit: 1500 } });
