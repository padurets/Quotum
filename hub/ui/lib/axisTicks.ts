export function tickVisible(x:number,length:number,pose:{a:number;b:number;offset:number},scale:number,left:number,right:number) {
  const center=pose.a*x+pose.b+pose.offset/scale;
  return center-length/2>=left&&center+length/2<=right;
}

/** Keep a date whole and its glyphs unscaled while the numeric drawing changes basis. */
export function tickPresentation(x:number,length:number,pose:{a:number;b:number;offset:number},scale:number,left:number,right:number) {
  return {visible:tickVisible(x,length,pose,scale,left,right),transform:`translateX(${(pose.a-1)*x+pose.b}px)`};
}

/** Labels share the drawing's eased progress, without inheriting its horizontal scale. */
export function tickKeyframes(x:number,length:number,start:{a:number;b:number},end:{a:number;b:number},left:number,right:number):Keyframe[] {
  const from=start.a*x+start.b,to=end.a*x+end.b,delta=to-from;
  const frame=(offset:number,visible:boolean):Keyframe=>({offset,transform:`translateX(${from+delta*offset-x}px)`,visibility:visible?'visible':'hidden'});
  const low=left+length/2,high=right-length/2;
  if(low>high)return [frame(0,false),frame(1,false)];
  if(!delta){const visible=from>=low&&from<=high;return [frame(0,visible),frame(1,visible)];}
  const a=(low-from)/delta,b=(high-from)/delta,enter=Math.max(0,Math.min(a,b)),exit=Math.min(1,Math.max(a,b));
  if(enter>exit)return [frame(0,false),frame(1,false)];
  // Visibility interpolates as visible across a visible/hidden pair. Repeating
  // an offset makes each boundary a step while translation stays continuous.
  const frames=[frame(0,enter===0)];
  if(enter>0)frames.push(frame(enter,false),frame(enter,true));
  if(exit<1)frames.push(frame(exit,true),frame(exit,false));
  frames.push(frame(1,exit===1));
  return frames;
}
