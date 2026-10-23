import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {tickKeyframes,tickPresentation,tickVisible} from '../lib/axisTicks';
import {navigationKey} from '../lib/axisNavigation';

/** Execute the real animation owner and post-commit tick binding on one document clock. */
function fixture(){
  const created:{node:object;frames:Keyframe[];options:KeyframeAnimationOptions;animation:Animation;finish:()=>void;ready:(start:number)=>void;canceled:boolean}[]=[];
  class Host {
    parentElement:Host|null=null;children:Host[]=[];style={transform:'',visibility:''};
    constructor(readonly tag:string,readonly className:string,public x?:number,public textContent='23 Oct',readonly main=false){}
    append(...children:Host[]){this.children.push(...children);for(const child of children)child.parentElement=this;return this;}
    matches(selector:string){
      if(selector==='[data-plot-main]')return this.main;
      assert.match(selector,/^(?:\w+)?(?:\.[\w-]+)?$/,'the fixture must model each production selector');
      const [tag,name]=selector.split('.');return (!tag||tag===this.tag)&&(!name||this.className.split(' ').includes(name));
    }
    closest(selector:string):Host|null{for(let node:Host|null=this;node;node=node.parentElement)if(node.matches(selector))return node;return null;}
    querySelectorAll(selector:string):Host[]{
      const parts=selector.split(' '),all:Host[]=[];
      for(const child of this.children){child.parentElement=this;all.push(child,...child.querySelectorAll('*'));}
      if(selector==='*')return all;
      return all.filter(node=>{
        if(!node.matches(parts.at(-1)!))return false;
        let parent=node.parentElement;
        for(let i=parts.length-2;i>=0;i--){while(parent&&!parent.matches(parts[i]))parent=parent.parentElement;if(!parent)return false;parent=parent.parentElement;}
        return true;
      });
    }
    querySelector(selector:string){return this.querySelectorAll(selector)[0]??null;}
    getAttribute(name:string){assert.equal(name,'x');return String(this.x);}
    getComputedTextLength(){return 44;}
    animate(frames:Keyframe[],options:KeyframeAnimationOptions){
      let finish!:()=>void,ready!:()=>void;
      const row={node:this,frames,options,animation:null as unknown as Animation,finish:()=>finish(),ready:(start:number)=>{row.animation.startTime=start;ready();},canceled:false};
      row.animation={startTime:null,ready:new Promise<void>(resolve=>{ready=resolve;}),finished:new Promise<void>(resolve=>{finish=resolve;}),cancel:()=>{row.canceled=true;finish();}} as unknown as Animation;
      created.push(row);return row.animation;
    }
  }
  const node=(x?:number,text='23 Oct')=>new Host(x===undefined?'g':'text',x===undefined?'slides':'tick',x,text);
  const slides=[node(),node()],ticks=[node(60),node(200),node(700)];
  // PlotLayer keeps dates beside the main SVG data group. A separate data layer
  // has no dates, so its fold belongs to the enclosing HTML movement owner.
  const dates=new Host('g','time-ticks');dates.children=ticks;
  const owners=[new Host('div','plot-move',undefined,'',true).append(new Host('svg','').append(slides[0],dates)),new Host('div','plot-move').append(new Host('svg','').append(slides[1]))];
  const box=new Host('div','chart').append(...owners);
  const context={useRef:(current:unknown)=>({current}),useEffect:()=>{},useLayoutEffect:(run:()=>void)=>run(),
    box:{current:box},
    tickElements:{current:[]},tickGlyphs:{current:new WeakMap()},tickWidths:{current:new Map()},paintTicks:{current:()=>{}},animateTicks:{current:()=>[]},
    pose:{current:{a:1,b:0,offset:0}},drawing:{current:{from:0,to:100_000,end:100_000}},panLayers:{current:[]},
    width:720,left:48,right:12,scale:.73,motion:{current:null as unknown},foldTicket:{current:0},wanted:{current:{navigation:{context:'test',range:'live'}}},
    getComputedStyle:()=>({transform:'matrix(.72,0,0,1,13,0)'}),DOMMatrix:class {a=.72;e=13;},
    performance:{now:()=>1000},document:{timeline:{currentTime:1200 as number|null}},matchMedia:()=>({matches:false}),navigationKey,
    setFolding:()=>{},pan:{active:()=>null},tickKeyframes,tickPresentation,tickVisible,
    measure:null as unknown as ()=>void,animate:null as unknown as (start:{from:number;to:number;end:number},end:{from:number;to:number;end:number},duration:number,fold:boolean)=>void,
    freeze:null as unknown as ()=>void,cancel:null as unknown as ()=>void,animations:null as unknown as {current:Map<object,Animation>},
  };
  const source=readFileSync(new URL('../components/timeAxis.ts',import.meta.url),'utf8');
  const section=(start:string,end:string)=>{
    const from=source.indexOf(start),to=source.indexOf(end,from+start.length);
    assert.ok(from>=0&&to>from,`required production section: ${start} → ${end}`);
    return source.slice(from,to);
  };
  const owner=section('  const animations = ','  const source = ');
  const freeze=section('  const paintPan = ','  useLayoutEffect(() => pan.register');
  const projection=section('  const projectionOf = ','  const publishWanted = ');
  const measure=section('  useLayoutEffect(() => {\n    // Measure only after DOM commit.','\n  return {box, svg');
  runInNewContext(ts.transpileModule(owner+'\n'+freeze+'\n'+projection+'\nglobalThis.measure=()=>{'+measure+'};globalThis.animate=animateProjection;globalThis.freeze=freezeSlides;globalThis.cancel=cancelSlides;globalThis.animations=animations;',
    {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  context.measure();
  return {context,slides,ticks,owners,created,node,move:()=>context.animate({from:-20_000,to:60_000,end:60_000},{from:0,to:100_000,end:100_000},160,true)};
}

test('the actual data and unscaled date effects share one start, easing and lifetime',async()=>{
  const h=fixture();h.move();
  assert.equal(h.created.length,5,'two data layers and every actual committed tick animate');
  assert.equal(h.created[0].node,h.slides[0],'the SVG group beside dates owns its unscaled-date transition');
  assert.equal(h.created[1].node,h.owners[1],'the other data layer folds through its actual HTML movement owner');
  for(const row of h.created){assert.equal(row.animation.startTime,1200);assert.equal(row.options.duration,160);assert.equal(row.options.easing,'ease-out');}
  for(const row of h.created.filter(row=>h.ticks.includes(row.node as typeof h.ticks[0])))assert.ok(row.frames.every(frame=>!String(frame.transform).includes('scale')));
  const count=h.created.length;h.context.measure();assert.equal(h.created.length,count,'ordinary commits preserve the running label effects');
  h.created.forEach(row=>row.finish());await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(h.context.motion.current,null);assert.equal(h.context.animations.current.size,0);
  for(const tick of h.ticks)assert.equal(tick.style.transform,'translateX(0px)');
});

test('replacement, reshaped and reused dates join the original running data clock without replaying it',()=>{
  const h=fixture();h.move();
  const first=h.ticks[0],original=h.created[2];
  h.ticks[0]=h.node(70,'24 Oct');h.context.document.timeline.currentTime=1275;h.context.measure();
  assert.equal(original.canceled,true,'a detached label cannot retain an owned effect');
  assert.equal(h.context.animations.current.has(first),false);
  const replacement=h.created.at(-1)!;assert.equal(replacement.animation.startTime,1200,'replacement joins the original start rather than restarting at current time');
  assert.equal(h.created.length,6,'only the replacement effect is created');
  h.ticks[0].x=120;h.context.measure();assert.equal(replacement.canceled,true);assert.equal(h.created.length,7);
  assert.equal(h.created.at(-1)!.animation.startTime,1200);
  h.ticks[0].textContent='24 October';h.context.tickWidths.current.set('24 October',70);h.context.measure();
  assert.equal(h.created.length,8,'a changed glyph width gets its own whole-fit boundaries');
  assert.equal(h.created.at(-1)!.animation.startTime,1200);
  assert.equal(h.created[0].canceled,false);assert.equal(h.created[1].canceled,false,'the data effects never restart for label replacement');
  h.context.cancel();assert.equal(h.context.animations.current.size,0);assert.ok(h.created.every(row=>row.canceled));
});

test('reduced motion leaves visible interior labels and settles without date or data animations',()=>{
  const h=fixture();h.context.matchMedia=()=>({matches:true});h.move();
  assert.equal(h.created.length,0);assert.equal(h.context.motion.current,null);
  assert.equal(h.ticks[1].style.visibility,'');assert.equal(h.ticks[1].style.transform,'translateX(0px)');
  assert.equal(h.ticks[0].style.visibility,'hidden');assert.equal(h.ticks[2].style.visibility,'hidden');
});


test('an initially inactive document synchronizes replacement dates when its owned data timeline becomes ready',async()=>{
  const h=fixture();h.context.document.timeline.currentTime=null;h.move();
  h.ticks[0]=h.node(70);h.context.measure();
  assert.ok(h.created.every(row=>row.animation.startTime===null));
  h.created[0].ready(1300);await Promise.resolve();
  for(const animation of h.context.animations.current.values())assert.equal(animation.startTime,1300);
  assert.equal((h.context.motion.current as {started:number}).started,1300);
});

test('a superseded pending timeline cannot move the newer data or dates when its ready promise resolves',async()=>{
  const h=fixture();h.context.document.timeline.currentTime=null;h.move();const old=h.created[0];
  h.context.document.timeline.currentTime=1400;h.move();const newer=h.created.slice(5);
  old.ready(1300);await Promise.resolve();
  for(const row of newer)assert.equal(row.animation.startTime,1400);
  assert.equal((h.context.motion.current as {started:number}).started,1400);
});

test('interrupting the actual data projection freezes every date at the same sampled pose',()=>{
  const h=fixture();h.move();h.context.motion.current=null;h.context.freeze();
  assert.equal(h.context.animations.current.size,0);assert.ok(h.created.every(row=>row.canceled));
  for(const layer of h.slides)assert.equal(layer.style.transform,'translateX(13px) scaleX(0.72)');
  for(const tick of h.ticks){
    const expected=tickPresentation(tick.x!,44,{a:.72,b:13,offset:0},.73,48,708);
    assert.equal(tick.style.transform,expected.transform);assert.equal(tick.style.visibility,expected.visible?'':'hidden');
  }
});
