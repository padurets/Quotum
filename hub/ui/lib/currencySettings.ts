import {AMOUNT_MAX} from '../../server/domain/amount';

/** Input is a decimal ratio; the API always receives exact whole millionths. */
export function currencyRate(text:string,locale:string):string {
  const value=text.trim(),pattern=locale==='ru'?/^(\d+)(?:[.,](\d{1,6}))?$/:/^(\d+)(?:\.(\d{1,6}))?$/;
  const match=pattern.exec(value);if(!match||value.length>32)throw new Error('invalid_currency');
  const amount=BigInt(match[1])*1_000_000n+BigInt((match[2]??'').padEnd(6,'0'));
  if(amount<=0n||amount>AMOUNT_MAX)throw new Error('invalid_currency');return amount.toString();
}
export function rateText(value:string):string {const n=BigInt(value);return (n/1_000_000n).toString()+((n%1_000_000n).toString().padStart(6,'0').replace(/0+$/,'').replace(/^(.+)$/,'.$1'));}
