import test from 'node:test';
import assert from 'node:assert/strict';
import {findReviewedSequence} from '../src/geometry/planning-workflow.mjs';
const steps=[{id:'A',toolId:'T',sides:['front']},{id:'B',toolId:'T',dependencies:['A'],sides:['front']}];
test('no sampled hits still requires engineering review',()=>{
 const p=findReviewedSequence(steps,{inspectStep:()=>({status:'UNVERIFIED',validated_clearance:false})});
 assert.equal(p.status,'ENGINEERING_REVIEW_REQUIRED');assert.equal(p.sequence.length,2);
 assert.equal(p.manufacturing_ready,false);
});
test('witnessed collision prevents successful candidate',()=>{
 const p=findReviewedSequence(steps,{inspectStep:()=>({status:'HIT',validated_clearance:false})});
 assert.equal(p.status,'NO_CERTIFIED_SEQUENCE');assert.equal(p.manufacturing_ready,false);
});
test('inspector is mandatory and invalid statuses fail closed',()=>{
 assert.throws(()=>findReviewedSequence(steps),TypeError);
 assert.throws(()=>findReviewedSequence(steps,{inspectStep:()=>({status:'CLEAR',validated_clearance:true})}),TypeError);
});
