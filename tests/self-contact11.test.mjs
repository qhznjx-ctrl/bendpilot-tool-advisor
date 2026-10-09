import test from 'node:test';
import assert from 'node:assert/strict';
import {polylineSelfContact} from '../src/geometry/collision2d.mjs';
import {inspectSampledBend} from '../src/geometry/sampled-motion2d.mjs';
const far=[{x:8,y:8},{x:9,y:8},{x:9,y:9},{x:8,y:9}];
test('nonadjacent self crossing is witnessed',()=>{
 const r=polylineSelfContact([{x:0,y:0},{x:2,y:2},{x:0,y:2},{x:2,y:0}]);
 assert.deepEqual(r,{contact:true,first_edge:0,second_edge:2});
});
test('adjacent hinge is not an automatic self-collision',()=>{
 assert.equal(polylineSelfContact([{x:0,y:0},{x:1,y:0},{x:1,y:1}]).contact,false);
});
test('sampled bending reports self contact but never certifies clearance',()=>{
 const r=inspectSampledBend({vertices:[{x:0,y:0},{x:2,y:2},{x:0,y:2},{x:2,y:0}],
 hingeIndex:1,movedSide:'right',angleDeg:90,samples:9,obstacles:[far]});
 assert.equal(r.status,'HIT');assert.equal(r.reason,'WORKPIECE_SELF_CONTACT');
 assert.equal(r.sample_angle_deg,0);assert.equal(r.validated_clearance,false);
});
test('non-contact still does not prove tool or sheet clearance',()=>{
 assert.equal(polylineSelfContact([{x:0,y:0},{x:2,y:0},{x:3,y:1},{x:5,y:1}]).contact,false);
});
test('invalid zero-length geometry rejected',()=>{
 assert.throws(()=>polylineSelfContact([{x:0,y:0},{x:0,y:0},{x:1,y:1}]),RangeError);
});
