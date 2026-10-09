/** Risk summary for witnessed sheet-thickness proximity in candidate bend sequences.
 * Does NOT certify manufacturability, even if all sampled poses are unverified.
 */
export function summarizeThicknessReview(sequence,evidence){
 if(!Array.isArray(sequence)||!sequence.length||!Array.isArray(evidence))throw new RangeError('invalid evidence');
 const ids=sequence.map(x=>x?.id);
 if(ids.some(x=>typeof x!=='string'||!x)||new Set(ids).size!==ids.length)
   throw new RangeError('invalid sequence');
 const map=new Map();
 for(const r of evidence){
   if(!r||!ids.includes(r.bend_id)||map.has(r.bend_id)||
      !['HIT','UNVERIFIED'].includes(r.status)||r.validated_clearance!==false)
     throw new RangeError('invalid or duplicate clearance report');
   map.set(r.bend_id,r);
 }
 const collisions=ids.filter(id=>map.get(id)?.status==='HIT');
 const unverified=ids.filter(id=>map.get(id)?.status!=='HIT');
 return {status:collisions.length?'BLOCKED_COLLISION_WITNESS':'ENGINEERING_REVIEW_REQUIRED',
         collision_ids:collisions,review_ids:unverified,
         inspected:map.size,expected:ids.length,manufacturing_ready:false,
         note:'2D thickness exclusion does not certify machine, tool or dynamic clearance.'};
}
