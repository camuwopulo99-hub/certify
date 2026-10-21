// Test server: serves the site and runs the REAL core.ts (upload / sync / remove / system check) against FakeDB + FakeGoogle.
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import {Readable} from 'node:stream';import {fileURLToPath} from 'node:url';
import {FakeDB,FakeGoogle,seedStudents} from './fakes.mjs';
import {syncCore,uploadCore,removeCerts,findDuplicates,systemCheck,resolveUploadRoll} from '../supabase/functions/_shared/core.ts';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),PORT=+process.env.PORT||8765;
let db,g;
function reset(){
  db=new FakeDB();g=new FakeGoogle();
  const seed=fs.readFileSync(path.join(ROOT,'supabase/seed.sql'),'utf8'),rows=[...seed.matchAll(/\('([^']+)','((?:[^']|'')*)'\)/g)].map(m=>[m[1],m[2].replace(/''/g,"'")]);
  seedStudents(db,rows.map(([r,n])=>[r,n,r==='25A31A05GB'?'student@test.com':r==='25A31A05GC'?'student2@test.com':null]));
  db.t.profiles.push({id:'f1',email:'fac@test.com',full_name:'Jayaram Sappa',role:'faculty',roll_no:null},
    {id:'s1',email:'student@test.com',full_name:'Sappa Jayaram',role:'student',roll_no:'25A31A05GB'},
    {id:'s2',email:'student2@test.com',full_name:'Other Student',role:'student',roll_no:'25A31A05GC'},
    {id:'s3',email:'unlinked@test.com',full_name:'Unlinked',role:'student',roll_no:null});
}
reset();
const log=(actor,action,details,category)=>db.from('audit_logs').insert({actor,action,details,category});
const grp=(p)=>db.rows('student_status').filter(s=>({NOT_STARTED:s.overall==='NOT STARTED',PENDING:s.overall==='PENDING',REJECTED:s.approval==='REJECTED',APPROVED:s.approval==='APPROVED',DEFAULTERS:s.overall!=='COMPLETED'||s.approval==='REJECTED'}[p]??true));
const RPC={
  approve_student:(u,a)=>{db.from('students').update({approval:'APPROVED',feedback_reason:null}).eq('roll_no',a.p_roll).run();db.from('notifications').insert({roll_no:a.p_roll,title:'Certificate Approved',message:'Congratulations! Your certificate submission has been verified and registered into official accreditation records.',type:'APPROVAL'}).run();log(u.email,'APPROVE_CERTIFICATE','Approved '+a.p_roll,'FACULTY_REVIEW').run();return null;},
  reject_student:(u,a)=>{db.from('students').update({approval:'REJECTED',feedback_reason:a.p_reason}).eq('roll_no',a.p_roll).run();db.from('notifications').insert({roll_no:a.p_roll,title:'Action Required: Re-upload Certificate',message:`Your certificate could not be accepted. Reason: ${a.p_reason}. Please re-upload a clear copy as soon as possible.`,type:'REJECTION'}).run();log(u.email,'REJECT_CERTIFICATE',`Requested re-upload for ${a.p_roll}: ${a.p_reason}`,'FACULTY_REVIEW').run();return null;},
  notify_student:(u,a)=>{db.from('notifications').insert({roll_no:a.p_roll,title:a.p_title,message:a.p_message,type:a.p_type||'NOTICE'}).run();return null;},
  broadcast_alert:(u,a)=>{const t=grp(a.p_group);t.forEach(s=>db.from('notifications').insert({roll_no:s.roll_no,title:a.p_title,message:a.p_message,type:a.p_priority||'NOTICE',sender:a.p_sender||'Faculty Coordinator'}).run());log(u.email,'BROADCAST_ALERT',`Sent alert to ${a.p_group} (${t.length})`,'ADMIN_BROADCAST').run();return t.length;},
};
const send=(res,s,o,type='application/json')=>{res.writeHead(s,{'Content-Type':type});res.end(type==='application/json'?JSON.stringify(o):o);};
const body=async req=>{const c=[];for await(const x of req)c.push(x);return Buffer.concat(c);};
const profile=req=>db.t.profiles.find(p=>p.id===req.headers['x-user']);
const FACULTY_ONLY=['sync_reports','audit_logs','settings','removed_keys'];
function api(req,res,b){
  const u=profile(req);if(!u)return send(res,200,{data:null,error:{message:'JWT required'}});
  let steps=b.steps,t=b.table;const op=(steps.find(s=>['insert','upsert','update','delete'].includes(s[0]))||['select'])[0];
  if(u.role==='student'){                                          // emulate the row-level-security policies
    const ok_=op==='select'||(t==='notifications'&&op==='update'&&Object.keys(steps.find(s=>s[0]==='update')[1]).every(k=>k==='is_read'));
    if(!ok_)return send(res,200,{data:null,error:{message:'new row violates row-level security policy'}});
    if(FACULTY_ONLY.includes(t)||t==='removed_keys')return send(res,200,{data:steps.some(s=>s[0]==='single')?null:[],error:steps.some(s=>s[0]==='single')?{message:'no rows'}:null});
    steps=[...steps,t==='profiles'?['eq','id',u.id]:['eq','roll_no',u.roll_no||'__none__']];
  }
  let q=db.from(t);for(const [m,...a] of steps)q=q[m](...a);
  const r=q.run();send(res,200,r);
}
async function fn(req,res,name){
  const u=profile(req);if(!u)return send(res,401,{error:'Not signed in'});
  const cfg=db.t.settings[0];
  try{
    if(name==='upload-certificate'){
      const fd=await new Request('http://x/',{method:'POST',headers:{'content-type':req.headers['content-type']},body:Readable.toWeb(req),duplex:'half'}).formData(),file=fd.get('file');
      const r=resolveUploadRoll(u,String(fd.get('roll_no')||''));if('error' in r)return send(res,r.status,{error:r.error});
      if(!file||file.type!=='application/pdf')return send(res,400,{error:'Upload a PDF up to 10 MB.'});
      return send(res,200,await uploadCore(db,g,cfg,{roll:r.roll,category:String(fd.get('category')||'Other'),title:String(fd.get('title')||''),bytes:new Uint8Array(await file.arrayBuffer()),uploader:u.email}));
    }
    const b=JSON.parse((await body(req)).toString()||'{}');
    if(u.role!=='faculty')return send(res,403,{error:'Faculty only'});
    if(name==='sync-drive-sheet')return send(res,200,b.check?{checks:await systemCheck(db,g,cfg,{ok:true,detail:'Token obtained (fake)'})}:await syncCore(db,g,cfg,u.email));
    if(name==='admin-remove'){const all=db.t.certificates.map(c=>({...c})),targets=b.duplicates?findDuplicates(all):all.filter(c=>(b.ids||[]).includes(c.id));
      const out=await removeCerts(db,g,cfg,targets);log(u.email,b.duplicates?'REMOVE_DUPLICATES':'REMOVE_CERTIFICATE',`Removed ${out.removed}`,'ADMIN').run();return send(res,200,{ok:true,...out});}
    send(res,404,{error:'unknown function'});
  }catch(e){send(res,500,{error:String(e.message||e)});}
}
const MIME={'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.webmanifest':'application/manifest+json','.json':'application/json'};
http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://x');
  try{
    if(url.pathname==='/v')return send(res,200,{v:db.v});
    if(url.pathname==='/debug')return send(res,200,{drive:g.live().map(f=>f.name),rows:g.rows.length,sheet:g.rows,certs:db.t.certificates,students:db.t.students.filter(s=>s.submitted||s.approval!=='PENDING_REVIEW'),logs:db.t.audit_logs.map(l=>l.action),removed:db.t.removed_keys.length});
    if(url.pathname==='/debug/addfile'){const b=JSON.parse((await body(req)).toString());g.addFile(b.name);return send(res,200,{ok:true});}
    if(url.pathname==='/debug/reset'){reset();return send(res,200,{ok:true});}
    if(req.method==='POST'&&url.pathname==='/api')return api(req,res,JSON.parse((await body(req)).toString()));
    if(req.method==='POST'&&url.pathname.startsWith('/rpc/')){const n=url.pathname.slice(5),u=profile(req),a=JSON.parse((await body(req)).toString()||'{}');
      if(n==='ensure_profile'){if(!req.headers['x-user'])return send(res,200,{data:null,error:{message:'not signed in'}});let p=u;if(!p){p={id:req.headers['x-user'],email:req.headers['x-user']+'@test.com',full_name:'New User',role:'student',roll_no:null};db.t.profiles.push(p);}return send(res,200,{data:p,error:null});}
      if(!u||u.role!=='faculty'||!RPC[n])return send(res,200,{data:null,error:{message:'forbidden'}});
      return send(res,200,{data:RPC[n](u,a),error:null});}
    if(req.method==='POST'&&url.pathname.startsWith('/fn/'))return fn(req,res,url.pathname.slice(4));
    let f=path.join(ROOT,url.pathname==='/'?'index.html':url.pathname);if(!f.startsWith(ROOT)||!fs.existsSync(f))return send(res,404,'not found','text/plain');
    send(res,200,fs.readFileSync(f),MIME[path.extname(f)]||'application/octet-stream');
  }catch(e){send(res,500,{error:String(e.stack||e)});}
}).listen(PORT,()=>console.log('test server on',PORT));
