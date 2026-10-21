"""Browser end-to-end test: real site + real core logic (upload/sync/remove) on fake Google & fake DB. Run: python3 tests/e2e.py"""
import subprocess,time,json,os,sys,urllib.request
from playwright.sync_api import sync_playwright
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)));PORT='8765';BASE=f'http://localhost:{PORT}'
srv=subprocess.Popen(['node','--experimental-strip-types','--no-warnings','tests/server.mjs'],cwd=ROOT,env={**os.environ,'PORT':PORT},stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
for _ in range(50):
    try: urllib.request.urlopen(BASE+'/v');break
    except Exception: time.sleep(.1)
get=lambda p:json.load(urllib.request.urlopen(BASE+p))
post=lambda p,b:urllib.request.urlopen(urllib.request.Request(BASE+p,data=json.dumps(b).encode(),method='POST')).read()
res=[];errors=[]
def check(name,cond,extra=''):
    res.append((name,bool(cond)));print(('PASS ' if cond else 'FAIL ')+name+(f'   [{extra}]' if extra and not cond else ''),flush=True)
PDF={'name':'cert.pdf','mimeType':'application/pdf','buffer':b'%PDF-1.4\n%test\n'}
try:
  with sync_playwright() as p:
    br=p.chromium.launch()
    def page(user):
        ctx=br.new_context(accept_downloads=True);ctx.add_init_script(f"localStorage.setItem('tu','{user}')")
        ctx.route('**/supabase.js',lambda r:r.fulfill(path=ROOT+'/tests/supabase-mock.js',content_type='application/javascript'))
        ctx.route('**/config.js',lambda r:r.fulfill(body="window.CX={url:'http://test',anon:'x'};",content_type='application/javascript'))
        ctx.route('**/fonts.googleapis.com/**',lambda r:r.abort());ctx.route('**/fonts.gstatic.com/**',lambda r:r.abort())
        pg=ctx.new_page();pg.set_default_timeout(8000);pg.on('dialog',lambda d:d.accept())
        pg.on('pageerror',lambda e:errors.append(str(e)));pg.on('console',lambda m:errors.append(m.text) if m.type=='error' and 'Failed to load resource' not in m.text and 'fonts' not in m.text else None)
        pg.goto(BASE+'/');return pg
    stu=page('s1');fac=page('f1')
    stu.wait_for_selector('#upf');fac.wait_for_selector('#pct:not(:empty)')
    # ---- roles
    check('student sees upload form, not faculty tools',stu.evaluate("document.body.classList.contains('student')")and not stu.is_visible('.tabsbar')and not stu.is_visible('#sync'))
    check('faculty sees dashboard, not student form',fac.evaluate("document.body.classList.contains('faculty')")and not fac.is_visible('#upf'))
    check('faculty roster loaded (66 students)',fac.inner_text('#rosterpill').startswith('66'))
    # ---- student upload -> Drive + Sheet + DB
    stu.select_option('#upf [name=category]','Hackathon');stu.fill('#upf [name=title]','SIH 2026');stu.set_input_files('#upf [name=file]',PDF);stu.click('#upf button')
    stu.wait_for_function("document.querySelector('#sCerts').innerText.includes('25A31A05GB_Hackathon_SIH_2026.pdf')")
    d=get('/debug')
    check('upload: file landed in Drive',d['drive']==['25A31A05GB_Hackathon_SIH_2026.pdf'],d['drive'])
    check('upload: sheet row written with submission id',d['rows']==2 and d['sheet'][1][6]==d['certs'][0]['id'])
    check('student sees DRIVE ✓ and SHEET ✓',all(x in stu.inner_text('#sCerts') for x in ('DRIVE ✓','SHEET ✓')))
    fac.wait_for_function("document.querySelector('#st').innerText.includes('1/66')")
    check('LIVE: faculty dashboard updated without reload (Drive files 1/66)',True)
    # ---- live update must not wipe a half-filled upload form
    stu.fill('#upf [name=title]','keep me');stu.set_input_files('#upf [name=file]',PDF)
    fac.click('.seat[data-r="25A31A05GB"]');fac.wait_for_selector('[data-act=appr]')
    check('faculty modal lists the student\'s certificate',('25A31A05GB_Hackathon_SIH_2026.pdf' in fac.inner_text('.mbox')))
    fac.click('[data-act=appr]')
    stu.wait_for_function("document.querySelector('#sMsgs').innerText.includes('Certificate Approved')")
    check('LIVE: student got the approval message',True)
    check('LIVE update kept the half-filled form (title + file)',stu.input_value('#upf [name=title]')=='keep me' and stu.evaluate("document.querySelector('#upf [name=file]').files.length")==1)
    check('student status shows APPROVED',stu.inner_text('#sAppr').strip()=='APPROVED')
    stu.click('[data-act=read]');stu.wait_for_function("!document.querySelector('#sMsgs [data-act=read]')");check('mark message read works',True)
    # ---- rejection -> re-upload replaces and resets to pending
    fac.click('.seat[data-r="25A31A05GB"]');fac.click('[data-act=rej]');fac.wait_for_selector('#af');fac.fill('#af [name=reason]','Blurry scan');fac.click('#af button.btn.b')
    stu.wait_for_function("document.querySelector('#sAppr').innerText.includes('REJECTED')");check('student sees REJECTED + feedback',('Blurry scan' in stu.inner_text('#sHead')))
    stu.fill('#upf [name=title]','SIH 2026');stu.select_option('#upf [name=category]','Hackathon');stu.click('#upf button')
    stu.wait_for_function("document.querySelector('#sAppr').innerText.includes('PENDING')")
    d=get('/debug');check('re-upload resets approval to PENDING REVIEW',True)
    check('re-upload REPLACED the old copy (1 Drive file, 1 cert, 1 sheet row)',len(d['drive'])==1 and len(d['certs'])==1 and d['rows']==2,d)
    # ---- sync + duplicates
    fac.click('#sync');fac.wait_for_function("document.querySelector('#toast').innerText.includes('Sync complete')");check('Sync Now works (toast)',True)
    post('/debug/addfile',{'name':'25A31A05GC_Course.pdf'});post('/debug/addfile',{'name':'25A31A05GC_Course.pdf'});post('/debug/addfile',{'name':'25A31A05GC_Course_Python.pdf'})
    fac.click('#sync');fac.wait_for_function("document.querySelector('#dupn').innerText==='1'")
    check('sync found Drive files, flagged exactly 1 duplicate (different names are NOT duplicates)',fac.is_visible('#dups'))
    d=get('/debug');check('sync repaired missing sheet rows',d['rows']==5,d['rows'])
    fac.click('.tab[data-view=review]');fac.wait_for_selector('#v-review [data-act=dups]');check('Needs Review lists the duplicate',('25A31A05GC' in fac.inner_text('#v-review')))
    fac.click('#v-review [data-act=dups]');fac.wait_for_function("document.querySelector('#dupn').innerText==='0'")
    d=get('/debug');check('Remove duplicates: Drive trashed, Sheet row deleted',len(d['drive'])==3 and d['rows']==4,d)
    fac.click('.tab[data-view=dash]');fac.click('#sync');time.sleep(.8);fac.click('#sync');time.sleep(.8)
    d=get('/debug');check('after 2 more syncs duplicate is NOT resurrected',len(d['drive'])==3 and d['rows']==4 and fac.inner_text('#dupn')=='0',d)
    # ---- alerts composer -> student inbox
    fac.click('.tab[data-view=alerts]');fac.wait_for_selector('[data-act=albc]');fac.click('[data-act=alg][data-v=ALL]')
    check('alert composer shows live group counts',('66' in fac.inner_text('[data-act=alg][data-v=ALL]')))
    fac.fill('[data-al=t]','Holiday notice');fac.fill('[data-al=m]','College closed tomorrow.');fac.click('[data-act=albc]')
    stu.wait_for_function("document.querySelector('#sMsgs').innerText.includes('Holiday notice')");check('LIVE: broadcast reached the student inbox',True)
    fac.wait_for_function("document.querySelector('#recent').innerText.includes('Holiday notice')");check('recent broadcasts list updated',True)
    # ---- audit
    fac.click('.tab[data-view=audit]');fac.wait_for_function("document.querySelector('#v-audit').innerText.includes('RUN_SYNC')")
    t=fac.inner_text('#v-audit');check('audit log shows upload, sync, duplicate removal, broadcast',all(x in t for x in('DIRECT_STUDENT_UPLOAD','RUN_SYNC','REMOVE_DUPLICATES','BROADCAST_ALERT')))
    # ---- settings -> system check
    fac.click('.sys');fac.click('[data-act=syscheck]');fac.wait_for_function("document.querySelector('#chk').innerText.includes('Drive folder')")
    t=fac.inner_text('#chk');check('system check reports items (✅ Drive/Spreadsheet, ⚠️ cron)',('✅' in t and '⚠️' in t and 'Automatic sync' in t))
    fac.click('[data-act=mclose]')
    # ---- per-student certificate delete
    fac.click('.tab[data-view=dash]');fac.click('.seat[data-r="25A31A05GC"]');fac.wait_for_selector('[data-act=delcert]')
    n=fac.locator('[data-act=delcert]').count();fac.locator('[data-act=delcert]').first.click();fac.wait_for_function("!document.querySelector('.mbox')")
    time.sleep(.6);d=get('/debug');check('per-certificate delete removes Drive file + sheet row + record',len(d['drive'])==2 and n==2,d)
    # ---- security
    r=stu.evaluate("fetch('/api',{method:'POST',headers:{'x-user':'s1'},body:JSON.stringify({table:'students',steps:[['select','*'],['eq','roll_no','25A31A05GC']]})}).then(r=>r.json())")
    check('student cannot read another student\'s row',r['data']==[],r)
    r=stu.evaluate("fetch('/rpc/approve_student',{method:'POST',headers:{'x-user':'s1'},body:JSON.stringify({p_roll:'25A31A05GB'})}).then(r=>r.json())");check('student cannot approve (rpc forbidden)',r['error'] is not None,r)
    r=stu.evaluate("fetch('/fn/sync-drive-sheet',{method:'POST',headers:{'x-user':'s1'},body:'{}'}).then(r=>r.status)");check('student cannot run sync (403)',r==403,r)
    r=stu.evaluate("fetch('/api',{method:'POST',headers:{'x-user':'s1'},body:JSON.stringify({table:'certificates',steps:[['insert',{roll_no:'25A31A05GB',file_name:'x.pdf'}]]})}).then(r=>r.json())");check('student cannot write certificates directly',r['error'] is not None,r)
    r=stu.evaluate("(()=>{const f=new FormData();f.append('file',new Blob(['%PDF'],{type:'application/pdf'}),'a.pdf');f.append('category','Course');f.append('title','Hack');f.append('roll_no','25A31A05GC');return fetch('/fn/upload-certificate',{method:'POST',headers:{'x-user':'s1'},body:f}).then(r=>r.json())})()")
    d=get('/debug');check('student cannot upload for ANOTHER roll number (server forces own)',all(c['roll_no']!='25A31A05GC' or c['title']!='Hack' for c in d['certs']) and any(c['title']=='Hack' and c['roll_no']=='25A31A05GB' for c in d['certs']),d['certs'])
    # ---- account edge cases
    for u in ('s3','n1'):
        pg=page(u);pg.wait_for_selector('#stu');check(f'unlinked/new account "{u}" sees "Account not linked" (no crash)','Account not linked' in pg.inner_text('#stu'))
    # ---- PWA
    m=stu.evaluate("fetch(document.querySelector('link[rel=manifest]').href).then(r=>r.json())")
    check('PWA manifest valid (standalone, 3 icons)',m['display']=='standalone' and len(m['icons'])==3)
    sw=stu.evaluate("navigator.serviceWorker.ready.then(r=>!!r.active)");check('service worker active (installable / offline shell)',sw)
    check('no APK link left (old in-memory APK removed)','certifyx.apk' not in fac.content())
    # ---- export
    with fac.expect_download() as dl:fac.click('[data-act=export]')
    check('Export Center downloads a CSV',dl.value.suggested_filename=='class-summary.csv')
    check('no JavaScript errors in any page',not errors,errors[:3])
    br.close()
finally:
    srv.terminate()
fails=[n for n,o in res if not o];print(f'\n{len(res)-len(fails)}/{len(res)} passed');sys.exit(1 if fails else 0)
