// Small validator for exactly the JSON Schema keywords used by the bundled local schema.
// Not advertised as a general JSON Schema implementation; no remote refs or code execution.
export function validateShape(value,schema,where='$'){
 const errors=[];const push=m=>errors.push(where+': '+m);
 const type=v=>v===null?'null':Array.isArray(v)?'array':Number.isInteger(v)?'integer':typeof v;
 if(schema.const!==undefined&&value!==schema.const)push('unexpected constant');
 if(schema.enum&&!schema.enum.includes(value))push('not an allowed value');
 if(schema.type){const want=Array.isArray(schema.type)?schema.type:[schema.type],got=type(value);if(!want.includes(got)&&!(got==='integer'&&want.includes('number'))){push('wrong type');return errors;}}
 if(typeof value==='string'){
  if(schema.minLength&&value.length<schema.minLength)push('too short');
  if(schema.pattern&&!new RegExp(schema.pattern).test(value))push('pattern mismatch');
 }
 if(Array.isArray(value)&&schema.items)for(let i=0;i<value.length;i++)errors.push(...validateShape(value[i],schema.items,where+'['+i+']'));
 if(value!==null&&typeof value==='object'&&!Array.isArray(value)){
  for(const key of schema.required||[])if(!Object.hasOwn(value,key))push('missing '+key);
  for(const key of Object.keys(value)){
   if(schema.properties&&Object.hasOwn(schema.properties,key))errors.push(...validateShape(value[key],schema.properties[key],where+'.'+key));
   else if(schema.additionalProperties===false)push('unknown field '+key);
  }
 }
 return errors;
}
