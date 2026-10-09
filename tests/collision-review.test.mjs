import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewCollisionEvidence} from '../src/geometry/collision-review.mjs';
const seq=[{id:'B1'},{id:'B2'}],e=(bend_id,status)=>({bend_id,status,validated_clearance:false});
test('collision hit blocks order',()=>{
 const r=reviewCollisionEvidence(seq,[e('B1','UNVERIFIED'),e('B2','HIT')]);
 assert.equal(r.status,'BLOCKED_COLLISION_WITNESS');assert.deepEqual(r.collisions,['B2']);
 assert.equal(r.manufacturing_ready,false);
});
test('negative samples never mark sequence manufacturing ready',()=>{
 const r=reviewCollisionEvidence(seq,[e('B1','UNVERIFIED'),e('B2','UNVERIFIED')]);
 assert.equal(r.status,'REVIEW_REQUIRED');assert.equal(r.manufacturing_ready,false);
});
test('missing reports require further review',()=>{
 assert.deepEqual(reviewCollisionEvidence(seq,[e('B1','UNVERIFIED')]).unverified,['B1','B2']);
});
test('invalid purported clearance certification is rejected',()=>{
 assert.throws(()=>reviewCollisionEvidence(seq,[{...e('B1','UNVERIFIED'),validated_clearance:true}]),RangeError);
 assert.throws(()=>reviewCollisionEvidence(seq,[e('B1','HIT'),e('B1','HIT')]),RangeError);
 assert.throws(()=>reviewCollisionEvidence(seq,[e('X','HIT')]),RangeError);
});
