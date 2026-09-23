import {defineConfig} from 'vite';

// The licenses of what the bundle includes go next to it, served at /third-party-licenses.md.
export default defineConfig({build: {outDir: 'dist/client', emptyOutDir: false, license: {fileName: 'third-party-licenses.md'}}});
