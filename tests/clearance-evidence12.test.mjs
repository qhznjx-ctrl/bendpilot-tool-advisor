import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeThicknessReview} from '../src/geometry/clearance-evidence12.mjs';
const seq=[{id:'A'},{id:'B'}];
test('thickness collision blocks sequence',()=>{
 const r=summarizeThicknessReview(seq,[{bend_id:'A',status:'HIT',validated_clearance:false}]);
 assert.equal(r.status,'BLOCKED_COLLISION_WITNESS');assert.deepEqual(r.collision_ids,['A']);
 assert.equal(r.manufacturing_ready,false);
});
test('missing evidence requires engineering review',()=>{
 const r=summarizeThicknessReview(seq,[]);
 assert.equal(r.status,'ENGINEERING_REVIEW_REQUIRED');assert.deepEqual(r.review_ids,['A','B']);
});
test('no sampled hit cannot authorize production',()=>{
 const r=summarizeThicknessReview(seq,[{bend_id:'A',status:'UNVERIFIED',validated_clearance:false}]);
 assert.equal(r.manufacturing_ready,false);assert.equal(r.inspected,1);
});
test('false clearance certification and duplicate reports fail',()=>{
 const rec={bend_id:'A',status:'HIT',validated_clearance:false};
 assert.throws(()=>summarizeThicknessReview(seq,[rec,rec]),RangeError);
 assert.throws(()=>summarizeThicknessReview(seq,[{...rec,validated_clearance:true}]),RangeError);
});
