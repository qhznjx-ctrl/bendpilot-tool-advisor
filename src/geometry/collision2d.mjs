/** Static 2D segment/polyline to polygon collision preflight.
 * Coordinates in millimeters. Boundary contact counts as collision.
 * NOT a swept-volume or full-machine collision solver.
 */
const EPS=1e-9;
function point(p){if(!p||!Number.isFinite(p.x)||!Number.isFinite(p.y))throw new RangeError('finite coordinate required');return {x:p.x,y:p.y};}
function cross(a,b,c){return (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);}
function onSegment(p,a,b){return Math.abs(cross(a,b,p))<=EPS &&
 p.x>=Math.min(a.x,b.x)-EPS&&p.x<=Math.max(a.x,b.x)+EPS&&
 p.y>=Math.min(a.y,b.y)-EPS&&p.y<=Math.max(a.y,b.y)+EPS;}
export function segmentsIntersect(a,b,c,d){
 [a,b,c,d]=[a,b,c,d].map(point);
 const s1=cross(a,b,c),s2=cross(a,b,d),s3=cross(c,d,a),s4=cross(c,d,b);
 if(s1*s2 < -EPS&&s3*s4 < -EPS)return true;
 return (Math.abs(s1)<=EPS&&onSegment(c,a,b))||(Math.abs(s2)<=EPS&&onSegment(d,a,b))||
        (Math.abs(s3)<=EPS&&onSegment(a,c,d))||(Math.abs(s4)<=EPS&&onSegment(b,c,d));
}
function polygon(poly){
 if(!Array.isArray(poly)||poly.length<3||poly.length>1000)throw new RangeError('polygon needs 3..1000 vertices');
 const pts=poly.map(point);
 const area=pts.reduce((s,p,i)=>{const q=pts[(i+1)%pts.length];return s+p.x*q.y-q.x*p.y;},0);
 if(Math.abs(area)<EPS)throw new RangeError('degenerate polygon');
 // Self-crossing/tool contours are ambiguous for collision testing.
 for(let i=0;i<pts.length;i++){
  if(Math.hypot(pts[i].x-pts[(i+1)%pts.length].x,pts[i].y-pts[(i+1)%pts.length].y)<EPS)
   throw new RangeError('zero-length polygon edge');
  for(let j=i+1;j<pts.length;j++){
   if(j===i+1||(i===0&&j===pts.length-1))continue;
   if(segmentsIntersect(pts[i],pts[(i+1)%pts.length],pts[j],pts[(j+1)%pts.length]))
    throw new RangeError('self-intersecting polygon');
  }
 }
 return pts;
}
function inside(p,poly){
 let hit=false;
 for(let i=0,j=poly.length-1;i<poly.length;j=i++){
  const a=poly[j],b=poly[i];
  if(onSegment(p,a,b))return true;
  if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)hit=!hit;
 }
 return hit;
}
export function polylineHitsPolygon(vertices,obstacle){
 if(!Array.isArray(vertices)||vertices.length<2||vertices.length>1000)throw new RangeError('polyline needs 2..1000 points');
 const line=vertices.map(point),poly=polygon(obstacle);
 if(line.some(p=>inside(p,poly)))return true;
 for(let i=1;i<line.length;i++)for(let j=0;j<poly.length;j++)
  if(segmentsIntersect(line[i-1],line[i],poly[j],poly[(j+1)%poly.length]))return true;
 return false;
}
