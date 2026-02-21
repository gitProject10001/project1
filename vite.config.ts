import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        hybrid: resolve(__dirname, 'hybrid.html'),
        unified: resolve(__dirname, 'unified.html'),
      },
    },
  },
});
