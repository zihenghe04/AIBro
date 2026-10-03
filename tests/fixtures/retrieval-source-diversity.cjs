'use strict';
const query='Compare calibration accuracy reproducibility';
const scope={projectId:'study'};
const strong='calibration accuracy reproducibility evidence '.repeat(20);
function fixture(weak=false){
 return {projects:[{id:'study',name:'Synthetic study',workspace:'科研'},{id:'other',name:'Other project',workspace:'科研'}],notes:[
  {id:'many',projectId:'study',title:'Calibration accuracy reproducibility',pages:Array.from({length:48},(_,i)=>({page:i+1,text:strong+' result '+i}))},
  ...(weak?Array.from({length:40},(_,i)=>({id:'weak'+i,projectId:'study',title:'Other subject',content:'calibration '+('unrelated garden art '.repeat(50))})):
   ['survey','experiment','limitations'].map(id=>({id,projectId:'study',title:'Calibration accuracy reproducibility '+id,content:strong+' separate sample'}))),
 ]};
}
function memory(){
 const rows=new Map();
 return {rows,async load(profile){return [...rows.values()].filter(r=>r.profile===profile).map(r=>structuredClone(r));},async write(profile,puts=[],removes=[]){for(const id of removes)rows.delete(profile+id);for(const r of puts)rows.set(profile+r.id,{...structuredClone(r),profile});}};
}
module.exports={fixture,memory,query,scope,strong};
