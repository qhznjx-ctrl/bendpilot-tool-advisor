/** Collision evidence gate for planned operations. No automatic approval. */
export function reviewCollisionEvidence(sequence, reports) {
  if(!Array.isArray(sequence)||!sequence.length||!Array.isArray(reports))
    throw new RangeError('nonempty sequence and reports required');
  const ids=new Set();
  for(const op of sequence){
    if(!op||typeof op.id!=='string'||!op.id||ids.has(op.id))
      throw new RangeError('duplicate or invalid bend operation');
    ids.add(op.id);
  }
  const evidence=new Map();
  for(const item of reports){
    if(!item||typeof item.bend_id!=='string'||evidence.has(item.bend_id)||!ids.has(item.bend_id)||
      !['HIT','UNVERIFIED'].includes(item.status)||item.validated_clearance!==false)
      throw new RangeError('invalid, duplicate or unsupported collision evidence');
    evidence.set(item.bend_id,item);
  }
  const collisions=sequence.filter(x=>evidence.get(x.id)?.status==='HIT').map(x=>x.id);
  const unverified=sequence.filter(x=>!evidence.has(x.id)||evidence.get(x.id)?.status==='UNVERIFIED').map(x=>x.id);
  return {status:collisions.length?'BLOCKED_COLLISION_WITNESS':'REVIEW_REQUIRED',
          collisions,unverified,manufacturing_ready:false,
          note:'Discrete geometry results cannot establish swept, tool or machine clearance.'};
}
