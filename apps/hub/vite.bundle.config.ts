import {defineConfig} from 'vite';

// The server as one file with everything it imports, for the desktop app, which carries
// the hub without node_modules. Built from the compiled server (`npm run build` first):
// dist/app/server.mjs finds dist/client and package.json the way dist/server/index.js does.
// The licenses of what it includes go next to it.
export default defineConfig({
  publicDir: false,
  ssr: {noExternal: true},
  build: {
    ssr: 'dist/server/index.js',
    outDir: 'dist/app',
    emptyOutDir: true,
    target: 'node24',
    minify: true,
    license: {fileName: 'server-licenses.md'},
    rolldownOptions: {output: {entryFileNames: 'server.mjs', codeSplitting: false}},
  },
});
