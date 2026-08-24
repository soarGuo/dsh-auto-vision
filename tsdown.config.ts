/**
 * tsdown config for the dsh-auto-vision package: a single Node-side ESM build
 * (lib/index.js). The host loader entry imports it from the dsh profile tree;
 * every @deepseek-ai/dsh-* and cordis module resolves at runtime from the
 * profile module fallback, never bundled here.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-auto-vision',
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  // Keep lib/index.js (package.json "type": "module" already marks it ESM).
  fixedExtension: false,
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-settings',
    'schemastery',
  ],
})
