import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
  },
  server: {
    fs: {
      allow: ['..'], // 允许访问上级目录的 src/core/
    },
  },
});
