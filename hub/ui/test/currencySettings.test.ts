import {test} from 'node:test';
import assert from 'node:assert/strict';
import {currencyRate,rateText} from '../lib/currencySettings';

test('currency forms parse localized decimal ratios without rounding or Number coercion',()=>{
  for(const [text,locale,expected] of [['2','en','2000000'],[' 2,123456 ','ru','2123456'],['0.000001','en','1'],['9223372036854.775807','en','9223372036854775807']])assert.equal(currencyRate(text,locale),expected);
  for(const text of ['0','-1','1e2','1,000.2','1 000','1.0000001','9223372036854.775808','NaN',''])assert.throws(()=>currencyRate(text,'en'));
  assert.throws(()=>currencyRate('2,5','en'));assert.equal(currencyRate('2.5','ru'),'2500000');
  for(const value of ['1','1000000','1230000','9223372036854775807'])assert.equal(currencyRate(rateText(value),'en'),value);
});
