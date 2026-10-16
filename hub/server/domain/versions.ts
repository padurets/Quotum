type Version = {core: bigint[]; pre: string[]};
function parse(value: string): Version | null {
  if (value.length > 64) return null;
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return null;
  const pre = match[4]?.split('.') ?? [];
  if (pre.some(part=>/^[0-9]+$/.test(part) && part.length>1 && part[0]==='0')) return null;
  return {core:match.slice(1,4).map(BigInt),pre};
}

/** Version ordering is information, never proof of supported protocol or account access. */
export function compareVersions(left: string, right: string): -1 | 0 | 1 | null {
  const a=parse(left),b=parse(right);if(!a||!b)return null;
  for(let i=0;i<3;i++)if(a.core[i]!==b.core[i])return a.core[i]<b.core[i]?-1:1;
  if(!a.pre.length || !b.pre.length)return a.pre.length ? -1 : b.pre.length ? 1 : 0;
  for(let i=0;i<Math.max(a.pre.length,b.pre.length);i++) {
    const x=a.pre[i],y=b.pre[i];if(x===y)continue;
    if(x===undefined)return -1;if(y===undefined)return 1;
    const xn=/^[0-9]+$/.test(x),yn=/^[0-9]+$/.test(y);
    if(xn&&yn)return BigInt(x)<BigInt(y)?-1:1;
    if(xn!==yn)return xn?-1:1;
    return x<y?-1:1;
  }
  return 0;
}

export function agentVersion(agent: string): string | null {
  const value=agent.startsWith('quotum/')?agent.slice(7):'';
  return parse(value)?value:null;
}
