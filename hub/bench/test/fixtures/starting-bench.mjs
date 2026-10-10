import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';

// Only synthetic fixture preparation and SSE are replaced; entry point and lifecycle are real.
const demo = `
export const addressOf = () => ({base: 'http://127.0.0.1:1'});
export async function prepare() {}
export class Stop extends Error {}
export class Demo {
  dir = ".";
  async run() {return {people: new Map([['ana', {personalBoard: 'fixture', cookie: 'fixture=value'}]])};}
  async stop() {}
  async settled() {}
}`;
const replacements = {
  '../demo/index.js': demo,
  './stream.js': 'export async function hear() {return {close() {}};}',
  './fixture.js': 'export const panningSet = set => set; export function seedPanningBudgets() {}',
};
registerHooks({resolve(specifier, context, next) {
  if (replacements[specifier]) return {url: 'data:text/javascript,' + encodeURIComponent(replacements[specifier]), shortCircuit: true};
  return next(specifier, context);
}});
const entry = new URL('../../index.ts', import.meta.url);
process.argv[1] = fileURLToPath(entry);
process.argv.splice(2, Infinity, '--ci');
await import(entry.href);
