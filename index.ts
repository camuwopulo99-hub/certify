import {J,cors,serviceDb,who} from '../_shared/http.ts';
import {googleToken,realGoogle} from '../_shared/google.ts';
import {uploadCore,resolveUploadRoll} from '../_shared/core.ts';
Deno.serve(async req=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  try{
    const db=serviceDb(),p=await who(req,db);if(p instanceof Response)return p;
    const form=await req.formData(),file=form.get('file') as File|null;
    const r=resolveUploadRoll(p,String(form.get('roll_no')||''));if('error' in r)return J({error:r.error},r.status);
    if(!file||file.type!=='application/pdf'||file.size>10*1024*1024)return J({error:'Upload a PDF up to 10 MB.'},400);
    const {data:cfg}=await db.from('settings').select('*').eq('id',1).single();
    const g=realGoogle(await googleToken());
    return J(await uploadCore(db,g,cfg,{roll:r.roll,category:String(form.get('category')||'Other').slice(0,60),title:String(form.get('title')||'').slice(0,120),bytes:new Uint8Array(await file.arrayBuffer()),uploader:p.email}));
  }catch(e){return J({error:String((e as Error).message||e)},500);}
});
