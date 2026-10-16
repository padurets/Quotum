import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {setLocale,t} from '../i18n';

type Node={type:unknown;props:Record<string,any>};
const nodes=(value:unknown):Node[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&'props' in value?[value as Node,...nodes((value as Node).props.children)]:[];

test('resource disclosures expire positive observations, including unlimited funds, at the shared clock boundary',()=>{
  let now=99,changesAt:(now:number)=>number|null=()=>null;
  const jsx=(type:unknown,props:Node['props'])=>({type,props});
  const context={exports:{} as {ResourceOrigins:(props:any)=>unknown},require:(name:string)=>{
    if(name==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'fragment'};
    if(name.endsWith('/clock'))return {useClock:(deadline:typeof changesAt)=>{changesAt=deadline;return now;}};
    if(name.endsWith('/i18n'))return {t};
    if(name.endsWith('/format'))return {stamp:(at:number)=>String(at)};
    if(name==='lucide-react')return {Info:'info'};
    return {};
  }};
  const source=ts.transpileModule(readFileSync(new URL('../components/MeasurementDevices.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  runInNewContext(source+'\nexports.ResourceOrigins=ResourceOrigins;',context);
  const valueOrigin={device:'a',at:1,client:'1.2.3'},observationOrigin={device:'b',at:2,client:'1.2.4'};
  for(const locale of ['en','ru'] as const) {
    setLocale(locale);
    for(const status of ['observed','finite','unlimited','missing','unsupported','invalid','unknown'] as const)for(const at of [99,100,101]) {
      now=at;
      const tree=nodes(context.exports.ResourceOrigins({origin:{resource:status==='observed'?'quotas':'funds',status,staleAt:100,valueOrigin,observationOrigin}}));
      const expected=at===101&&['observed','finite','unlimited'].includes(status)?'stale':status;
      assert.equal(tree.find(node=>node.props['data-time']!==undefined)!.props.children,t(`measurements.status.${expected}`),`${locale}/${status}/${at}`);
      assert.equal(changesAt(at),at<=100?101:null);
      assert.deepEqual(tree.filter(node=>typeof node.type==='function'&&'origin' in node.props).map(node=>node.props.origin),[valueOrigin,observationOrigin],'value and observation anchors remain independent');
    }
  }
  setLocale('en');
});
