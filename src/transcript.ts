// Purpose: Validate worker transcript unions and bind assistant replay to exact broker-issued messages.
import { createHash } from 'node:crypto';
function fail(): never { throw new Error('Invalid transcript'); }
function object(v: any) { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(); }
function keys(v: any, allowed: string[]) { object(v); if (Object.keys(v).some(k=>!allowed.includes(k))) fail(); }
function text(v: any) { if(typeof v!=='string')fail(); }
function stamp(v: any) { if(typeof v!=='number'||!Number.isFinite(v))fail(); }
function canonical(v: any): string { if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v); }
const hash=(v:any)=>createHash('sha256').update(canonical(v)).digest('hex');
function content(value: any, images: boolean) {
 if(typeof value==='string')return;
 if(!Array.isArray(value))fail();
 for(const block of value){
  if(block?.type==='text'){keys(block,['type','text']);text(block.text);}
  else if(images&&block?.type==='image'){keys(block,['type','data','mimeType']);text(block.data);if(!/^image\/(png|jpeg|gif|webp)$/.test(block.mimeType)|| !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data))fail();}
  else fail();
 }
}
export class TranscriptGuard {
 private issued=new Set<string>();
 issue(message: unknown) { this.issued.add(hash(JSON.parse(JSON.stringify(message)))); }
 validate(messages: any[]) {
  for(const m of messages){
   object(m);
   if(m.role==='assistant') { if(!this.issued.has(hash(m)))fail(); continue; }
   if(m.role==='system'){
    keys(m,['role','content','sections','toolsAdded','toolsRemoved','timestamp']);content(m.content,false);
    if(m.sections!==undefined){object(m.sections);for(const v of Object.values(m.sections))if(v!==null)text(v);}
    if(m.toolsAdded!==undefined){if(!Array.isArray(m.toolsAdded))fail();for(const t of m.toolsAdded){keys(t,['name','description','parameters','constrainedSampling']);text(t.name);text(t.description);object(t.parameters);if(t.constrainedSampling!==undefined&&t.constrainedSampling!==false){keys(t.constrainedSampling,['type','strict']);if(t.constrainedSampling.type!=='json_schema'||!['prefer','require'].includes(t.constrainedSampling.strict))fail();}}}
    if(m.toolsRemoved!==undefined){if(!Array.isArray(m.toolsRemoved))fail();for(const t of m.toolsRemoved){keys(t,['name']);text(t.name);}}
   }else if(m.role==='user'){keys(m,['role','content','timestamp']);content(m.content,true);}
   else if(m.role==='toolResult'){keys(m,['role','toolCallId','toolName','content','isError','timestamp','details']);text(m.toolCallId);text(m.toolName);if(typeof m.isError!=='boolean')fail();if(!Array.isArray(m.content))fail();content(m.content,true);delete m.details;}
   else fail();
   stamp(m.timestamp);
  }
 }
}
