import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {announcementLayout, fitting, graphemes, labelRoom, shortName} from '../components/Chart';

type Node={type:string;props:Record<string,any>};
function fixture() {
  let index=0,dirty=false,font='12px',broken=false,overrun=false,mapping=false;
  const slots:any[]=[],effects:(()=>void)[]=[];
  const calls={glyph:0,suffix:0,box:0,state:0};
  const jsx=(type:string,props:Node['props']):Node=>({type,props});
  const useRef=(value:unknown)=>slots[index++]??(slots[index-1]={current:value});
  const useState=(value:unknown)=>{const at=index++;if(!(at in slots))slots[at]=value;return [slots[at],(next:any)=>{const value=typeof next==='function'?next(slots[at]):next;if(value!==slots[at]){slots[at]=value;dirty=true;calls.state++;}}];};
  const useLayoutEffect=(run:()=>void,deps:unknown[])=>{const at=index++,old=slots[at];if(old&&deps.every((v,i)=>Object.is(v,old[i])))return;slots[at]=deps;effects.push(run);};
  const source=readFileSync(new URL('../components/Chart.tsx',import.meta.url),'utf8');
  const region=source.slice(source.indexOf('function MarkerLabel('),source.indexOf('/**\n * A label past',source.indexOf('function MarkerLabel(')));
  const context={exports:{} as {MarkerLabel:(props:Record<string,unknown>)=>Node},require:()=>({jsx,jsxs:jsx,Fragment:'fragment'}),useRef,useState,useLayoutEffect,graphemes,shortName,fitting,getComputedStyle:()=>({fontFamily:'Test',fontSize:font,fontWeight:'400',fontStyle:'normal',letterSpacing:'0px',fontStretch:'normal'})};
  runInNewContext(ts.transpileModule(`export ${region}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const refs=(node:Node)=>{if(!node?.props)return;const {ref,children}=node.props;
    if(ref)ref.current={
      getNumberOfChars:()=>String(children).length+(mapping?1:0),
      getSubStringLength:(_at:number,length:number)=>{calls.glyph++;if(broken)throw Error('font');return length*6;},
      getComputedTextLength:()=>{calls.suffix++;if(broken)throw Error('font');return String(children).length*6;},
      getBBox:()=>{calls.box++;if(broken)throw Error('font');const width=overrun?1000:String(children).length*6;return {x:Number(node.props.x)+(node.props.textAnchor==='end'?-width:0),width};},
    };
    (Array.isArray(children)?children:[children]).forEach(child=>{if(Array.isArray(child))child.forEach(refs);else refs(child);});
  };
  const render=(props:Record<string,unknown>)=>{let node:Node;for(let turns=0;turns<10;turns++){index=0;dirty=false;node=context.exports.MarkerLabel(props);refs(node);effects.splice(0).forEach(run=>run());if(!dirty)return node;}throw Error('label did not settle');};
  return {render,calls,font:(value:string)=>font=value,break:()=>broken=true,repair:()=>broken=false,overrun:()=>overrun=true,mapping:()=>mapping=true};
}
const props=(name='Team 🇷🇺 👩‍💻 e\u0301',suffix=' 12h →',room=120)=>({x:250,y:100,end:true,fonts:0,children:name+suffix,shorten:{name,say:(label:string)=>label+suffix,room,bounded:true}});
const text=(node:Node)=>node.props.children.find((child:Node)=>child?.type==='text');

test('actual label caches shaped name prefixes through movement, room and countdown changes',()=>{
  const f=fixture(),base=props();const initial=f.render(base),calls={...f.calls};
  assert.ok(calls.glyph>1);assert.equal(text(initial).props.textLength,undefined);
  for(let i=0;i<20;i++)f.render({...base,x:251+i,y:101+i,color:'#abcdef'});
  const moved={...f.calls};
  // The first colour installs the forecast font class once; hue and position do not.
  for(let i=0;i<20;i++)f.render({...base,x:300+i,y:140+i,color:'#fedcba'});
  assert.deepEqual(f.calls,moved);
  const priorGlyph=f.calls.glyph;
  f.render({...props(undefined,' 11h →',95),color:'#fedcba'});
  assert.equal(f.calls.glyph,priorGlyph,'suffix and available room reuse the name');
  f.font('14px');f.render({...base,fonts:1});assert.ok(f.calls.glyph>priorGlyph,'a loaded font measures its own prefixes');
});

test('failed SVG mapping, measurement and final shaping stay bounded and recover only on new inputs',()=>{
  for(const fail of ['break','mapping','overrun'] as const){
    const f=fixture();f[fail]();const base=props(),node=f.render(base),visible=text(node);
    assert.equal(visible.props.children,'… 12h →');assert.equal(visible.props.textLength,120);
    const rect=node.props.children.find((child:Node)=>child?.type==='rect');assert.equal(rect.props.width,132);assert.equal(rect.props.x,124);
    const calls={...f.calls};f.render({...base,x:260});assert.deepEqual(f.calls,calls,'position cannot retry a failed font');
    if(fail==='break'){f.repair();const recovered=f.render({...base,fonts:1});assert.equal(text(recovered).props.textLength,undefined);}
  }
});

test('inside and outside narrow backings remain in the plot and under its width budget',()=>{
  for(const width of [240,320,390,559]){const left=40,right=width-12,usable=right-left,budget=Math.min(180,usable*.6);
    assert.equal(labelRoom(usable)+12,budget);
    for(const at of [left,left+10,(left+right)/2,right-10,right]){
      const {x,end,room}=announcementLayout(at,left,right,true),start=x-(end?room:0)-6,stop=start+room+12;
      assert.ok(start>=left&&stop<=right);assert.ok(room+12<=budget);
    }
  }
});
