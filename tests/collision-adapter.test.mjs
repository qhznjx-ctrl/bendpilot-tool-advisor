import test from 'node:test';
import assert from 'node:assert/strict';
import {planBendSequence} from '../src/geometry/sequence2d.mjs';
import {createCollisionAwarePredicate} from '../src/geometry/collision-adapter.mjs';
const steps=[{id:'A',toolId:'T',sides:['front']},{id:'B',toolId:'T',sides:['front']}];
test('witnessed collision rejects sequence candidate',()=>{
 const c=createCollisionAwarePredicate(({step,history})=>({
   status:step.id==='B' && history.length===0?'HIT':'UNVERIFIED',
   validated_clearance:false}));
 const r=planBendSequence(steps,{feasible:c.feasible});
 assert.equal(r.status,'OK');assert.deepEqual(r.sequence.map(x=>x.id),['A','B']);
 assert.ok(c.statistics().hits>0);assert.equal(c.statistics().manufacturing_ready,false);
});
test('unverified callback cannot certify workpiece',()=>{
 const c=createCollisionAwarePredicate(()=>({status:'UNVERIFIED',validated_clearance:false}));
 const r=planBendSequence(steps,{feasible:c.feasible});
 assert.equal(r.status,'OK');assert.equal(r.manufacturingReady,false);
 assert.equal(c.statistics().clearance_certified,false);
});
test('invalid evidence fails closed',()=>{
 const c=createCollisionAwarePredicate(()=>({status:'CLEAR',validated_clearance:true}));
 assert.throws(()=>planBendSequence(steps,{feasible:c.feasible}),TypeError);
});
test('candidate rejection does not report manufacturing ready',()=>{
 const c=createCollisionAwarePredicate(()=>({status:'HIT',validated_clearance:false}));
 const r=planBendSequence(steps,{feasible:c.feasible});
 assert.equal(r.status,'NO_VALID_SEQUENCE');assert.equal(c.statistics().manufacturing_ready,false);
});
