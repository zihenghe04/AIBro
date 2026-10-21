// Writes a deterministic parity fixture for tests/native-vector-store.swift:
// vectors, a query, and the scores VectorIndex.cosine gives in the page.
const fs=require('node:fs'),V=require('../app/vector-index');
let seed=20261022;const random=()=>((seed=(seed*1103515245+12345)%2147483648)/2147483648)*2-1;
const hash=i=>i.toString(16).padStart(64,'0');
// Even rows look like provider output (exact in Float32); odd rows need Float64.
const rows=Array.from({length:40},(_,i)=>({id:`chunk-${String(i).padStart(2,'0')}`,hash:hash(i+1),updatedAt:1700000000000+i,
  vector:Array.from({length:64},()=>i%2?random():Math.fround(random()))}));
const query=Array.from({length:64},()=>random());
const expected=Object.fromEntries(rows.map(r=>[r.id,V.cosine(query,r.vector)]));
fs.writeFileSync(process.argv[2],JSON.stringify({rows,query,expected}));
