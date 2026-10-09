import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectPlacedToolMotion} from '../src/geometry/posed-motion2d.mjs';
const square=[{x:0,y:0},{x:0.4,y:0},{x:0.4,y:0.4},{x:0,y:0.4}];
const job={vertices:[{x:0,y:0},{x:1,y:0},{x:2,y:0}],
 hingeIndex:1,movedSide:'right',angleDeg:90,samples:19};
test('placed tool obstructs sampled flange sweep',()=>{
 const r=inspectPlacedToolMotion({...job,tools:[{id:'punch',profile:square,placement:{translateX:1.2,translateY:.7}}]});
 assert.equal(r.status,'HIT');assert.equal(r.tool_id,'punch');assert.equal(r.machine_clearance_verified,false);
});
test('unobstructed samples are explicitly unverified',()=>{
 const r=inspectPlacedToolMotion({...job,tools:[{id:'die',profile:square,placement:{translateX:8,translateY:8}}]});
 assert.equal(r.status,'UNVERIFIED');assert.equal(r.machine_clearance_verified,false);
});
test('invalid tool envelope fails closed',()=>{
 assert.throws(()=>inspectPlacedToolMotion({...job,tools:[]}),RangeError);
 assert.throws(()=>inspectPlacedToolMotion({...job,tools:[{id:'bad',profile:square,placement:{rotationDeg:NaN}}]}),RangeError);
});
test('input geometry remains immutable',()=>{
 const tool={id:'tool',profile:square,placement:{translateX:8,translateY:8}};
 const copy=JSON.stringify({job,tool});inspectPlacedToolMotion({...job,tools:[tool]});
 assert.equal(JSON.stringify({job,tool}),copy);
});
