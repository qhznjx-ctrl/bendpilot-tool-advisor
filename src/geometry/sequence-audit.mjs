/** Validate a planned or manually edited bend order against explicit constraints.
 * External feasible callback is mandatory for real machine collision assessment;
 * default true is for algorithmic fixtures ONLY.
 */
export function auditBendSequence(steps, sequence, {feasible=()=>true}={}) {
  if(!Array.isArray(steps)||!Array.isArray(sequence)||typeof feasible!=='function')
    throw new TypeError('steps, sequence and feasibility predicate required');
  const byId=new Map();
  for(const s of steps) {
    if(!s||typeof s.id!=='string'||!s.id||byId.has(s.id)||
       typeof s.toolId!=='string'||!s.toolId||
       !Array.isArray(s.dependencies||[])) throw new RangeError('invalid bend specification');
    byId.set(s.id,s);
  }
  const completed=new Set(),history=[],errors=[];
  sequence.forEach((op,index)=>{
    const prefix=`operation[${index}]`;
    const step=op&&byId.get(op.id);
    if(!step) {errors.push(`${prefix}: unknown bend`);return;}
    if(completed.has(op.id)) {errors.push(`${prefix}: repeated bend`);return;}
    if(!(step.dependencies||[]).every(d=>completed.has(d)))
      errors.push(`${prefix}: prerequisites missing`);
    if(!['front','back'].includes(op.side)||!(step.sides||['front','back']).includes(op.side))
      errors.push(`${prefix}: unsupported workpiece side`);
    if(op.toolId!==step.toolId)
      errors.push(`${prefix}: selected die differs from step`);
    const allowed=feasible({history:history.map(x=>({...x})),step,side:op.side});
    if(typeof allowed!=='boolean') throw new TypeError('feasible must return boolean');
    if(!allowed) errors.push(`${prefix}: rejected by collision/reachability predicate`);
    completed.add(op.id);
    history.push({id:op.id,side:op.side,toolId:op.toolId});
  });
  for(const id of byId.keys()) if(!completed.has(id)) errors.push(`missing bend: ${id}`);
  return {valid:errors.length===0,errors,checked:history.length,
          note:'Feasibility reflects the supplied callback; no built-in collision geometry.'};
}
