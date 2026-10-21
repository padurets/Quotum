import {SESSION_ANALYTICS} from './sessionAnalytics.js';
import {DAY,HOUR,type DemoSet} from './model.js';
import type {Stand} from './setup.js';
import type {Store} from '../server/store/store.js';
import type {Directory} from '../server/store/directory.js';
import {CATEGORY_COLORS as C} from '../server/domain/categoryColors.js';
import {saveProjectColors} from '../server/store/projectColors.js';
import {showWidgets} from '../server/domain/widgets.js';

/** Save/reset races and pending preparation are held by the projectColors regression tests. */
export const PROJECT_COLOR_SCENES=[
  {id:'pinned',expect:['project-color-pinned','project-color-manual-repeat','project-color-auto-displaced','project-color-absent-reservation']},
  {id:'reserved',expect:['project-color-overflow']},
  {id:'renamed',expect:['project-color-rename-merged']},
  {id:'capacity',expect:['project-color-capacity']},
  {id:'dormant',expect:['project-color-dormant-reset']},
] as const;
export const PROJECT_COLORS:DemoSet={...SESSION_ANALYTICS,id:'project-colors',about:'Pinned, repeated and automatic project colours, overflow, aliases and dormant reset',entries:[
  ...SESSION_ANALYTICS.entries,
  ...PROJECT_COLOR_SCENES.map(scene=>({kind:'board' as const,id:'colors-'+scene.id,name:{pinned:'Pinned project colours',reserved:'All colours reserved',renamed:'Merged project colours',capacity:'Project colour capacity',dormant:'Dormant colour reset'}[scene.id],owner:'ana',members:['boris'],agents:true,
    expect:[{state:'widgets' as const}],look:['Project colours are shared with Boris and editable only by Ana. Open Manage projects and edit a name and colour in the same popup. Check both languages and a narrow window; Auto and repeated swatches remain independent choices.']})),
]};

export function seedProjectColors(store:Store,directory:Directory,stand:Stand) {
  const owner=stand.people.get('ana')!,device=directory.devices(owner.id)[0],start=stand.start;
  for(const scene of PROJECT_COLOR_SCENES){
    const board=stand.boards.get('colors-'+scene.id)!;
    directory.saveView(board,showWidgets(directory.view(board),['agents','activity']),owner.id,start);
  }
  store.creditWork(device.id,start-3*DAY,start-3*DAY+HOUR,[{client:'opencode',source:null,origin:'terminal',startedAt:start-3*DAY,project:'older-project',folder:'',identity:{kind:'stable',sessionId:'9'.repeat(32)}}]);
  const save=(board:string,pins:Parameters<typeof saveProjectColors>[2])=>saveProjectColors(store.db,stand.boards.get(board)!,pins,owner.id,start);
  save('colors-pinned',[['quotum',C[7]],['checkout',C[7]],['migration-41',C[0]],['older-project',C[0]]]);
  save('ana',[['quotum',C[4]]]);
  save('colors-reserved',C.map((color,i)=>['migration-'+String(i+1).padStart(2,'0'),color]));
  save('colors-renamed',[['docs',C[0]],['web-dashboard',C[2]]]);
  // A merge retains the target and the source's dormant choice for a later split.
  store.nameProjects(owner.id,['docs'],'web-dashboard');
  const dormant=Array.from({length:89},(_,i):[string,typeof C[number]]=>['unavailable-fixture-'+i,C[0]]);
  save('colors-capacity',[['quotum',C[8]],...dormant.slice(0,88)]);
  save('colors-dormant',dormant);
}
