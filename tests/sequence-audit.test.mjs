import test from 'node:test';
import assert from 'node:assert/strict';
import {planBendSequence} from '../src/geometry/sequence2d.mjs';
import {auditBendSequence} from '../src/geometry/sequence-audit.mjs';
const steps=[
 {id:'A',toolId:'P1',sides:['front']},
 {id:'B',toolId:'P2',dependencies:['A'],sides:['back']},
];
test('planner output passes independent execution audit',()=>{
 const planned=planBendSequence(steps);
 assert.equal(planned.status,'OK');
 assert.deepEqual(auditBendSequence(steps,planned.sequence).errors,[]);
});
test('missing, duplicate and wrong order are reported',()=>{
 const candidate=[{id:'B',toolId:'P2',side:'back'},
                  {id:'B',toolId:'P2',side:'back'}];
 const r=auditBendSequence(steps,candidate);
 assert.equal(r.valid,false);
 assert.match(r.errors.join('|'),/prerequisites missing/);
 assert.match(r.errors.join('|'),/repeated bend/);
 assert.match(r.errors.join('|'),/missing bend: A/);
});
test('side and tool mismatch cannot silently pass',()=>{
 const r=auditBendSequence(steps,[{id:'A',toolId:'WRONG',side:'back'},
                                  {id:'B',toolId:'P2',side:'back'}]);
 assert.equal(r.valid,false);
 assert.match(r.errors.join('|'),/unsupported workpiece side/);
 assert.match(r.errors.join('|'),/selected die differs/);
});
test('feasibility rejection stays visible in audit output',()=>{
 const p=planBendSequence(steps);
 const r=auditBendSequence(steps,p.sequence,{feasible:({step})=>step.id!=='B'});
 assert.equal(r.valid,false);
 assert.match(r.errors.join('|'),/collision\/reachability/);
});
test('nonboolean feasibility results fail closed',()=>{
 assert.throws(()=>auditBendSequence(steps,planBendSequence(steps).sequence,
         {feasible:()=>({safe:true})}),TypeError);
});
