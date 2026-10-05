import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';

// Replace only demo seeding and SSE; the entry point and browser launcher remain real.
const demo = `
export const addressOf = () => ({base: 'http://127.0.0.1:1'});
export async function prepare() {}
export class Stop extends Error {}
export class Demo {
  async run() {return {people: new Map([['ana', {personalBoard: 'fixture-board', cookie: 'fixture=value'}]])};}
  async stop() {}
  async settled() {}
}`;
const stream = 'export async function hear() {return {close() {}};}';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '../demo/index.js') return {url: 'data:text/javascript,' + encodeURIComponent(demo), shortCircuit: true};
    if (specifier === './stream.js') return {url: 'data:text/javascript,' + encodeURIComponent(stream), shortCircuit: true};
    return next(specifier, context);
  },
});
const entry = new URL('../../index.ts', import.meta.url);
process.argv[1] = fileURLToPath(entry);
process.argv.splice(2, Infinity, '--ci');
await import(entry.href);
