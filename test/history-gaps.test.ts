import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyHash, gapReferences, splitGapRanges } from '../src/history-gaps.js';
import { parseGapRequest } from '../src/history-gap-request.js';
const evidenceSha256='a'.repeat(64),referencesSha256='b'.repeat(64);
test('historical gaps split the three evidenced intervals without overlap, at most 10000 numeric IDs each',()=>{
 const ranges=[['46671511','46800030'],['46800031','46839630'],['46839631','46856400']].map(([start,end])=>({date:'2026-10-28',start:start!,end:end!}));
 const blocks=splitGapRanges({evidenceSha256,referencesSha256,ranges});
 assert.equal(blocks.length,19);
 assert.equal(blocks.reduce((n,b)=>n+Number(BigInt(b.end)-BigInt(b.start)+1n),0),184890);
 assert.ok(blocks.every(b=>BigInt(b.end)-BigInt(b.start)<10000n));
 assert.equal(blocks[0]!.start,ranges[0]!.start);assert.equal(blocks.at(-1)!.end,ranges.at(-1)!.end);
 for(const bad of [{...ranges[0]!,date:'2026-09-01'},{...ranges[0]!,start:'1'},{...ranges[0]!,end:'9223372036854775808'}])
  assert.throws(()=>splitGapRanges({evidenceSha256,referencesSha256,ranges:[bad]}));
 assert.throws(()=>splitGapRanges({evidenceSha256,referencesSha256,ranges:[ranges[0]!,ranges[0]!]}),/GAP_RANGE_OVERLAP/);
});
test('gap references are hash bound, preserve names verbatim and reject ambiguous or extraneous data',()=>{
 const body=JSON.stringify({users:[['7',' Agent ']],campaigns:[],dispositions:[]});
 assert.equal(gapReferences(body,bodyHash(body)).users.get('7'),' Agent ');
 assert.throws(()=>gapReferences(body,evidenceSha256),/GAP_REFERENCES_CHANGED/);
 for(const v of [{users:[['7','A'],['7','B']],campaigns:[],dispositions:[]},{users:[],campaigns:[],dispositions:[],Password:'never accepted'}]){
  const raw=JSON.stringify(v);assert.throws(()=>gapReferences(raw,bodyHash(raw)),/GAP_REFERENCES_INVALID/);
 }
});
test('existing positional capture is unchanged; new CLI scope rejects duplicate and unused parameters',()=>{
 assert.equal(parseGapRequest('capture-reread',['parent','2026-10-28','1','2']),undefined);
 assert.deepEqual(parseGapRequest('capture-reread',['--prepare','request.json','--output','plan.json']),{kind:'prepare',input:'request.json',output:'plan.json'});
 assert.throws(()=>parseGapRequest('capture-reread',['--prepare','a','--prepare','b']),/GAP_PARAMETERS_INVALID/);
 assert.throws(()=>parseGapRequest('capture-reread',['--status','id','--force','true']),/GAP_PARAMETERS_INVALID/);
});
