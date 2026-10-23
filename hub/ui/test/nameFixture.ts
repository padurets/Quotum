import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
import * as jsxRuntime from 'react/jsx-runtime';

/** Extract the actual hook-free name renderer for the existing component VM fixtures. */
export function nameRenderer(runtime:object=jsxRuntime) {
  const source=readFileSync(new URL('../components/Kit.tsx',import.meta.url),'utf8');
  const ast=ts.createSourceFile('Kit.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const name=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='Name');
  assert.ok(name);
  const context={exports:{} as {Name:(props:{name:string})=>any},require:()=>runtime};
  runInNewContext(ts.transpileModule(name.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  return context.exports.Name;
}
