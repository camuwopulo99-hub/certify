import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.45.4';
export const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type, x-cron-secret'};
export const J=(o:unknown,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{...cors,'Content-Type':'application/json'}});
export const serviceDb=()=>createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
/** Returns the signed-in user's profile, or a ready-made error Response. */
export async function who(req:Request,db:any){
  const asUser=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:req.headers.get('Authorization')??''}}});
  const {data:{user}}=await asUser.auth.getUser();if(!user)return J({error:'Not signed in'},401);
  const {data:p}=await db.from('profiles').select('*').eq('id',user.id).single();
  if(!p)return J({error:'No profile yet — reload the page and sign in again'},403);
  return p as {id:string,email:string,role:string,roll_no:string|null};
}
