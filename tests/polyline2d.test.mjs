import test from 'node:test';
import assert from 'node:assert/strict';
import {bendPolyline,flipPolyline} from '../src/geometry/polyline2d.mjs';
import {signedTurnDegrees} from '../src/geometry/rigid2d.mjs';
const near=(a,b)=> {assert.ok(Math.abs(a.x-b.x)<1e-8);assert.ok(Math.abs(a.y-b.y)<1e-8);};
const part=[{x:0,y:0},{x:10,y:0},{x:20,y:0},{x:30,y:0}];
test('move right flange around hinge without mutating workpiece',()=>{
  const output=bendPolyline(part,1,'right',90);
  near(output[0],part[0]);near(output[1],part[1]);
  near(output[2],{x:10,y:10});near(output[3],{x:10,y:20});near(part[3],{x:30,y:0});
});
test('move left flange with reverse bend',()=>{
  const output=bendPolyline(part,2,'left',-90);
  near(output[0],{x:20,y:20});near(output[1],{x:20,y:10});near(output[2],part[2]);near(output[3],part[3]);
});
test('flip is an involution for every polyline vertex',()=>{
  const f=flipPolyline(part,{x:0,y:0},{x:0,y:20});
  flipPolyline(f,{x:0,y:0},{x:0,y:20}).forEach((p,i)=>near(p,part[i]));
});
test('signed hinge turn changes sign after reflecting bent polyline',()=>{
  const bent=bendPolyline(part,1,'right',35);
  const flip=flipPolyline(bent,{x:0,y:0},{x:20,y:0});
  const before=signedTurnDegrees(bent[0],bent[1],bent[2]);
  const after=signedTurnDegrees(flip[0],flip[1],flip[2]);
  assert.ok(Math.abs(before+after)<1e-8);
});
test('invalid hinge and side fail fast',()=>{
  assert.throws(()=>bendPolyline(part,0,'right',45),RangeError);
  assert.throws(()=>bendPolyline(part,1,'both',45),RangeError);
  assert.throws(()=>flipPolyline([],{x:0,y:0},{x:1,y:0}),RangeError);
});
