/** Physical accounting traffic includes composite reads and bounded detail requests. */
export const accountingPath=(path:string)=>path==='/api/history'||/^\/api\/boards\/[^/]+\/period(?:\/sessions)?$/.test(path);
export const accountingTotal=(values:Record<string,number>)=>Object.entries(values).reduce((sum,[path,value])=>sum+(accountingPath(path)?value:0),0);
