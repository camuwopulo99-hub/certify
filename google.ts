import type {Google} from './core.ts';
const enc=new TextEncoder();
const b64u=(b:ArrayBuffer|string)=>{const a=typeof b==='string'?enc.encode(b):new Uint8Array(b);let s='';a.forEach(c=>s+=String.fromCharCode(c));return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};
const TOKEN='https://oauth2.googleapis.com/token';
const SCOPE='https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets';
/** Option A: faculty OAuth refresh token. Option B: service account (use a Shared Drive). */
export async function googleToken():Promise<string>{
  const rt=Deno.env.get('GOOGLE_REFRESH_TOKEN');
  if(rt){
    const r=await fetch(TOKEN,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:rt,client_id:Deno.env.get('GOOGLE_CLIENT_ID')!,client_secret:Deno.env.get('GOOGLE_CLIENT_SECRET')!})});
    const j=await r.json();
    if(!j.access_token)throw new Error(j.error==='invalid_grant'?'Google authorization expired or was revoked (invalid_grant). Re-authorise and update GOOGLE_REFRESH_TOKEN. If your OAuth consent screen is in "Testing" mode the token expires after 7 days — publish it ("In production") or use an Internal app.':'Google token refresh failed: '+JSON.stringify(j));
    return j.access_token;
  }
  const raw=Deno.env.get('GOOGLE_SERVICE_ACCOUNT');if(!raw)throw new Error('No Google credentials configured. Set GOOGLE_REFRESH_TOKEN (+CLIENT_ID/SECRET) or GOOGLE_SERVICE_ACCOUNT.');
  const sa=JSON.parse(raw),now=Math.floor(Date.now()/1000);
  const head=b64u(JSON.stringify({alg:'RS256',typ:'JWT'})),claim=b64u(JSON.stringify({iss:sa.client_email,scope:SCOPE,aud:TOKEN,iat:now,exp:now+3600}));
  const pem=sa.private_key.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
  const key=await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(pem),c=>c.charCodeAt(0)),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const sig=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,enc.encode(`${head}.${claim}`));
  const r=await fetch(TOKEN,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:`${head}.${claim}.${b64u(sig)}`})});
  const j=await r.json();if(!j.access_token)throw new Error('Google service-account auth failed: '+JSON.stringify(j));return j.access_token;
}
export function realGoogle(t:string):Google{
  const H={Authorization:`Bearer ${t}`},sheetUrl=(id:string,rest:string)=>`https://sheets.googleapis.com/v4/spreadsheets/${id}${rest}`;
  return {
    async list(folderId){const out:any[]=[];let page='';
      do{const u=new URL('https://www.googleapis.com/drive/v3/files');u.searchParams.set('q',`'${folderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`);u.searchParams.set('fields','nextPageToken,files(id,name,webViewLink)');u.searchParams.set('pageSize','1000');u.searchParams.set('supportsAllDrives','true');u.searchParams.set('includeItemsFromAllDrives','true');if(page)u.searchParams.set('pageToken',page);
        const r=await fetch(u,{headers:H});if(!r.ok)throw new Error('Drive list failed: '+await r.text());const j=await r.json();out.push(...j.files);page=j.nextPageToken||'';}while(page);
      return out;},
    async upload(folderId,name,bytes){
      const b='cx'+crypto.randomUUID(),pre=enc.encode(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({name,parents:[folderId]})}\r\n--${b}\r\nContent-Type: application/pdf\r\n\r\n`),post=enc.encode(`\r\n--${b}--`);
      const body=new Uint8Array(pre.length+bytes.length+post.length);body.set(pre);body.set(bytes,pre.length);body.set(post,pre.length+bytes.length);
      const r=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink',{method:'POST',headers:{...H,'Content-Type':`multipart/related; boundary=${b}`},body});
      if(!r.ok)throw new Error('Drive upload failed: '+await r.text());return await r.json();},
    async trash(id){const r=await fetch(`https://www.googleapis.com/drive/v3/files/${id}?supportsAllDrives=true`,{method:'PATCH',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({trashed:true})});
      if(!r.ok&&r.status!==404)throw new Error('Drive trash failed: '+await r.text());},
    async read(id,tab){const r=await fetch(sheetUrl(id,`/values/${encodeURIComponent(tab)}!A:G`),{headers:H});if(!r.ok)throw new Error('Sheet read failed: '+await r.text());return (await r.json()).values||[];},
    async append(id,tab,row){const r=await fetch(sheetUrl(id,`/values/${encodeURIComponent(tab)}!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`),{method:'POST',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})});
      if(!r.ok)throw new Error('Sheet append failed: '+await r.text());const m=/![A-Z]+(\d+)/.exec((await r.json()).updates?.updatedRange||'');return m?+m[1]:null;},
    async deleteRows(id,tab,rows){
      const m=await fetch(sheetUrl(id,'?fields=sheets.properties(sheetId,title)'),{headers:H});if(!m.ok)throw new Error('Sheet metadata failed: '+await m.text());
      const gid=(await m.json()).sheets.find((s:any)=>s.properties.title===tab)?.properties.sheetId;if(gid===undefined)throw new Error(`Tab "${tab}" not found`);
      const requests=[...rows].sort((a,b)=>b-a).map(r=>({deleteDimension:{range:{sheetId:gid,dimension:'ROWS',startIndex:r-1,endIndex:r}}}));
      const r=await fetch(sheetUrl(id,':batchUpdate'),{method:'POST',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({requests})});
      if(!r.ok)throw new Error('Sheet row delete failed: '+await r.text());},
  };
}
