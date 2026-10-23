import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

test('the native return path uses the displayed SVG projection after a historical handoff',()=>{
  const source=readFileSync(new URL('../panning.ts',import.meta.url),'utf8');
  const template=source.match(/const returnPixels = await cdp\.evaluate<number>\(`([\s\S]+?)`\);/)![1];
  const expression=new Function('selector','inset','initiator','return `'+template+'`;')('[data-widget="quota-history"]',52,'quota');
  for(const composedScale of [.4,.7,1]){
    const svg={dataset:{drawFrom:'500',drawTo:'2500'},viewBox:{baseVal:{width:900}},parentElement:{querySelector:()=>({getScreenCTM:()=>({a:composedScale})})},getBoundingClientRect:()=>{throw Error('the semantic frame cannot reconstruct the retained projection');}};
    const pixels=runInNewContext(expression,{Date:{now:()=>1400},URLSearchParams,location:{search:'?from=0&to=1000'},document:{querySelector:()=>svg}});
    const at=(time:number)=>composedScale*(40+(time-500)/2000*848);
    assert.ok(Math.abs(pixels-(at(1400)-at(1000)))<1e-9,'the return gesture covers the actual screen distance to now');
  }
});
