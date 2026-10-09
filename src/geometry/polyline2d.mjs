/** Immutable 2D polyline bend and flip adapter. No machine collision model. */
import {bendVertices, reflectAcrossLine} from './rigid2d.mjs';

export function bendPolyline(vertices, hingeIndex, movedSide, signedDegrees) {
  if (!Array.isArray(vertices) || vertices.length < 3 ||
      !Number.isInteger(hingeIndex) || hingeIndex <= 0 || hingeIndex >= vertices.length-1 ||
      !['left','right'].includes(movedSide) || !Number.isFinite(signedDegrees))
    throw new RangeError('invalid polyline bend');
  const moved=[];
  for(let index=0;index<vertices.length;index++) {
    if ((movedSide==='left' && index<hingeIndex) ||
        (movedSide==='right' && index>hingeIndex)) moved.push(index);
  }
  return bendVertices(vertices,hingeIndex,moved,signedDegrees);
}

export function flipPolyline(vertices, axisA, axisB) {
  if(!Array.isArray(vertices)||vertices.length<2)
    throw new RangeError('polyline requires at least two points');
  return vertices.map(p=>reflectAcrossLine(p,axisA,axisB));
}
