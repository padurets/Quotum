import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import * as runtime from 'react/jsx-runtime';
import ts from 'typescript';

/** Render the production JSX with the same automatic runtime as the app. */
export function plotLayerFixture() {
  const source = readFileSync(new URL('../components/PlotLayer.tsx', import.meta.url), 'utf8');
  const context = {exports: {}, require: (name: string) => {assertRuntime(name); return runtime;}};
  runInNewContext(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX}}).outputText, context);
  return context.exports as typeof import('../components/PlotLayer');
}

function assertRuntime(name: string) {
  if (name !== 'react/jsx-runtime') throw new Error(`unexpected plot dependency: ${name}`);
}
