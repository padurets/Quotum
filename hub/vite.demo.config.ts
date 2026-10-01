import {defineConfig} from 'vite';

// An isolated settings fixture; never included in the hub's client or desktop bundle.
export default defineConfig({root:'demo/ui', build:{outDir:'../../dist/demo', emptyOutDir:true}});
