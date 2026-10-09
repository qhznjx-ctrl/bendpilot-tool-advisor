/** Transform a fixed tool contour into sheet coordinate space.
 * Applies rigid rotation then translation, in mm. No deformation model.
 */
import {rotateAround} from './rigid2d.mjs';
import {polylineHitsPolygon} from './collision2d.mjs';

export function toolContourInMachineFrame(vertices,{translateX=0,translateY=0,rotationDeg=0}={}) {
  if(!Array.isArray(vertices)||vertices.length<3||vertices.length>1000||
      ![translateX,translateY,rotationDeg].every(Number.isFinite))
    throw new RangeError('invalid contour placement');
  return vertices.map(p=>{
    const rotated=rotateAround(p,{x:0,y:0},rotationDeg);
    return {x:rotated.x+translateX,y:rotated.y+translateY};
  });
}
export function posedToolCollision(sheetPolyline,toolProfile,toolPlacement) {
  return polylineHitsPolygon(sheetPolyline,toolContourInMachineFrame(toolProfile,toolPlacement));
}
