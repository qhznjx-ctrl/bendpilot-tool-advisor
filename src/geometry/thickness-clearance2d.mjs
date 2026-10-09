/** Conservative sheet centerline-to-tool polygon minimum-distance witness (mm).
 * A negative result is UNVERIFIED, not machine-level clearance.
 */
import {segmentsIntersect,polylineHitsPolygon} from './collision2d.mjs';
const pt=p=>{if(!p||![p.x,p.y].every(Number.isFinite))throw new RangeError('finite 2D points required');return p;};
function segmentToPoint(p,a,b){
 const dx=b.x-a.x,dy=b.y-a.y,len2=dx*dx+dy*dy;
 if(len2<=1e-18)throw new RangeError('zero-length segment');
 const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/len2));
 return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);
}
export function segmentGap(a,b,c,d){
 [a,b,c,d].forEach(pt);
 if(segmentsIntersect(a,b,c,d))return 0;
 return Math.min(segmentToPoint(a,c,d),segmentToPoint(b,c,d),
                 segmentToPoint(c,a,b),segmentToPoint(d,a,b));
}
export function sheetToolClearanceWitness(sheet,tool,{thicknessMm,marginMm=0}={}){
 if(!Array.isArray(sheet)||!Array.isArray(tool)||sheet.length<2||tool.length<3||
    sheet.length>1000||tool.length>1000||!Number.isFinite(thicknessMm)||
    thicknessMm<=0||thicknessMm>100||!Number.isFinite(marginMm)||marginMm<0||marginMm>20)
    throw new RangeError('invalid sheet, tool or clearance parameters');
 sheet.forEach(pt);tool.forEach(pt);
 if(polylineHitsPolygon(sheet,tool))return {status:'HIT',minimum_gap_mm:0,
   required_gap_mm:thicknessMm/2+marginMm,validated_clearance:false};
 let gap=Infinity;
 for(let i=1;i<sheet.length;i++)for(let j=0;j<tool.length;j++)
    gap=Math.min(gap,segmentGap(sheet[i-1],sheet[i],tool[j],tool[(j+1)%tool.length]));
 return {status:gap<=thicknessMm/2+marginMm+1e-9?'HIT':'UNVERIFIED',
         minimum_gap_mm:Number(gap.toFixed(6)),required_gap_mm:thicknessMm/2+marginMm,
         validated_clearance:false};
}
