import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activeHours,money} from '../lib/money';
import {setLocale} from '../i18n';

test('active hours share money formatters while preserving precision and browser locales',context=>{
  const navigator=Object.getOwnPropertyDescriptor(globalThis,'navigator'),NativeNumberFormat=Intl.NumberFormat;
  let creations=0;
  context.mock.method(Intl,'NumberFormat',function(...args:ConstructorParameters<typeof Intl.NumberFormat>){
    creations++;return new NativeNumberFormat(...args);
  });
  const repeatedCreations:[string,number][]=[];
  try {
    for(const tag of ['en-US','ru-RU','en-GB','en-US']) {
      Object.defineProperty(globalThis,'navigator',{configurable:true,value:{languages:[tag]}});
      const russian=tag.startsWith('ru');setLocale(russian?'ru':'en');
      money('1000000');
      const before=creations,unit=russian?'ч':'h',decimal=russian?',':'.',group=russian?'\u00a0':',';
      const values:[string|null,string][]=[
        [null,'—'],['0','0'+unit],['359999','0'+unit],['360000','0'+decimal+'1'+unit],
        ['3599999','0'+decimal+'9'+unit],['3600000','1'+unit],
        ['32425917317067575400000',['9','007','199','254','740','993'].join(group)+decimal+'1'+unit],
      ];
      for(let i=0;i<16;i++)for(const [value,expected] of values)assert.equal(activeHours(value),expected,tag);
      repeatedCreations.push([tag,creations-before]);
    }
    assert.deepEqual(repeatedCreations,[['en-US',0],['ru-RU',0],['en-GB',0],['en-US',0]],'rendering and clock comparisons reuse the locale formatter');
  }finally{
    if(navigator)Object.defineProperty(globalThis,'navigator',navigator);else Reflect.deleteProperty(globalThis,'navigator');
    setLocale('en');
  }
});
