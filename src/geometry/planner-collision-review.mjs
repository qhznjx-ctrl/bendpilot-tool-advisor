/** Replay a proposed bend sequence through the geometry-inspector contract.
 * Each inspection uses the FULL preceding operation history. No approval
 * is inferred from absence of sampled contact.
 */
export function reviewCandidateByInspector(plan, inspectStep) {
 if(!plan||plan.status!=='OK'||!Array.isArray(plan.sequence)||!plan.sequence.length)
   throw new RangeError('a successfully planned sequence is required');
 if(typeof inspectStep!=='function')throw new TypeError('inspector callback required');
 const history=[],reports=[];
 for(const op of plan.sequence){
   const result=inspectStep({history:history.map(x=>({...x})),
     step:{id:op.id,toolId:op.toolId},side:op.side});
   if(!result||!['HIT','UNVERIFIED'].includes(result.status)||
      result.validated_clearance!==false)throw new TypeError('invalid geometry inspection result');
   reports.push({bend_id:op.id,status:result.status,
     sample_angle_deg:result.sample_angle_deg??null});
   if(result.status==='HIT')return {
     status:'BLOCKED_COLLISION_WITNESS',reports,
     inspected:reports.length,manufacturing_ready:false};
   history.push({...op});
 }
 return {status:'REVIEW_REQUIRED',reports,inspected:reports.length,
   manufacturing_ready:false};
}
