/** Discrete collision WITNESS only. Nonhits remain UNVERIFIED. */
import {bendPolyline} from './polyline2d.mjs';
import {polylineHitsPolygon} from './collision2d.mjs';
export function inspectSampledBend({vertices,hingeIndex,movedSide,angleDeg,obstacles,samples=37}) {
  if(!Array.isArray(obstacles)||obstacles.length<1||obstacles.length>64||
     typeof angleDeg!=='number'||!Number.isFinite(angleDeg)||Math.abs(angleDeg)>180||
     !Number.isInteger(samples)||samples<2||samples>181)throw new RangeError('invalid sampled motion');
  for(let i=0;i<samples;i++){
    const theta=angleDeg*i/(samples-1);
    const posed=bendPolyline(vertices,hingeIndex,movedSide,theta);
    for(let j=0;j<obstacles.length;j++)
      if(polylineHitsPolygon(posed,obstacles[j]))
        return {status:'HIT',sample_angle_deg:theta,obstacle_index:j,samples_checked:i+1,
                validated_clearance:false,method:'discrete_2d_pose_sampling'};
  }
  return {status:'UNVERIFIED',sample_angle_deg:null,obstacle_index:null,samples_checked:samples,
          validated_clearance:false,method:'discrete_2d_pose_sampling'};
}
