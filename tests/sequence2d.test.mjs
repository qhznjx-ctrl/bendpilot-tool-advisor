import test from 'node:test';
import assert from 'node:assert/strict';
import {planBendSequence} from '../src/geometry/sequence2d.mjs';
const st=(id,toolId='T1',dependencies=[],sides=['front'])=>({id,toolId,dependencies,sides});
test('honors precedence',()=>{
 assert.deepEqual(planBendSequence([st('C','T1',['B']),st('B','T1',['A']),st('A')]).sequence.map(x=>x.id),['A','B','C']);
});
test('reduces tool changes',()=>{
 const p=planBendSequence([st('A','T1'),st('B','T2'),st('C','T1')]);
 assert.equal(p.toolChanges,1);assert.deepEqual(p.sequence.slice(0,2).map(x=>x.id),['A','C']);
});
test('groups flip directions',()=>{
 const p=planBendSequence([st('A','T1',[],['back']),st('B','T1',[],['front']),st('C','T1',[],['back'])]);
 assert.equal(p.flips,1);assert.equal(p.sequence[0].id,'B');
});
test('delegates collision feasibility',()=>{
 assert.equal(planBendSequence([st('A'),st('B')],{feasible:({step})=>step.id!=='B'}).status,'NO_VALID_SEQUENCE');
});
test('detects cycles and invalid references',()=>{
 assert.equal(planBendSequence([st('A','T1',['B']),st('B','T1',['A'])]).status,'NO_VALID_SEQUENCE');
 assert.throws(()=>planBendSequence([st('A','T1',['X'])]),RangeError);
});
test('input order does not affect tie-breaks',()=>{
 const s=[st('C'),st('A'),st('B')];
 assert.deepEqual(planBendSequence(s).sequence,planBendSequence([...s].reverse()).sequence);
});
test('history-dependent collision constraint is retained',()=>{
 const p=planBendSequence([st('A'),st('B'),st('C','T1',['A','B'])],{
 feasible:({history,step})=>step.id!=='C'||history[0]?.id==='B',beamWidth:64});
 assert.equal(p.status,'OK');assert.deepEqual(p.sequence.map(x=>x.id),['B','A','C']);
});

test('invalid collision predicate result is rejected instead of authorizing a bend',()=>{
 assert.throws(()=>planBendSequence([st('A')],{feasible:()=>({possible:true})}),TypeError);
 assert.equal(planBendSequence([st('A')],{feasible:()=>false}).status,'NO_VALID_SEQUENCE');
});
