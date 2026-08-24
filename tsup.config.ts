import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.tsx' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  // Dependencies stay external and are installed from package.json; bundling
  // Ink and React pulls in their own resolution quirks for no benefit here.
  external: [
    'react',
    'ink',
    'ink-text-input',
    'ink-spinner',
    'dotenv',
    '@modelcontextprotocol/sdk',
  ],
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
  sourcemap: true,
});
