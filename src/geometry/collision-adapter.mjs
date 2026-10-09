/** Bridge algorithmic bend sequencing to an injected sampled-motion inspector.
 * The inspector may be provided by the geometry branch. A missing inspector
 * must NEVER silently mean machine clearance: all resulting paths remain unverified.
 */
export function createCollisionAwarePredicate(inspectStep) {
  if (typeof inspectStep !== 'function') throw new TypeError('inspectStep function required');
  let evaluated=0,hits=0;
  function feasible({history,step,side}) {
    if(!Array.isArray(history)||!step||!['front','back'].includes(side))
      throw new RangeError('invalid bend planner invocation');
    const result=inspectStep({history:history.map(x=>({...x})),step,side});
    if(!result||!['HIT','UNVERIFIED'].includes(result.status)||
       result.validated_clearance!==false)
      throw new TypeError('collision inspector must return HIT or UNVERIFIED with validated_clearance=false');
    evaluated++;
    if(result.status==='HIT') {hits++;return false;}
    return true;  // A valid search CANDIDATE, not a collision clearance.
  }
  return {feasible,statistics:()=>({evaluated,hits,
    manufacturing_ready:false,clearance_certified:false,
    note:'UNVERIFIED permits candidate ranking only; real machine clearance not established.'})};
}
