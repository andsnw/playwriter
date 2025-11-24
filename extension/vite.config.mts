import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const defineEnv: Record<string, string> = {};
if (process.env.TESTING) {
  defineEnv['import.meta.env.TESTING'] = 'true';
}

export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: resolve(__dirname, 'icons/*'),
          dest: 'icons'
        },
        {
          src: resolve(__dirname, 'manifest.json'),
          dest: '.',
          transform: (content) => {
            const manifest = JSON.parse(content);
            
            // Only include tabs permission during testing
            if (!process.env.TESTING) {
              manifest.permissions = manifest.permissions.filter((p: string) => p !== 'tabs');
            }
            
            return JSON.stringify(manifest, null, 2);
          }
        },
        {
          src: resolve(__dirname, 'welcome.html'),
          dest: '.'
        }
      ]
    })
  ],

  build: {
    lib: {
      entry: resolve(__dirname, 'src/background.ts'),
      fileName: 'lib/background',
      formats: ['es']
    },
    outDir: 'dist',
    emptyOutDir: false,
    minify: false
  },
  define: defineEnv
});
