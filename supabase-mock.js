// Browser stand-in for supabase-js: forwards queries/functions to tests/server.mjs (which runs the REAL core logic on fakes).
(function(){
  const uid=()=>localStorage.getItem('tu')||'';
  const H=()=>({'x-user':uid(),'Content-Type':'application/json'});
  class B{constructor(t){this.t=t;this.s=[];}
    _p(m,...a){this.s.push([m,...a]);return this;}
    select(...a){return this._p('select',...a);} insert(...a){return this._p('insert',...a);} upsert(...a){return this._p('upsert',...a);}
    update(...a){return this._p('update',...a);} delete(...a){return this._p('delete',...a);} eq(...a){return this._p('eq',...a);} in(...a){return this._p('in',...a);}
    is(...a){return this._p('is',...a);} order(...a){return this._p('order',...a);} limit(...a){return this._p('limit',...a);} range(...a){return this._p('range',...a);}
    single(){return this._p('single');} maybeSingle(){return this._p('maybeSingle');}
    then(res,rej){return fetch('/api',{method:'POST',headers:H(),body:JSON.stringify({table:this.t,steps:this.s})}).then(r=>r.json()).then(res,rej);}
  }
  window.supabase={createClient:()=>({
    auth:{getSession:async()=>({data:{session:uid()?{user:{id:uid()}}:null}}),signOut:async()=>{localStorage.removeItem('tu');},signInWithOAuth:async()=>{}},
    from:t=>new B(t),
    rpc:(n,a)=>fetch('/rpc/'+n,{method:'POST',headers:H(),body:JSON.stringify(a||{})}).then(r=>r.json()),
    functions:{invoke:async(n,{body}={})=>{const f=body instanceof FormData;
      const r=await fetch('/fn/'+n,{method:'POST',headers:f?{'x-user':uid()}:H(),body:f?body:JSON.stringify(body||{})});const j=await r.json().catch(()=>({}));
      return r.ok?{data:j,error:null}:{data:null,error:{message:'Edge Function returned a non-2xx status code',context:{json:async()=>j}}};}},
    channel:()=>{const cbs=[];const ch={on(t,f,cb){cbs.push(cb);return ch;},subscribe(cb){let v=null;setInterval(async()=>{try{const x=await (await fetch('/v')).json();if(v===null){cb&&cb('SUBSCRIBED');}else if(x.v!==v)cbs.forEach(c=>c());v=x.v;}catch(e){}},250);return ch;}};return ch;}
  })};
})();
