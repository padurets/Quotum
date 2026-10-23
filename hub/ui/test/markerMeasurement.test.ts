import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {announcementLayout, fitting, graphemes, labelRoom, shortName} from '../components/Chart';

type Node={type:string;props:Record<string,any>};
const content=(value:any):string=>Array.isArray(value)?value.map(content).join(''):typeof value==='string'||typeof value==='number'?String(value):value?.props?content(value.props.children):'';
function fixture() {
  let index=0,dirty=false,font='12px',broken=false,overrun=false,mapping=false;
  const slots:any[]=[],effects:(()=>void)[]=[],insertions:(()=>void)[]=[];
  const calls={glyph:0,suffix:0,box:0,state:0};
  const jsx=(type:string,props:Node['props']):Node=>({type,props});
  const useRef=(value:unknown)=>slots[index++]??(slots[index-1]={current:value});
  const useState=(value:unknown)=>{const at=index++;if(!(at in slots))slots[at]=value;return [slots[at],(next:any)=>{const value=typeof next==='function'?next(slots[at]):next;if(value!==slots[at]){slots[at]=value;dirty=true;calls.state++;}}];};
  const useLayoutEffect=(run:()=>void,deps:unknown[])=>{const at=index++,old=slots[at];if(old&&deps.every((v,i)=>Object.is(v,old[i])))return;slots[at]=deps;effects.push(run);};
  const useInsertionEffect=(run:()=>void)=>{index++;insertions.push(run);};
  const source=readFileSync(new URL('../components/Chart.tsx',import.meta.url),'utf8');
  const ast=ts.createSourceFile('Chart.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const boxes=ast.statements.find(node=>ts.isClassDeclaration(node)&&node.name?.text==='LabelBoxes');assert.ok(boxes);
  const region=source.slice(source.indexOf('function MarkerLabel('),source.indexOf('/**\n * A label past',source.indexOf('function MarkerLabel(')));
  const context={exports:{} as {MarkerLabel:(props:Record<string,unknown>)=>Node;boxes:object},require:()=>({jsx,jsxs:jsx,Fragment:'fragment'}),useRef,useState,useLayoutEffect,useInsertionEffect,graphemes,shortName,fitting,getComputedStyle:()=>({fontFamily:'Test',fontSize:font,fontWeight:'400',fontStyle:'normal',letterSpacing:'0px',fontStretch:'normal'})};
  runInNewContext(ts.transpileModule(`${boxes.getText(ast)}
export const boxes=new LabelBoxes();
export ${region}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  const refs=(node:Node)=>{if(!node?.props)return;const {ref,children}=node.props;
    if(ref)ref.current={
      getNumberOfChars:()=>content(children).length+(mapping?1:0),
      getSubStringLength:(_at:number,length:number)=>{calls.glyph++;if(broken)throw Error('font');return length*6;},
      getComputedTextLength:()=>{calls.suffix++;if(broken)throw Error('font');return content(children).length*6;},
      getBBox:()=>{calls.box++;if(broken)throw Error('font');const width=overrun?1000:content(children).length*6;return {x:Number(node.props.x)+(node.props.textAnchor==='end'?-width:0),width};},
    };
    (Array.isArray(children)?children:[children]).forEach(child=>{if(Array.isArray(child))child.forEach(refs);else refs(child);});
  };
  const render=(props:Record<string,unknown>)=>{let node:Node;for(let turns=0;turns<10;turns++){index=0;dirty=false;node=context.exports.MarkerLabel({boxes:context.exports.boxes,scale:1,...props});insertions.splice(0).forEach(run=>run());refs(node);effects.splice(0).forEach(run=>run());if(!dirty)return node;}throw Error('label did not settle');};
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


test('semantic forecast detail changes paint only after exact measured text and shortening are decided',()=>{
  let whole=0,partial=0,omitted=0;
  for(const room of [35,70,110,170,500]){
    const name='Owner · literal Gemini scope',base=props(name,' 12h →',room),plain=fixture(),parts=fixture();
    const old=plain.render(base),next=parts.render({...base,detailFrom:16});
    const oldText=text(old),newText=text(next);
    assert.equal(content(newText.props.children),content(oldText.props.children),'exact shown string must survive tspan segmentation');
    const before=old.props.children.find((child:Node)=>child?.type==='rect'),after=next.props.children.find((child:Node)=>child?.type==='rect');
    assert.deepEqual(JSON.parse(JSON.stringify(after.props)),JSON.parse(JSON.stringify(before.props)),'backing and fit remain exact');
    assert.deepEqual(parts.calls,plain.calls,'segmentation adds no glyph or layout measurements');
    const nodes=(value:any):Node[]=>Array.isArray(value)?value.flatMap(nodes):value?.props?[value,...nodes(value.props.children)]:[];
    const detail=nodes(newText.props.children).find(node=>node.type==='tspan');
    if(detail){assert.deepEqual(Object.keys(detail.props).sort(),['children','fill']);assert.equal(detail.props.fill,'var(--text-3)');if(content(detail.props.children).includes('…'))partial++;else whole++;}
    else omitted++;
  }
  assert.ok(whole&&partial&&omitted,'full, shortened-detail and omitted-detail paths are exercised');
});
