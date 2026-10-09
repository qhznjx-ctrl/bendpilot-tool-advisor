import test from 'node:test';
import assert from 'node:assert/strict';
import {segmentGap,sheetToolClearanceWitness} from '../src/geometry/thickness-clearance2d.mjs';
const t=(y=0)=>[{x:0,y},{x:4,y}];
const rect=(x1,y1,x2,y2)=>[{x:x1,y:y1},{x:x2,y:y1},{x:x2,y:y2},{x:x1,y:y2}];
test('nonpenetrating thick sheet near tool is a collision witness',()=>{
 const r=sheetToolClearanceWitness(t(),rect(1,.7,2,1.5),{thicknessMm:2});
 assert.equal(r.status,'HIT');assert.ok(r.minimum_gap_mm>.69);
 assert.equal(r.required_gap_mm,1);assert.equal(r.validated_clearance,false);
});
test('no observed hit remains unverified',()=>{
 const r=sheetToolClearanceWitness(t(),rect(1,3,2,4),{thicknessMm:2});
 assert.equal(r.status,'UNVERIFIED');assert.equal(r.validated_clearance,false);
});
test('intersecting segments have zero distance',()=>{
 assert.equal(segmentGap({x:0,y:0},{x:2,y:2},{x:0,y:2},{x:2,y:0}),0);
});
test('margin increases exclusion threshold',()=>{
 assert.equal(sheetToolClearanceWitness(t(),rect(1,1.2,2,2),{thicknessMm:2,marginMm:.3}).status,'HIT');
});
test('invalid geometry fails closed',()=>{
 assert.throws(()=>sheetToolClearanceWitness(t(),rect(1,2,2,3),{thicknessMm:0}),RangeError);
 assert.throws(()=>sheetToolClearanceWitness(t(),[{x:0,y:0},{x:2,y:2},{x:0,y:2},{x:2,y:0},{x:1,y:-1}],{thicknessMm:2}),RangeError);
});
