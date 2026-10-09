import test from 'node:test';
import assert from 'node:assert/strict';
import {toolContourInMachineFrame,posedToolCollision} from '../src/geometry/tool-placement2d.mjs';
const tool=[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
test('machine offset changes collision outcome',()=>{
 const line=[{x:5,y:0.5},{x:7,y:0.5}];
 assert.equal(posedToolCollision(line,tool,{translateX:5}),true);
 assert.equal(posedToolCollision(line,tool,{translateX:20}),false);
});
test('placement angle rotates contour rather than sheet geometry',()=>{
 const shape=toolContourInMachineFrame(tool,{rotationDeg:90});
 assert.ok(Math.abs(shape[1].x)<1e-9&&Math.abs(shape[1].y-1)<1e-9);
 assert.deepEqual(tool, [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}]);
});
test('malformed transform rejected',()=>{
 assert.throws(()=>toolContourInMachineFrame(tool,{rotationDeg:NaN}),RangeError);
 assert.throws(()=>toolContourInMachineFrame([]),RangeError);
});
