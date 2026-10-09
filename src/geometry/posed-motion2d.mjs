/** Position multiple user-validated tooling envelopes before sampled bending.
 * Returns witnessed HIT or UNVERIFIED, never a machine clearance certificate.
 */
import {toolContourInMachineFrame} from './tool-placement2d.mjs';
import {inspectSampledBend} from './sampled-motion2d.mjs';
export function inspectPlacedToolMotion({
 vertices,hingeIndex,movedSide,angleDeg,tools,samples=37
}) {
 if(!Array.isArray(tools)||!tools.length||tools.length>20)
   throw new RangeError('tools must contain 1..20 placed envelopes');
 const obstacles=tools.map(tool=>{
   if(!tool || !Array.isArray(tool.profile) || !tool.placement)
     throw new RangeError('invalid tool placement');
   return toolContourInMachineFrame(tool.profile,tool.placement);
 });
 const result=inspectSampledBend({vertices,hingeIndex,movedSide,angleDeg,obstacles,samples});
 return {...result,tool_id:result.status==='HIT' ? tools[result.obstacle_index].id??null:null,
   machine_clearance_verified:false};
}
