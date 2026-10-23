import {test} from 'node:test';
import assert from 'node:assert/strict';
import {heatDateLabel,heatIntervalLabel} from '../lib/heatmap';
import {exactAgentHours} from '../lib/workCalendar';

test('heatmap labels share formatters while preserving both languages and repeated-hour offsets',t=>{
  const H=3_600_000,from=Date.parse('2026-11-01T05:00Z'),rows=[];
  for(const locale of ['en-GB','ru-RU'])for(let i=0;i<10;i++)for(const zone of ['UTC','America/New_York']){
    const repeated=zone!=='UTC',item={from:from+i*60_000,to:from+2*H+i*60_000,repeated,dayRange:{from:from-H,to:from+24*H}},date='2026-11-'+String(i+1).padStart(2,'0');
    const day=new Intl.DateTimeFormat(locale,{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(date+'T12:00Z'));
    const clock=new Intl.DateTimeFormat(locale,{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23',...(repeated?{timeZoneName:'shortOffset'}:{})});
    rows.push({locale,zone,item,date,day,interval:clock.format(item.from)+' — '+clock.format(item.to)});
  }
  let made=0;const original=Intl.DateTimeFormat;
  t.mock.method(Intl,'DateTimeFormat',new Proxy(original,{construct(target,args,newTarget){made++;return Reflect.construct(target,args,newTarget);}}));
  for(const row of rows){
    assert.equal(heatDateLabel(row.date,row.locale),row.day);
    assert.equal(heatIntervalLabel(row.item,2*H,row.zone,row.locale),row.interval);
    const day={...row.item,...row.item.dayRange,repeated:false};
    assert.equal(heatIntervalLabel(day,25*H,row.zone,row.locale),'');
  }
  assert.equal(made,6,'two date formats and four clock formats serve every bucket');
});

test('exact heatmap hours reuse number formats without rounding through floating point',t=>{
  let made=0;const original=Intl.NumberFormat;
  t.mock.method(Intl,'NumberFormat',new Proxy(original,{construct(target,args,newTarget){made++;return Reflect.construct(target,args,newTarget);}}));
  for(let i=0;i<20;i++)for(const [locale,separator] of [['en-GB','.'],['ru-RU',',']]){
    assert.equal(exactAgentHours(1,locale),'0'+separator+'000000278');
    assert.equal(exactAgentHours(3_600_000_000_001,locale),'1000000'+separator+'000000278');
    assert.equal(exactAgentHours(0,locale),'0');
  }
  assert.equal(made,2,'formatting another value does not construct another locale formatter');
});
