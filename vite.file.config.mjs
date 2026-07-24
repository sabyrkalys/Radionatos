import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist-file-test',
    emptyOutDir: true,
    target: 'es2018',
    cssCodeSplit: false,
    lib: {
      entry: resolve(process.cwd(), 'app/main.ts'),
      name: 'RadiantOSApp',
      formats: ['iife'],
      fileName: () => 'radiantos-app.js'
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      }
    }
  }
});
