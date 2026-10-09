import test from 'node:test';
import assert from 'node:assert/strict';
import {rotateAround,reflectAcrossLine,bendVertices,signedTurnDegrees} from '../src/geometry/rigid2d.mjs';
const near=(p,q)=>{assert.ok(Math.abs(p.x-q.x)<1e-8);assert.ok(Math.abs(p.y-q.y)<1e-8);};
test('signed inward/outward angles create opposite motion without mutating input',()=>{
 const v=[{x:0,y:0},{x:10,y:0},{x:20,y:0}];
 near(bendVertices(v,1,[2],90)[2],{x:10,y:10});
 near(bendVertices(v,1,[2],-90)[2],{x:10,y:-10});
 near(v[2],{x:20,y:0});
});
test('flip twice restores point',()=>{
 const p={x:9,y:-7},a={x:2,y:1},b={x:11,y:6};
 near(reflectAcrossLine(reflectAcrossLine(p,a,b),a,b),p);
});
test('mirror reverses signed rotation: F R(theta) = R(-theta) F',()=>{
 const p={x:8,y:4},o={x:0,y:0},a={x:-5,y:0},b={x:7,y:0};
 for(const t of [-140,-90,-35,0,35,90,140]) near(
  reflectAcrossLine(rotateAround(p,o,t),a,b),
  rotateAround(reflectAcrossLine(p,a,b),o,-t));
});
test('inverse rotations cancel',()=>{
 const p={x:17,y:-2},o={x:3,y:9};
 near(rotateAround(rotateAround(p,o,-135),o,135),p);
});
test('invalid input rejected',()=>{
 assert.throws(()=>reflectAcrossLine({x:0,y:0},{x:1,y:1},{x:1,y:1}),RangeError);
 assert.throws(()=>bendVertices([{x:0,y:0}],0,[0],35),RangeError);
 assert.throws(()=>rotateAround({x:NaN,y:0},{x:0,y:0},5),RangeError);
});

test('signed turn reverses across a mirrored workpiece',()=>{
 const prev={x:0,y:0},hinge={x:5,y:0},next={x:5,y:8};
 const flip=p=>reflectAcrossLine(p,{x:0,y:0},{x:10,y:0});
 const before=signedTurnDegrees(prev,hinge,next);
 const after=signedTurnDegrees(flip(prev),flip(hinge),flip(next));
 assert.ok(Math.abs(before+after)<1e-8);
});
test('zero-length fold edges are invalid',()=>{
 assert.throws(()=>signedTurnDegrees({x:0,y:0},{x:0,y:0},{x:5,y:1}),RangeError);
});
