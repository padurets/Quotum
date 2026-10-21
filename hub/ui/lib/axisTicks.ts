export function tickVisible(x:number,length:number,pose:{a:number;b:number;offset:number},scale:number,left:number,right:number) {
  const center=pose.a*x+pose.b+pose.offset/scale;
  return center-length/2>=left&&center+length/2<=right;
}

/** Keep a date whole and its glyphs unscaled while the numeric drawing changes basis. */
export function tickPresentation(x:number,length:number,pose:{a:number;b:number;offset:number},scale:number,left:number,right:number) {
  return {visible:tickVisible(x,length,pose,scale,left,right),transform:`translateX(${x*(1-1/pose.a)}px) scaleX(${1/pose.a})`};
}
