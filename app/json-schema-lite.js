/* JSON Schema subset validator for tool arguments. No dependencies, no DOM.
   Supports type, const, enum, required, properties, additionalProperties,
   dependentRequired, minLength/maxLength, minimum/maximum, items/maxItems/minItems
   and oneOf. Unsupported keywords are rejected when a schema is compiled, so a
   spec can never look stricter than what is actually enforced. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.JsonSchemaLite=api;})(globalThis,()=>{
  'use strict';
  const KNOWN=new Set(['type','const','enum','required','properties','additionalProperties','dependentRequired','minLength','maxLength','minimum','maximum','items','minItems','maxItems','oneOf','description','title','default','examples']);
  const TYPES=new Set(['object','array','string','number','integer','boolean','null']);
  function check(schema,path='#'){
    if(schema===true||schema===false)return;
    if(!schema||typeof schema!=='object'||Array.isArray(schema))throw TypeError('Schema must be an object at '+path);
    for(const key of Object.keys(schema))if(!KNOWN.has(key))throw TypeError('Unsupported schema keyword '+key+' at '+path);
    for(const type of [].concat(schema.type||[]))if(!TYPES.has(type))throw TypeError('Unknown schema type '+type+' at '+path);
    if(schema.properties)for(const [name,child] of Object.entries(schema.properties))check(child,path+'/properties/'+name);
    if(schema.additionalProperties!==undefined&&typeof schema.additionalProperties!=='boolean')check(schema.additionalProperties,path+'/additionalProperties');
    if(schema.items)check(schema.items,path+'/items');
    if(schema.oneOf)schema.oneOf.forEach((child,i)=>check(child,path+'/oneOf/'+i));
  }
  const typeOf=value=>value===null?'null':Array.isArray(value)?'array':Number.isInteger(value)?'integer':typeof value;
  const matchesType=(value,type)=>type==='number'?typeof value==='number'&&Number.isFinite(value):type==='integer'?Number.isSafeInteger(value):typeOf(value)===type;
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  function validate(schema,value,path='',errors=[]){
    if(schema===true)return errors;
    if(schema===false){errors.push({path,message:'not allowed'});return errors;}
    const types=[].concat(schema.type||[]);
    if(types.length&&!types.some(type=>matchesType(value,type))){errors.push({path,message:'must be '+types.join('|')});return errors;}
    if('const' in schema&&!same(schema.const,value))errors.push({path,message:'must equal '+JSON.stringify(schema.const)});
    if(schema.enum&&!schema.enum.some(item=>same(item,value)))errors.push({path,message:'must be one of '+schema.enum.map(x=>JSON.stringify(x)).join(', ')});
    if(typeof value==='string'){
      // UTF-16 length, matching the host checks these schemas replace (JSON
      // Schema counts code points; the difference only tightens for emoji).
      const length=value.length;
      if(schema.minLength!==undefined&&length<schema.minLength)errors.push({path,message:'shorter than '+schema.minLength});
      if(schema.maxLength!==undefined&&length>schema.maxLength)errors.push({path,message:'longer than '+schema.maxLength});
    }
    if(typeof value==='number'){
      if(schema.minimum!==undefined&&value<schema.minimum)errors.push({path,message:'below '+schema.minimum});
      if(schema.maximum!==undefined&&value>schema.maximum)errors.push({path,message:'above '+schema.maximum});
    }
    if(Array.isArray(value)){
      if(schema.minItems!==undefined&&value.length<schema.minItems)errors.push({path,message:'fewer than '+schema.minItems+' items'});
      if(schema.maxItems!==undefined&&value.length>schema.maxItems)errors.push({path,message:'more than '+schema.maxItems+' items'});
      if(schema.items)value.forEach((item,i)=>validate(schema.items,item,path+'/'+i,errors));
    }
    if(typeOf(value)==='object'){
      const properties=schema.properties||{};
      for(const name of schema.required||[])if(!Object.hasOwn(value,name))errors.push({path:path+'/'+name,message:'is required'});
      for(const [name,needs] of Object.entries(schema.dependentRequired||{}))if(Object.hasOwn(value,name))for(const other of needs)if(!Object.hasOwn(value,other))errors.push({path:path+'/'+other,message:'is required with '+name});
      for(const [name,item] of Object.entries(value)){
        if(Object.hasOwn(properties,name))validate(properties[name],item,path+'/'+name,errors);
        else if(schema.additionalProperties===false)errors.push({path:path+'/'+name,message:'is not allowed'});
        else if(schema.additionalProperties&&typeof schema.additionalProperties==='object')validate(schema.additionalProperties,item,path+'/'+name,errors);
      }
    }
    if(schema.oneOf){
      const passing=schema.oneOf.filter(child=>!validate(child,value,path,[]).length).length;
      if(passing!==1)errors.push({path,message:'must match exactly one schema'});
    }
    return errors;
  }
  return {check,validate};
});
