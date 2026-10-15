import {DAY,HOUR,MIN,steady,weekly,type Agent,type DemoSet} from './model.js';

const devices=['laptop','workstation','build-server','mac-studio','windows-workstation'];
const names=['quotum','web-dashboard','desktop-client','billing','checkout','docs','terraform','notifications','ios-app','android-app','on-call','release-tools',
  ...Array.from({length:41},(_,i)=>`migration-${String(i+1).padStart(2,'0')}`)];
const current=(project:string|null,i:number,folder?:string):Agent=>{
  const on=(15+i%5*15)*MIN;
  return {machine:devices[i%devices.length],origin:i%3?'terminal':'editor',project,folder,since:-6*DAY-i*MIN,
    works:{period:DAY,on,phase:-on/2}};
};
const sessions:Agent[]=[
  ...names.map((name,i)=>current(name,i,`${name}.feat-${i+1}`)),
  // These contexts have credited work but are absent from the current roster.
  // Atlas alone fills two disclosure pages, across all machines and subscriptions.
  ...Array.from({length:64},(_,i):Agent=>({machine:devices[i%devices.length],origin:i%2?'terminal':'editor',project:'atlas',
    folder:`atlas.feat-${String(i+1).padStart(2,'0')}`,since:-16*HOUR-i*MIN,until:-2*HOUR,
    works:{period:DAY,on:(60+i%5*15)*MIN,phase:-8*HOUR+i%4*15*MIN}})),
  ...Array.from({length:3},(_,i)=>current('atlas',i,'atlas.live-'+(i+1))),
  ...Array.from({length:3},(_,i):Agent=>({machine:devices[(i+2)%devices.length],origin:'terminal',project:'harbor',folder:`harbor.release-${i+1}`,
    since:-20*HOUR,until:-HOUR,works:{period:DAY,on:(i?2:4)*HOUR,phase:-(9-i)*HOUR}})),
  current('platform-monorepo/services/billing-reconciliation-worker/migrations/2026-10-backfill-invoices-with-missing-tax-regions',3,'billing-reconciliation-worker.feat-backfill'),
  current(null,4),
];
const subscriptions=[
  {id:'sessions-codex-pro',provider:'codex',plan:'pro',name:'Codex Pro'},
  {id:'sessions-claude-max',provider:'claude',plan:'max',name:'Claude Max'},
  {id:'sessions-codex-plus',provider:'codex',plan:'plus',name:'Codex Plus'},
  {id:'sessions-antigravity',provider:'antigravity',plan:'ultra',name:'Antigravity'},
] as const;

/** A review starts with populated 24h tables, without choosing a special past week. */
export const SESSION_ANALYTICS:DemoSet={
  id:'sessions',about:'Session comparisons: 57 projects, six machines, mixed clients and four subscriptions and retained-session pagination',scene:'quiet',workHistoryMs:7*DAY,
  entries:[
    {kind:'person',id:'ana',name:'Ana',agents:true,agentsPlace:{x:0,y:0,w:6,h:12},agentsColumns:['client','subscription','active','concurrency'],
      places:{activity:{x:0,y:1,w:6,h:12},'quota-history':{x:0,y:2,w:6,h:12},'quota-table':{x:0,y:3,w:6,h:12}},
      expect:[{state:'widgets'}],look:[
        'The default 24h period has 57 projects and 129 recorded contexts (125 mapped sessions plus four OpenCode and other-client contexts). Agent sessions includes active time and average concurrency alongside its existing columns, with whole-row height fitting and a bottom-right pager; all totals cover the entire selected period.',
        'Wide tables sort in their headers; the third activation clears the chosen sort. Only narrow lists show the sort menu. No widget has an inner vertical scroller or a more/all popup.',
        'Atlas has 67 contributing contexts, including 64 absent from the current roster; its disclosure has two pages. Harbor has three retained contexts with overlapping work.',
        'Machine and subscription grouping show six and five populated rows on the personal board. All three groupings retain the same total; active time is a union rather than a sum of rows.',
        'The chart legend can mute Atlas without changing the table. Both table and chart remain populated over 7d, while 30d explains the seven-day coverage.',
        'The long project and worktree names wrap on a narrow screen. A projectless context uses the shared No project label.',
        'Sessions only has no cards and uses neutral Not provided and Not identified categories. Subscriptions only keeps quota cards while every device’s sessions are off. The hidden-card board retains all admitted sessions; Subscription provided later keeps pre-grant work outside quota attribution. OpenCode and review-assistant share quotum with mapped clients, including a disconnected retained device.',
        'The fixed interval from four to two hours before the stand started is known and empty; the interval nine to eight days before it is unknown.',
      ]},
    {kind:'person',id:'boris',name:'Boris',expect:[{state:'onboarding'}]},
    ...['sessions-only','quota-only','both','off','hidden','historical'].map(id=>({kind:'board' as const,id,name:{'sessions-only':'Sessions only','quota-only':'Subscriptions only',both:'Sessions and subscriptions',off:'Device sessions off',hidden:'Hidden subscription cards',historical:'Subscription provided later'}[id]!,owner:'ana',members:['boris'],agents:true,agentsColumns:['client','subscription','active','concurrency'],expect:[{state:'widgets' as const}],look:['Device session access defaults on independently of subscriptions; Provided data lists the owner’s devices, including disconnected retained history.']})),
    ...devices.map((id,i)=>({kind:'machine' as const,id,renamed:['Laptop','Workstation','Build server','Mac Studio','Windows workstation'][i],
      os:i===3?'macos' as const:i===4?'windows' as const:'linux' as const,expect:[{via:'token' as const}]})),
    ...subscriptions.map((s,i)=>({kind:'card' as const,id:s.id,provider:s.provider,account:'pseudonym' as const,plan:s.plan,machines:devices,history:7*DAY,
      windows:[weekly({since:-6*DAY,use:steady(0,5+i*2)})],agents:sessions.filter((_,index)=>index%subscriptions.length===i),
      on:{ana:{name:s.name},'quota-only':{name:s.name},both:{name:s.name},hidden:{name:s.name,hidden:true},historical:{name:s.name}},expect:[{title:s.name}]})),
  ],
};
