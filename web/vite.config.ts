import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs, so the built client works whether the daemon serves it
  // at the root or a tunnel mounts it under a subpath.
  base: './',
  build: {
    outDir: 'dist',
    // xterm and CodeMirror are both chunky; the warning is expected here and
    // splitting them out would not help a client loaded once over a tunnel.
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
  },
});
