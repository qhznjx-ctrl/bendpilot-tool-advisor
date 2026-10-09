/** Sequence planner plus collision witness review, never machine certification. */
import {planBendSequence} from './sequence2d.mjs';
import {createCollisionAwarePredicate} from './collision-adapter.mjs';
import {reviewCandidateByInspector} from './planner-collision-review.mjs';
export function findReviewedSequence(steps,{inspectStep,...options}={}){
 if(typeof inspectStep!=='function')throw new TypeError('inspectStep callback required');
 const predicate=createCollisionAwarePredicate(inspectStep);
 const plan=planBendSequence(steps,{...options,feasible:predicate.feasible});
 if(plan.status!=='OK')return {status:'NO_CERTIFIED_SEQUENCE',planner_status:plan.status,
  search_truncated:!!plan.searchTruncated,inspections:predicate.statistics(),sequence:[],manufacturing_ready:false};
 const review=reviewCandidateByInspector(plan,inspectStep);
 return {status:review.status==='BLOCKED_COLLISION_WITNESS'?'BLOCKED_COLLISION_WITNESS':'ENGINEERING_REVIEW_REQUIRED',
   planner_status:plan.status,search_truncated:!!plan.searchTruncated,inspections:predicate.statistics(),
   review,sequence:plan.sequence,manufacturing_ready:false};
}
