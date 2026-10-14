/** Device admission and source disclosure are independent board permissions. */
export type PublicFunding = {source:string|null;sourceStatus?:'notProvided'};
export type WorkAccess = {
  fundingRevision?:string;
  owner:string|null;
  knownFrom:number;
  devices:ReadonlyMap<string,{owner:string;from:number;revision:string}>;
  holdings:ReadonlyMap<string,ReadonlySet<string>>;
  sources:ReadonlyMap<string,{since:number;holders:ReadonlySet<string>}>;
};

export const workFundingKey=(board:string)=>'workFunding::'+board;

export const sourceKey=(funding:PublicFunding)=>funding.source??funding.sourceStatus??'unknown';

/** Saved ownership, rather than the report's attribution, grants access to work. */
export function admitted(access:WorkAccess,device:string,owner:string) {
  const scope=access.devices.get(device);
  return scope?.owner===owner?scope:undefined;
}

export function fundingOf(access:WorkAccess,owner:string,source:string|null):PublicFunding {
  if(source===null||!access.holdings.get(owner)?.has(source))return {source:null};
  return access.sources.get(source)?.holders.has(owner)?{source}:{source:null,sourceStatus:'notProvided'};
}

export function sessionsKnownFrom(access:WorkAccess):number|null {
  return access.owner!==null?access.knownFrom:access.devices.size?Math.min(...[...access.devices.values()].map(d=>d.from)):null;
}

export function sourceWorkFrom(access:WorkAccess):Record<string,number> {
  const result:Record<string,number>={};
  for(const [source,scope] of access.sources){
    const devices=[...access.devices.values()].filter(d=>scope.holders.has(d.owner));
    if(devices.length)result[source]=Math.max(access.knownFrom,scope.since,Math.min(...devices.map(d=>d.from)));
  }
  return result;
}
