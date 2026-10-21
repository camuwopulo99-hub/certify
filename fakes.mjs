// In-memory stand-ins for Supabase (PostgREST subset) and Google Drive/Sheets, used by the tests.
import {randomUUID} from 'node:crypto';
const UNIQUE={students:['roll_no'],certificates:['drive_file_id'],removed_keys:['key'],profiles:['id']};
const HAS_ID=new Set(['certificates','notifications','audit_logs','sync_reports']);
export class FakeDB{
  constructor(){this.t={students:[],certificates:[],notifications:[],audit_logs:[],sync_reports:[],removed_keys:[],profiles:[],settings:[{id:1,drive_folder_id:'FOLDER',drive_folder_name:'Class Certificates',spreadsheet_id:'SHEET',sheet_name:'Form Responses 1'}]};this.v=0;}
  from(n){return new Q(this,n);}
  rows(n){ if(n!=='student_status')return this.t[n];
    return this.t.students.map(s=>{const cs=this.t.certificates.filter(c=>c.roll_no===s.roll_no),d=cs.filter(c=>c.in_drive).length,sh=cs.filter(c=>c.in_sheet).length;
      return {...s,drive_files:d,sheet_rows:sh,categories:[...new Set(cs.map(c=>c.category).filter(Boolean))],overall:d&&sh?'COMPLETED':d||sh?'PENDING':'NOT STARTED'};});}
}
class Q{
  constructor(db,t){this.db=db;this.tn=t;this.op='select';this.fs=[];this.ord=null;this.lim=null;this.rg=null;this.one=null;this.ret=false;}
  select(){if(this.op!=='select')this.ret=true;return this;}
  insert(r){this.op='insert';this.payload=r;return this;} upsert(r,o={}){this.op='upsert';this.payload=r;this.o=o;return this;}
  update(p){this.op='update';this.payload=p;return this;} delete(){this.op='delete';return this;}
  eq(c,v){this.fs.push(r=>r[c]===v);return this;} in(c,a){this.fs.push(r=>a.includes(r[c]));return this;}
  is(c,v){this.fs.push(r=>(r[c]??null)===v);return this;}
  order(c,o={}){this.ord=[c,o.ascending!==false];return this;} limit(n){this.lim=n;return this;} range(a,b){this.rg=[a,b];return this;}
  single(){this.one='single';return this;} maybeSingle(){this.one='maybe';return this;}
  then(res,rej){try{res(this.run());}catch(e){(rej||(x=>{throw x;}))(e);}}
  fail(m){return {data:null,error:{message:m}};}
  run(){
    const T=this.db.t[this.tn],match=r=>this.fs.every(f=>f(r));let out;
    if(this.op==='insert'||this.op==='upsert'){
      const list=[].concat(this.payload),made=[];
      for(const p of list){
        const row={...p};if(HAS_ID.has(this.tn))row.id??=randomUUID();if(this.tn!=='students'||true)row.created_at??=new Date(Date.now()+this.db.v).toISOString();
        if(this.tn==='students'){row.approval??='PENDING_REVIEW';row.submitted??=false;row.section??='CSE-C (2025-26)';row.feedback_reason??=null;}
        if(this.tn==='certificates'){row.in_drive??=false;row.in_sheet??=false;row.title??='';row.sheet_row??=null;row.drive_file_id??=null;row.drive_link??=null;}
        if(this.tn==='notifications'){row.is_read??=false;row.type??='NOTICE';row.sender??='Faculty Coordinator';}
        const u=(this.op==='upsert'&&this.o.onConflict?[this.o.onConflict]:UNIQUE[this.tn]||[]).filter(k=>row[k]!=null);
        const dup=u.length&&T.find(r=>u.every(k=>r[k]===row[k]));
        if(dup){if(this.op==='upsert'){if(!this.o.ignoreDuplicates)Object.assign(dup,row);continue;}return this.fail(`duplicate key value violates unique constraint (${u})`);}
        T.push(row);made.push(row);this.db.v++;
      }
      out=made;
    }else if(this.op==='update'){out=T.filter(match);out.forEach(r=>Object.assign(r,this.payload));if(out.length)this.db.v++;}
    else if(this.op==='delete'){out=T.filter(match);this.db.t[this.tn]=T.filter(r=>!out.includes(r));if(out.length)this.db.v++;}
    else{out=this.db.rows(this.tn).filter(match);}
    if(this.op==='select'||this.ret){
      if(this.ord)out=[...out].sort((a,b)=>(a[this.ord[0]]>b[this.ord[0]]?1:a[this.ord[0]]<b[this.ord[0]]?-1:0)*(this.ord[1]?1:-1));
      if(this.rg)out=out.slice(this.rg[0],this.rg[1]+1);if(this.lim!=null)out=out.slice(0,this.lim);
      out=out.map(r=>({...r}));
    }
    if(this.one){if(out.length!==1)return this.one==='maybe'&&!out.length?{data:null,error:null}:this.fail('JSON object requested, multiple (or no) rows returned');return {data:out[0],error:null};}
    return {data:(this.op==='select'||this.ret)?out:null,error:null};
  }
}
export class FakeGoogle{
  constructor(){this.files=new Map();this.rows=[['Timestamp','Roll Number','Name','Category','Title','Drive Link','Submission ID']];this.n=0;this.fail={};this.calls=[];}
  _f(k){if(this.fail[k])throw new Error(this.fail[k]);this.calls.push(k);}
  async list(){this._f('list');return [...this.files.values()].filter(f=>!f.trashed).map(({id,name,webViewLink})=>({id,name,webViewLink}));}
  async upload(folder,name,bytes){this._f('upload');const id='F'+(++this.n);this.files.set(id,{id,name,bytes:bytes?.length||0,trashed:false,webViewLink:`https://drive.google.com/file/d/${id}/view`});return {id,webViewLink:this.files.get(id).webViewLink};}
  async trash(id){this._f('trash');const f=this.files.get(id);if(f)f.trashed=true;}
  async read(){this._f('read');return this.rows.map(r=>[...r]);}
  async append(s,t,row){this._f('append');this.rows.push(row.map(String));return this.rows.length;}
  async deleteRows(s,t,rows){this._f('deleteRows');[...rows].sort((a,b)=>b-a).forEach(r=>this.rows.splice(r-1,1));}
  addFile(name){const id='F'+(++this.n);this.files.set(id,{id,name,trashed:false,webViewLink:`https://drive.google.com/file/d/${id}/view`});return id;}
  live(){return [...this.files.values()].filter(f=>!f.trashed);}
}
export const seedStudents=(db,list)=>list.forEach(([roll_no,name,email])=>db.t.students.push({roll_no,name,email:email||null,section:'CSE-C (2025-26)',approval:'PENDING_REVIEW',feedback_reason:null,submitted:false,created_at:new Date().toISOString()}));
