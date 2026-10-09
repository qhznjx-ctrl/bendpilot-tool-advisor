/** Deterministic bounded beam-search operation planner, not a collision engine. */
export function planBendSequence(steps, {
  initialSide='front',initialTool=null,beamWidth=64,
  flipCost=5,toolChangeCost=3,stepCost=1,feasible=()=>true
}={}) {
  if (!Array.isArray(steps)||!steps.length||steps.length>64) throw new RangeError('invalid steps');
  if (!['front','back'].includes(initialSide)||!Number.isInteger(beamWidth)||beamWidth<1||beamWidth>512||
      ![flipCost,toolChangeCost,stepCost].every(x=>Number.isFinite(x)&&x>=0)||typeof feasible!=='function')
    throw new RangeError('invalid planner options');
  const ids=new Set();
  for(const s of steps) {
    if(!s||typeof s.id!=='string'||!s.id.trim()||ids.has(s.id)||typeof s.toolId!=='string'||
       !s.toolId.trim()||!Array.isArray(s.dependencies||[])||
       !(s.sides===undefined||(Array.isArray(s.sides)&&s.sides.length>0&&s.sides.every(x=>['front','back'].includes(x)))))
      throw new RangeError('invalid or duplicate step');
    ids.add(s.id);
  }
  for(const s of steps) {
    const deps=s.dependencies||[];
    if(deps.some(d=>!ids.has(d)||d===s.id)||new Set(deps).size!==deps.length)
      throw new RangeError('invalid dependency '+s.id);
  }
  const ordered=[...steps].sort((a,b)=>a.id.localeCompare(b.id,'en'));
  let frontier=[{done:new Set(),history:[],side:initialSide,tool:initialTool,cost:0,flips:0,toolChanges:0}];
  let explored=0;
  for(let depth=0;depth<steps.length;depth++) {
    const next=[];
    for(const state of frontier) for(const step of ordered) {
      if(state.done.has(step.id)||!(step.dependencies||[]).every(d=>state.done.has(d))) continue;
      for(const side of [...new Set(step.sides||['front','back'])].sort()) {
        const allowed=evaluate({history:state.history.map(x=>({...x})),step,side});
        if(typeof allowed!=='boolean') throw new TypeError('feasible must return boolean');
        if(!allowed) continue;
        explored++;
        const flip=side!==state.side,change=state.tool!==null&&state.tool!==step.toolId;
        next.push({done:new Set([...state.done,step.id]),
          history:[...state.history,{id:step.id,side,toolId:step.toolId}],
          side,tool:step.toolId,cost:state.cost+stepCost+(flip?flipCost:0)+(change?toolChangeCost:0),
          flips:state.flips+Number(flip),toolChanges:state.toolChanges+Number(change)});
      }
    }
    if(!next.length) return {status:'NO_VALID_SEQUENCE',sequence:[],reason:'Constraints blocked',explored};
    next.sort((a,b)=>a.cost-b.cost||a.flips-b.flips||a.toolChanges-b.toolChanges||
      a.history.map(x=>x.id+'@'+x.side).join('|').localeCompare(b.history.map(x=>x.id+'@'+x.side).join('|'),'en'));
    // History matters to an injected feasibility callback: do not prune by only the done-set.
    frontier=next.slice(0,beamWidth);
  }
  const best=frontier[0];
  return {status:'OK',sequence:best.history,cost:best.cost,flips:best.flips,
          toolChanges:best.toolChanges,explored,algorithm:'bounded-beam-search',globallyOptimal:false,collisionCallbackUsed,manufacturingReady:false};
}
