import {CATEGORY_COLORS,type CategoryColor} from '../../server/domain/categoryColors';
import {parseProjectColorEnvelope,type ProjectColorPins} from '../../server/domain/projectColors';

export const OTHER_COLOR='var(--other)';
type Identity={key:string;name:string|null};
export type ProjectIdentity=Identity&{color:string;manual?:boolean};

/** Conflicts carry the same authorized resource beside their public error code. */
export function projectColorReply(value:unknown) {
  if(value&&typeof value==='object'&&!Array.isArray(value)&&'error' in value&&
    (value.error==='project_colors_conflict'||value.error==='project_colors_context_changed')){
    const {error:_error,...envelope}=value;return parseProjectColorEnvelope(envelope);
  }
  return parseProjectColorEnvelope(value);
}

/** Project keys retain exact JSON string/null identity, independent of displayed labels. */
function projectOf(key:string):string|null {
  try{const value:unknown=JSON.parse(key);return typeof value==='string'?value:null;}catch{return null;}
}

/** Reserve manual slots before preserving automatic survivors or allocating any newcomer. */
export function resolveProjectColors(groups:readonly Identity[],pins:Readonly<ProjectColorPins>,previous:readonly ProjectIdentity[]=[]):ProjectIdentity[] {
  const choices=new Map(pins),current=new Map(groups.map(group=>[group.key,group])),resolved=new Map<string,ProjectIdentity>(),used=new Set<string>();
  for(const group of groups){const name=projectOf(group.key),color=name===null?undefined:choices.get(name);if(color){resolved.set(group.key,{...group,color,manual:true});used.add(color);}}
  for(const old of previous){
    const group=current.get(old.key);
    if(!group||resolved.has(old.key)||old.manual)continue;
    if(old.color===OTHER_COLOR||CATEGORY_COLORS.includes(old.color as CategoryColor)&&!used.has(old.color)){
      resolved.set(old.key,{...group,color:old.color,manual:false});if(old.color!==OTHER_COLOR)used.add(old.color);
    }
  }
  const order=[...previous.filter(group=>current.has(group.key)),...groups.filter(group=>!previous.some(old=>old.key===group.key))];
  for(const group of order){
    if(resolved.has(group.key))continue;
    const color=CATEGORY_COLORS.find(color=>!used.has(color))??OTHER_COLOR;
    resolved.set(group.key,{...current.get(group.key)!,color,manual:false});if(color!==OTHER_COLOR)used.add(color);
  }
  return groups.map(group=>resolved.get(group.key)!);
}
