import {test} from 'node:test';
import assert from 'node:assert/strict';
import {guardNavigation, navigate, onLocation, selectedBoard, settingsHref} from '../lib/router';
import {onTimeRange, showBoard, timeRange} from '../lib/timeRange';

test('Back restores its own board and range after settings instead of rewriting the URL', () => {
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  const events = new EventTarget();
  let url = new URL('http://fixture.example/?board=A&from=1800000000000&to=1800003600000');
  const history = {pushState: (_state: unknown, _title: string, href: string) => {url = new URL(href, url);}, replaceState: (_state: unknown, _title: string, href: string) => {url = new URL(href, url);}};
  Object.defineProperties(globalThis, {location: {configurable: true, get: () => url}, history: {configurable: true, value: history}, window: {configurable: true, value: events}, PopStateEvent: {configurable: true, value: Event}});
  let changes = 0;
  const stop = onLocation(() => changes++), stopRange = onTimeRange(() => {});
  try {
    let remaining = 0;
    const off = onTimeRange(() => {}), last = onTimeRange(() => remaining++);
    off();
    showBoard('A');
    navigate(settingsHref('/settings/connections'));
    assert.equal(url.pathname, '/settings/connections');
    assert.equal(url.searchParams.get('board'), 'A');
    assert.deepEqual(timeRange(), {from: 1800000000000, to: 1800003600000});
    assert.equal(selectedBoard(), 'A');
    navigate('/?board=B&from=1800007200000&to=1800010800000'); showBoard('B');
    history.pushState(null, '', '/?board=A&from=1800000000000&to=1800003600000');
    events.dispatchEvent(new Event('popstate'));
    assert.equal(url.searchParams.get('board'), 'A', 'the previous screen cannot overwrite the popped location');
    assert.deepEqual(timeRange(), {from: 1800000000000, to: 1800003600000});
    assert.equal(changes, 3);
    assert.equal(remaining, 2, 'one chart unmounting cannot detach the other range readers');
    last();
  } finally {
    stop(); stopRange();
    for (const key of ['location', 'history', 'window', 'PopStateEvent']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('dirty navigation restores the exact history entry before asking, and confirms Back without duplicating it',()=>{
  const previous=Object.getOwnPropertyDescriptors(globalThis),events=new EventTarget();
  let index=0,entries=[{url:new URL('http://fixture.example/?board=A&from=10&to=20'),state:null as unknown}];
  const history={get state(){return entries[index].state;},pushState(state:unknown,_title:string,href:string){entries.splice(index+1);entries.push({url:new URL(href,entries[index].url),state});index++;},replaceState(state:unknown,_title:string,href:string){entries[index]={url:new URL(href,entries[index].url),state};},go(delta:number){index+=delta;events.dispatchEvent(new Event('popstate'));}};
  Object.defineProperties(globalThis,{location:{configurable:true,get:()=>entries[index].url},history:{configurable:true,value:history},window:{configurable:true,value:events},PopStateEvent:{configurable:true,value:Event}});
  let changes=0,proceed:(()=>void)|undefined;const stop=onLocation(()=>changes++);
  try {
    navigate('/settings/currencies?board=A&from=10&to=20');
    const off=guardNavigation(go=>{proceed=go;});
    history.go(-1);assert.equal(index,1);assert.equal(entries[index].url.pathname,'/settings/currencies');assert.equal(changes,1);
    proceed=undefined;history.go(-1);assert.equal(index,1);proceed!();assert.equal(index,0);assert.equal(entries.length,2);assert.equal(entries[index].url.search,'?board=A&from=10&to=20');assert.equal(changes,2);
    off();history.go(1);assert.equal(entries[index].url.pathname,'/settings/currencies');
  }finally{stop();for(const key of ['location','history','window','PopStateEvent']){if(previous[key])Object.defineProperty(globalThis,key,previous[key]);else Reflect.deleteProperty(globalThis,key);}}
});
