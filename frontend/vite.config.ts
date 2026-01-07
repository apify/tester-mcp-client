import path from 'path';
import { fileURLToPath } from 'url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    resolve: {
        alias: {
            '@': path.resolve(dirname, 'src'),
        },
    },
    plugins: [
        react({
            babel: {
                sourceMaps: false,
            },
        }),
    ],
    esbuild: {
        sourcemap: false,
    },
    optimizeDeps: {
        esbuildOptions: {
            sourcemap: false,
        },
    },
    css: {
        devSourcemap: false,
    },
    root: dirname,
    base: './',
    build: {
        outDir: path.resolve(dirname, '../src/public'),
        emptyOutDir: true,
        sourcemap: false,
        rollupOptions: {
            output: {
                sourcemap: false,
            },
        },
    },
});
