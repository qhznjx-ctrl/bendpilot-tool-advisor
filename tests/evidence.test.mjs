import test from 'node:test';
import assert from 'node:assert/strict';
import {planBendSequence} from '../src/geometry/sequence2d.mjs';
import {auditBendSequence} from '../src/geometry/sequence-audit.mjs';
const steps=[{id:'A',toolId:'T1',sides:['front']}];
test('algorithmic sequence is not manufacturing certified',()=>{
 const p=planBendSequence(steps);assert.equal(p.status,'OK');
 assert.equal(p.collisionCallbackUsed,false);assert.equal(p.manufacturingReady,false);
 const a=auditBendSequence(steps,p.sequence);
 assert.equal(a.valid,true);assert.equal(a.collision_callback_used,false);
 assert.equal(a.manufacturing_ready,false);
});
test('externally checked sequence still needs machine validation',()=>{
 const feasible=()=>true, p=planBendSequence(steps,{feasible});
 const a=auditBendSequence(steps,p.sequence,{feasible,evidenceId:'fixture-1'});
 assert.equal(p.collisionCallbackUsed,true);assert.equal(a.evidence_id,'fixture-1');
 assert.equal(a.manufacturing_ready,false);
});
