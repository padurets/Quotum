import {CATEGORY_COLORS,type CategoryColor} from './categoryColors.js';
import {PROJECT_NAME_CHARS} from './projects.js';
import {jsonBytes} from './dataFilters.js';

export type ProjectColorPins = [project:string,color:CategoryColor][];
export type StoredProjectColors = {version:1;pins:ProjectColorPins};
export type ProjectColorEnvelope = StoredProjectColors & {revision:number;authority:string};
export type ProjectColorUpdate = {version:1;authority:string;project:string;color?:CategoryColor|null;name?:string};
export type ProjectColorReset = {version:1;authority:string};
export const PROJECT_COLOR_BYTES=64*1024;
export const PROJECT_COLOR_FRAME_BYTES=68*1024;
export const PROJECT_COLOR_BODY_BYTES=4*1024;
// Reserve every accepted entry's worst-case name, so later aliases always fit.
const slotBytes=jsonBytes(['\u0001'.repeat(PROJECT_NAME_CHARS),CATEGORY_COLORS[0]])+1;
export const PROJECT_COLOR_PIN_LIMIT=Math.floor((PROJECT_COLOR_BYTES-jsonBytes({version:1,pins:[]})+1)/slotBytes);
export function exactOrder(a:string,b:string):number {
  const left=[...a],right=[...b];
  for(let i=0;i<Math.min(left.length,right.length);i++){const difference=left[i].codePointAt(0)!-right[i].codePointAt(0)!;if(difference)return difference;}
  return left.length-right.length;
}
export function validProjectName(value:unknown):value is string {
  if(typeof value!=='string'||!value.length)return false;
  const points=[...value];
  // SQLite stores UTF-8: reject unpaired surrogates rather than changing their identity.
  return points.length<=PROJECT_NAME_CHARS&&points.every(point=>{const code=point.codePointAt(0)!;return code<0xd800||code>0xdfff;});
}
export const validCategoryColor=(value:unknown):value is CategoryColor=>CATEGORY_COLORS.includes(value as CategoryColor);
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const keys=(value:Record<string,unknown>,allowed:readonly string[])=>Object.keys(value).every(key=>allowed.includes(key));
const authority=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
export const canonicalPins=(pins:ProjectColorPins):ProjectColorPins=>pins.map(([name,color]):[string,CategoryColor]=>[name,color]).sort(([a],[b])=>exactOrder(a,b));

export function parseProjectColors(value:unknown):StoredProjectColors|null {
  if(!object(value)||!keys(value,['version','pins'])||value.version!==1||!Array.isArray(value.pins)||value.pins.length>PROJECT_COLOR_PIN_LIMIT)return null;
  const names=new Set<string>(),pins:ProjectColorPins=[];
  for(const pair of value.pins){
    if(!Array.isArray(pair)||pair.length!==2||!validProjectName(pair[0])||!validCategoryColor(pair[1])||names.has(pair[0]))return null;
    names.add(pair[0]);pins.push([pair[0],pair[1]]);
  }
  const result:StoredProjectColors={version:1,pins:canonicalPins(pins)};
  return jsonBytes(result)<=PROJECT_COLOR_BYTES?result:null;
}
export function parseProjectColorEnvelope(value:unknown):ProjectColorEnvelope|null {
  if(!object(value)||!keys(value,['version','pins','revision','authority'])||!Number.isSafeInteger(value.revision)||Number(value.revision)<0||!authority(value.authority))return null;
  const stored=parseProjectColors({version:value.version,pins:value.pins});
  return stored?{...stored,revision:Number(value.revision),authority:value.authority}:null;
}
export function parseProjectColorUpdate(value:unknown):ProjectColorUpdate|null {
  if(!object(value)||!keys(value,['version','authority','project','color','name'])||value.version!==1||!authority(value.authority)||!validProjectName(value.project)||
    !('color' in value)&&!('name' in value)||'color' in value&&value.color!==null&&!validCategoryColor(value.color)||'name' in value&&!validProjectName(value.name))return null;
  return {version:1,authority:value.authority,project:value.project,...('color' in value?{color:value.color as CategoryColor|null}:{}),...('name' in value?{name:value.name as string}:{})};
}
export function parseProjectColorReset(value:unknown):ProjectColorReset|null {
  return object(value)&&keys(value,['version','authority'])&&value.version===1&&authority(value.authority)?{version:1,authority:value.authority}:null;
}
