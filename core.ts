// Pure business logic: no Deno / Supabase imports, so it runs the same in Edge Functions and in the Node test-suite.
export type GFile={id:string,name:string,webViewLink:string};
export type Google={
  list(folderId:string):Promise<GFile[]>;
  upload(folderId:string,name:string,bytes:Uint8Array):Promise<{id:string,webViewLink:string}>;
  trash(fileId:string):Promise<void>;
  read(sheetId:string,tab:string):Promise<string[][]>;
  append(sheetId:string,tab:string,row:(string|number)[]):Promise<number|null>;
  deleteRows(sheetId:string,tab:string,rows:number[]):Promise<void>;   // 1-based row numbers
};
export const ROLL=/[0-9]{2}[A-Za-z][0-9]{2}[A-Za-z][0-9]{2}[A-Za-z0-9]{2}/;
export const normRoll=(s:unknown)=>String(s??'').trim().toUpperCase().replace(/[\s\-_.]/g,'');
export const idFromLink=(l:string)=>(/\/d\/([A-Za-z0-9_-]+)/.exec(l)||/[?&]id=([A-Za-z0-9_-]+)/.exec(l)||[])[1]||'';
export const SHEET_ONLY='(sheet only)';
/** Sheet layout: A time, B roll, C name, D category, E title, F Drive link, G submission id. Row 1 is a header unless B1 looks like a roll no. */
export function dataRows(rows:string[][]){const s=rows.length&&!ROLL.test(String(rows[0][1]||''))?1:0;return rows.slice(s).map((cells,i)=>({row:i+s+1,cells}));}
export const dupKey=(c:any)=>c.roll_no+'|'+(c.file_name===SHEET_ONLY?'s|'+String(c.category||'').toLowerCase()+'|'+String(c.title||'').toLowerCase():String(c.file_name).toLowerCase());
/** Same student + same file name (or same category+title for sheet-only rows) = duplicate. Different file names are never duplicates. Keeps the best copy. */
export function findDuplicates(certs:any[]){
  const g=new Map<string,any[]>();for(const c of certs){const k=dupKey(c);(g.get(k)||g.set(k,[]).get(k)!).push(c);}
  const score=(c:any)=>(c.in_drive&&c.in_sheet?2:c.in_drive||c.in_sheet?1:0);
  const extra:any[]=[];
  for(const list of g.values()){if(list.length<2)continue;list.sort((a,b)=>score(b)-score(a)||String(a.created_at).localeCompare(String(b.created_at)));extra.push(...list.slice(1));}
  return extra;
}
export const uploadName=(roll:string,category:string,title:string)=>{const c=title.trim().replace(/[^A-Za-z0-9]/g,'_').slice(0,30);return `${roll}_${category.replace(/ /g,'_')}${c.trim()?'_'+c:''}.pdf`;};
/** Students can only ever upload for their own roll number; faculty may choose. */
export function resolveUploadRoll(profile:any,requested:string){
  if(!profile)return {error:'Not signed in',status:401};
  const roll=profile.role==='faculty'?normRoll(requested):profile.roll_no;
  if(!roll)return {error:'Your account is not linked to a roll number. Ask faculty to add your email to the roster, then sign in again.',status:403};
  return {roll};
}
const audit=(db:any,actor:string,action:string,details:string,category:string)=>db.from('audit_logs').insert({actor,action,details,category});

export async function removeCerts(db:any,g:Google,cfg:any,certs:any[]){
  const out={removed:0,driveTrashed:0,sheetRowsDeleted:0,warnings:[] as string[]};
  if(!certs.length)return out;
  const ids=new Set<string>(certs.map(c=>c.id)),files=new Set<string>(certs.map(c=>c.drive_file_id).filter(Boolean));
  await db.from('removed_keys').upsert([...ids,...files].map(key=>({key})),{onConflict:'key',ignoreDuplicates:true}); // tombstones: sync must never resurrect these
  for(const c of certs)if(c.drive_file_id){try{await g.trash(c.drive_file_id);out.driveTrashed++;}catch(e){out.warnings.push(`Drive (${c.file_name}): ${(e as Error).message}`);}}
  if(cfg.spreadsheet_id){try{
    const del=dataRows(await g.read(cfg.spreadsheet_id,cfg.sheet_name)).filter(r=>ids.has(String(r.cells[6]||''))||files.has(idFromLink(String(r.cells[5]||'')))).map(r=>r.row);
    if(del.length){await g.deleteRows(cfg.spreadsheet_id,cfg.sheet_name,del);out.sheetRowsDeleted=del.length;}
  }catch(e){out.warnings.push(`Sheet: ${(e as Error).message}`);}}
  const {error}=await db.from('certificates').delete().in('id',[...ids]);if(error)throw new Error(error.message);
  out.removed=certs.length;return out;
}

export async function uploadCore(db:any,g:Google,cfg:any,a:{roll:string,category:string,title:string,bytes:Uint8Array,uploader:string}){
  const {data:st}=await db.from('students').select('name,approval').eq('roll_no',a.roll).single();
  if(!st)throw new Error('Unknown student');
  const name=uploadName(a.roll,a.category,a.title);
  const {data:same}=await db.from('certificates').select('*').eq('roll_no',a.roll).eq('file_name',name);
  if(same&&same.length)await removeCerts(db,g,cfg,same);                       // re-upload replaces the old copy instead of duplicating
  const f=await g.upload(cfg.drive_folder_id,name,a.bytes);
  const {data:row,error}=await db.from('certificates').insert({roll_no:a.roll,category:a.category,title:a.title,file_name:name,drive_file_id:f.id,drive_link:f.webViewLink,in_drive:true,uploaded_by:a.uploader}).select().single();
  if(error||!row){try{await g.trash(f.id);}catch(_){} throw new Error(error?.message||'Could not save certificate');}   // never leave an orphan file
  let sheetOk=true;
  try{const n=await g.append(cfg.spreadsheet_id,cfg.sheet_name,[new Date().toISOString(),a.roll,st.name,a.category,a.title,f.webViewLink,row.id]);
    await db.from('certificates').update({in_sheet:true,sheet_row:n}).eq('id',row.id);}catch(_){sheetOk=false;}   // stays "Drive only"; sync repairs it
  await db.from('students').update({submitted:true,...(st.approval==='REJECTED'?{approval:'PENDING_REVIEW',feedback_reason:null}:{})}).eq('roll_no',a.roll);
  await audit(db,a.uploader,'DIRECT_STUDENT_UPLOAD',`${a.roll} uploaded ${name}${sheetOk?'':' — Sheet append failed, sync will repair'}`,'UPLOAD');
  return {ok:true,id:row.id,file_name:name,drive_link:f.webViewLink,sheet_ok:sheetOk};
}

export async function syncCore(db:any,g:Google,cfg:any,actor:string){
  const t0=Date.now();
  const [files,raw]=await Promise.all([g.list(cfg.drive_folder_id),g.read(cfg.spreadsheet_id,cfg.sheet_name)]);
  const {data:studs}=await db.from('students').select('roll_no,name');
  const {data:cd}=await db.from('certificates').select('*');
  const {data:tomb}=await db.from('removed_keys').select('key');
  const C:any[]=cd||[],dead=new Set<string>((tomb||[]).map((t:any)=>t.key));
  const roster=new Set<string>((studs||[]).map((s:any)=>s.roll_no.toUpperCase())),names=new Map<string,string>((studs||[]).map((s:any)=>[s.roll_no,s.name]));
  let outside=0,unident=0,repaired=0,errors=0;
  const live=files.filter(f=>!dead.has(f.id)),ids=new Set(files.map(f=>f.id));
  // 1. does each known file still exist?
  for(const c of C)if(c.drive_file_id){const has=ids.has(c.drive_file_id);if(has!==c.in_drive){await db.from('certificates').update({in_drive:has}).eq('id',c.id);c.in_drive=has;}}
  // 2. files we don't know yet → roll number from file name
  const known=new Set(C.map(c=>c.drive_file_id).filter(Boolean));
  for(const f of live){if(known.has(f.id))continue;
    const m=ROLL.exec(f.name);if(!m){unident++;continue;}const roll=m[0].toUpperCase();if(!roster.has(roll)){outside++;continue;}
    const cat=f.name.replace(/\.[^.]+$/,'').slice(m.index+10).replace(/^[_\-\s]+/,'').split('_')[0]||'Certificate';
    const {data:n}=await db.from('certificates').insert({roll_no:roll,category:cat,title:'',file_name:f.name,drive_file_id:f.id,drive_link:f.webViewLink,in_drive:true,uploaded_by:'drive-sync'}).select().single();if(n)C.push(n);}
  // 3. sheet rows → exact submission id, else Drive link, else roll+category+title, else roll+category
  const seen=new Set<string>(),low=(s:unknown)=>String(s??'').trim().toLowerCase();
  for(const {row,cells} of dataRows(raw)){
    const roll=normRoll(cells[1]);if(!roll)continue;
    const sid=String(cells[6]||'').trim(),link=String(cells[5]||''),fid=idFromLink(link);
    if(dead.has(sid)||(fid&&dead.has(fid)))continue;                         // removed on purpose
    if(!roster.has(roll)){outside++;continue;}
    const cat=String(cells[3]||'Certificate'),title=String(cells[4]||'');
    const free=(x:any)=>!seen.has(x.id)&&x.roll_no===roll;
    const c=C.find(x=>sid&&x.id===sid)||C.find(x=>fid&&x.drive_file_id===fid&&!seen.has(x.id))||C.find(x=>free(x)&&low(x.category)===low(cat)&&low(x.title)===low(title))||C.find(x=>free(x)&&low(x.category)===low(cat));
    if(c){seen.add(c.id);if(!c.in_sheet||c.sheet_row!==row){await db.from('certificates').update({in_sheet:true,sheet_row:row}).eq('id',c.id);c.in_sheet=true;c.sheet_row=row;}}
    else{const {data:n}=await db.from('certificates').insert({roll_no:roll,category:cat,title,file_name:SHEET_ONLY,in_sheet:true,sheet_row:row,uploaded_by:'sheet-sync'}).select().single();if(n){C.push(n);seen.add(n.id);}}
  }
  for(const c of C)if(c.in_sheet&&!seen.has(c.id)){await db.from('certificates').update({in_sheet:false,sheet_row:null}).eq('id',c.id);c.in_sheet=false;}
  // 4. repair: in Drive but not in the Sheet → append the row
  for(const c of C)if(c.in_drive&&!seen.has(c.id)){
    try{const n=await g.append(cfg.spreadsheet_id,cfg.sheet_name,[new Date().toISOString(),c.roll_no,names.get(c.roll_no)||'',c.category||'',c.title||'',c.drive_link||'',c.id]);
      await db.from('certificates').update({in_sheet:true,sheet_row:n}).eq('id',c.id);c.in_sheet=true;repaired++;}catch(_){errors++;}}
  const rep={students_checked:(studs||[]).length,drive_files:files.length,sheet_rows:dataRows(raw).length,outside_class:outside,unidentified:unident,repaired,errors,duration_ms:Date.now()-t0,triggered_by:actor};
  await db.from('sync_reports').insert(rep);
  await audit(db,actor,'RUN_SYNC',`Scanned ${files.length} Drive files and ${rep.sheet_rows} Sheet rows; repaired ${repaired}; outside class ${outside}; unidentified ${unident}; errors ${errors}`,'SYNC');
  return {ok:true,driveFiles:files.length,sheetRows:rep.sheet_rows,repaired,outside,unidentified:unident,errors};
}

/** Settings → "Run system check": tells you exactly what is misconfigured. */
export async function systemCheck(db:any,g:Google|null,cfg:any,auth:{ok:boolean,detail:string}){
  const out:{name:string,level:'ok'|'warn'|'fail',detail:string}[]=[];
  const add=(name:string,level:'ok'|'warn'|'fail',detail:string)=>out.push({name,level,detail});
  add('Google authorization',auth.ok?'ok':'fail',auth.detail);
  add('Settings',cfg.spreadsheet_id&&cfg.drive_folder_id&&cfg.drive_folder_id!=='root'?'ok':'fail',cfg.spreadsheet_id&&cfg.drive_folder_id!=='root'?'Drive folder and spreadsheet IDs are set':'Set a real Drive folder ID (not "root") and the spreadsheet ID in System Controls');
  if(g&&auth.ok){
    try{const f=await g.list(cfg.drive_folder_id);add('Drive folder','ok',`Readable — ${f.length} file(s)`);}catch(e){add('Drive folder','fail',(e as Error).message+' — share the folder with the authorised Google account / service account as Editor');}
    try{const r=dataRows(await g.read(cfg.spreadsheet_id,cfg.sheet_name));const bad=r.filter(x=>!ROLL.test(String(x.cells[1]||''))).length;
      add('Spreadsheet',bad&&bad===r.length?'warn':'ok',`Readable — ${r.length} data row(s)${bad?`, ${bad} without a valid roll number in column B`:''}`);}catch(e){add('Spreadsheet','fail',(e as Error).message+' — check the spreadsheet ID and the tab name');}
  }
  const {data:cron}=await db.from('sync_reports').select('created_at').eq('triggered_by','cron').order('created_at',{ascending:false}).limit(1);
  const last=cron&&cron[0]?Date.now()-new Date(cron[0].created_at).getTime():Infinity;
  add('Automatic sync (cron)',last<20*60000?'ok':'warn',last<20*60000?'Ran in the last 20 minutes':'No automatic run in the last 20 minutes — set up the cron job from the README');
  const {data:un}=await db.from('profiles').select('email').eq('role','student').is('roll_no',null);
  add('Student accounts',un&&un.length?'warn':'ok',un&&un.length?`${un.length} signed-in student(s) not linked to a roll number: ${un.slice(0,5).map((u:any)=>u.email).join(', ')}`:'All student logins are linked to a roster row');
  return out;
}
