import test from 'node:test';
import assert from 'node:assert/strict';
import {segmentsIntersect,polylineHitsPolygon} from '../src/geometry/collision2d.mjs';
const square=[{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}];
test('crossing and boundary contact',()=>{
 assert.equal(segmentsIntersect({x:-2,y:5},{x:12,y:5},{x:0,y:0},{x:0,y:10}),true);
 assert.equal(segmentsIntersect({x:-2,y:11},{x:12,y:11},{x:0,y:0},{x:10,y:0}),false);
});
test('through polygon without endpoint inside',()=>{
 assert.equal(polylineHitsPolygon([{x:-5,y:5},{x:15,y:5}],square),true);
});
test('inside and outside',()=>{
 assert.equal(polylineHitsPolygon([{x:1,y:2},{x:2,y:3}],square),true);
 assert.equal(polylineHitsPolygon([{x:-3,y:12},{x:13,y:12}],square),false);
});
test('endpoint contact is collision',()=>{
 assert.equal(polylineHitsPolygon([{x:-2,y:0},{x:0,y:0}],square),true);
});
test('concave obstacle',()=>{
 const p=[{x:0,y:0},{x:4,y:0},{x:4,y:1},{x:1,y:1},{x:1,y:4},{x:0,y:4}];
 assert.equal(polylineHitsPolygon([{x:2,y:2},{x:3,y:3}],p),false);
 assert.equal(polylineHitsPolygon([{x:0.3,y:3},{x:0.7,y:3}],p),true);
});
test('invalid geometry fails',()=>{
 assert.throws(()=>polylineHitsPolygon([{x:0,y:0},{x:3,y:3}],[{x:0,y:0},{x:1,y:1},{x:2,y:2}]),RangeError);
 assert.throws(()=>polylineHitsPolygon([{x:0,y:0},{x:NaN,y:3}],square),RangeError);
});

test('self-crossing polygon is rejected even if signed area nonzero',()=>{
 const bow=[{x:0,y:0},{x:5,y:5},{x:0,y:4},{x:5,y:0},{x:4,y:-1}];
 assert.throws(()=>polylineHitsPolygon([{x:6,y:6},{x:7,y:7}],bow),RangeError);
});
test('zero-length polygon edge rejected',()=>{
 const invalid=[{x:0,y:0},{x:4,y:0},{x:4,y:0},{x:4,y:4},{x:0,y:4}];
 assert.throws(()=>polylineHitsPolygon([{x:6,y:6},{x:7,y:7}],invalid),RangeError);
});
