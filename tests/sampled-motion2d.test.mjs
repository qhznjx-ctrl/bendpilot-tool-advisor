import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectSampledBend} from '../src/geometry/sampled-motion2d.mjs';
const base={vertices:[{x:0,y:0},{x:1,y:0},{x:2,y:0}],hingeIndex:1,movedSide:'right',angleDeg:180,samples:37};
const rect=(x1,y1,x2,y2)=>[{x:x1,y:y1},{x:x2,y:y1},{x:x2,y:y2},{x:x1,y:y2}];
test('intermediate collision can be detected',()=>{
 const r=inspectSampledBend({...base,obstacles:[rect(.85,.65,1.15,1.05)]});
 assert.equal(r.status,'HIT');assert.ok(r.sample_angle_deg>0&&r.sample_angle_deg<180);
 assert.equal(r.validated_clearance,false);
});
test('no sampled hit is never clearance certification',()=>{
 const r=inspectSampledBend({...base,obstacles:[rect(4,4,5,5)]});
 assert.equal(r.status,'UNVERIFIED');assert.equal(r.samples_checked,37);assert.equal(r.validated_clearance,false);
});
test('zero-angle starting collision reported',()=>{
 const r=inspectSampledBend({...base,obstacles:[rect(1.6,-.1,2.2,.1)]});
 assert.equal(r.status,'HIT');assert.equal(r.sample_angle_deg,0);
});
test('invalid sample limits fail closed',()=>{
 assert.throws(()=>inspectSampledBend({...base,obstacles:[]}),RangeError);
 assert.throws(()=>inspectSampledBend({...base,samples:1,obstacles:[rect(4,4,5,5)]}),RangeError);
 assert.throws(()=>inspectSampledBend({...base,angleDeg:200,obstacles:[rect(4,4,5,5)]}),RangeError);
});
