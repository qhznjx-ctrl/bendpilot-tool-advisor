import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewCandidateByInspector} from '../src/geometry/planner-collision-review.mjs';
import {planBendSequence} from '../src/geometry/sequence2d.mjs';
const steps=[{id:'A',toolId:'P',sides:['front']},{id:'B',toolId:'P',sides:['front'],dependencies:['A']}];
test('planner history is supplied to geometry collision engine',()=>{
 const historySizes=[],plan=planBendSequence(steps);
 const result=reviewCandidateByInspector(plan,({history})=>{
   historySizes.push(history.length);return {status:'UNVERIFIED',validated_clearance:false};});
 assert.equal(result.status,'REVIEW_REQUIRED');assert.deepEqual(historySizes,[0,1]);
 assert.equal(result.manufacturing_ready,false);
});
test('witnessed collision stops the review immediately',()=>{
 const r=reviewCandidateByInspector(planBendSequence(steps),({step})=>({
   status:step.id==='B'?'HIT':'UNVERIFIED',validated_clearance:false}));
 assert.equal(r.status,'BLOCKED_COLLISION_WITNESS');assert.equal(r.inspected,2);
});
test('invalid evidence cannot approve order',()=>{
 assert.throws(()=>reviewCandidateByInspector(planBendSequence(steps),()=>({status:'CLEAR',validated_clearance:true})),TypeError);
});
test('failed search is not eligible for review',()=>{
 assert.throws(()=>reviewCandidateByInspector({status:'SEARCH_INCONCLUSIVE',sequence:[]},()=>true),RangeError);
});
