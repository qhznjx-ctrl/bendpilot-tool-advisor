/** Pure 2D rigid transforms. Unit: mm; positive angle = CCW. No collision/springback model. */
const pt = (p) => {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new RangeError("finite point required");
  return {x:p.x,y:p.y};
};
export function rotateAround(p, pivot, degrees) {
  const v=pt(p), h=pt(pivot);
  if(!Number.isFinite(degrees)) throw new RangeError("invalid angle");
  const t=degrees*Math.PI/180,c=Math.cos(t),s=Math.sin(t),x=v.x-h.x,y=v.y-h.y;
  return {x:h.x+c*x-s*y,y:h.y+s*x+c*y};
}
export function reflectAcrossLine(p, a, b) {
  const v=pt(p), o=pt(a), end=pt(b);
  const dx=end.x-o.x,dy=end.y-o.y,len=Math.hypot(dx,dy);
  if(len<1e-12) throw new RangeError("invalid flip axis");
  const ux=dx/len,uy=dy/len,x=v.x-o.x,y=v.y-o.y,proj=x*ux+y*uy;
  return {x:o.x+2*proj*ux-x,y:o.y+2*proj*uy-y};
}
export function bendVertices(vertices, hingeIndex, movedIndices, signedDegrees) {
  if(!Array.isArray(vertices)||!Number.isInteger(hingeIndex)||hingeIndex<0||
     hingeIndex>=vertices.length||!Array.isArray(movedIndices)) throw new RangeError("invalid hinge");
  const hinge=pt(vertices[hingeIndex]), moved=new Set(movedIndices);
  for(const i of moved) if(!Number.isInteger(i)||i<0||i>=vertices.length||i===hingeIndex)
    throw new RangeError("invalid movable vertex");
  return vertices.map((p,i)=>moved.has(i)?rotateAround(p,hinge,signedDegrees):pt(p));
}

/** Signed 2D turn at the hinge; reflection must reverse the sign. */
export function signedTurnDegrees(previous, hinge, next) {
  const p=pt(previous),h=pt(hinge),n=pt(next);
  const ax=p.x-h.x,ay=p.y-h.y,bx=n.x-h.x,by=n.y-h.y;
  if(Math.hypot(ax,ay)<1e-9||Math.hypot(bx,by)<1e-9)
    throw new RangeError('zero-length bend edge');
  return Math.atan2(ax*by-ay*bx,ax*bx+ay*by)*180/Math.PI;
}
