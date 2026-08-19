// Shared mobile web UX for LINE in-app pages.
// Adds visible waiting feedback for async actions and a reliable return-to-LINE action.

const BRAND_THEME = String.raw`
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style id="rubjai-unified-brand-v786">
:root{
  --rubjai-navy:#111827;
  --rubjai-indigo:#4f46e5;
  --rubjai-indigo-hover:#4338ca;
  --rubjai-indigo-soft:#eef2ff;
  --rubjai-bg:#f7f8fc;
  --rubjai-text:#111827;
  --rubjai-muted:#667085;
  --rubjai-border:#e4e7ec;
  --rubjai-green:#16a34a;
  --rubjai-orange:#d97706;
  --rubjai-red:#dc2626;
}
html,body,button,input,select,textarea,a,label,p,span,div,section,article,
h1,h2,h3,h4,h5,h6,strong,small{
  font-family:"IBM Plex Sans Thai","Noto Sans Thai","Leelawadee UI",sans-serif!important;
}
body{background:var(--rubjai-bg);color:var(--rubjai-text);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
button,input,select,textarea{font:inherit!important}
h1,h2,h3,h4,h5,h6{font-weight:600!important;letter-spacing:-.025em!important}
::selection{background:#c7d2fe;color:var(--rubjai-navy)}
:focus-visible{outline:2px solid var(--rubjai-indigo)!important;outline-offset:2px!important}
button[type="submit"],input[type="submit"],.primary,.btn-primary,
.deal-auto-line-button,#dealMobileBusy .deal-line-link,#dealLineCloseGuide .deal-close-confirm{
  background:var(--rubjai-indigo)!important;
  border-color:var(--rubjai-indigo)!important;
  color:#fff!important;
}
button[type="submit"]:hover,.primary:hover,.btn-primary:hover{
  background:var(--rubjai-indigo-hover)!important;
}
.summary,.summary-card,.total-card{
  background:var(--rubjai-navy)!important;
  color:#fff!important;
}
</style>
`; // RUBJAI_UNIFIED_BRAND_V786

const STYLE = String.raw`<style id="deal-mobile-web-ux-style">
#dealMobileBusy{position:fixed;inset:0;z-index:2147483000;display:none;place-items:center;padding:22px;background:rgba(245,245,247,.92);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans Thai",sans-serif;color:#1d1d1f}
#dealMobileBusy.is-visible{display:grid}
#dealMobileBusy .deal-busy-card{width:min(92vw,430px);background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:26px;padding:30px 24px;text-align:center;box-shadow:0 24px 80px rgba(0,0,0,.16)}
#dealMobileBusy .deal-spinner{width:44px;height:44px;margin:0 auto 18px;border-radius:50%;border:4px solid #e5e5ea;border-top-color:#1d1d1f;animation:dealSpin .8s linear infinite}
#dealMobileBusy h2{margin:0 0 8px;font-size:24px;line-height:1.25;letter-spacing:-.02em}
#dealMobileBusy p{margin:0;color:#6e6e73;font-size:14px;line-height:1.6}
#dealMobileBusy .deal-progress{height:4px;margin:20px 0 0;background:#ececf1;border-radius:999px;overflow:hidden}
#dealMobileBusy .deal-progress i{display:block;width:42%;height:100%;border-radius:999px;background:#1d1d1f;animation:dealProgress 1.25s ease-in-out infinite}
#dealMobileBusy .deal-return-fallback{display:none;margin-top:18px}
#dealMobileBusy.is-returning .deal-spinner{display:none}
#dealMobileBusy.is-returning .deal-progress{display:none}
#dealMobileBusy.is-returning .deal-return-fallback{display:block}
#dealMobileBusy .deal-line-link{display:block;width:100%;min-height:50px;margin-top:12px;padding:14px 16px;border-radius:14px;background:#1d1d1f;color:#fff;text-decoration:none;font-weight:800}
.deal-auto-line-button{position:fixed;right:max(16px,env(safe-area-inset-right));bottom:max(18px,calc(env(safe-area-inset-bottom) + 12px));z-index:2147482000;min-height:46px;padding:12px 17px;border:0;border-radius:999px;background:#1d1d1f;color:#fff;font:700 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans Thai",sans-serif;box-shadow:0 10px 28px rgba(0,0,0,.22)}
[data-deal-action-busy="1"]{opacity:.58!important;cursor:wait!important;pointer-events:none!important}
#dealLineCloseGuide{position:fixed;inset:0;z-index:2147483646;display:none;background:rgba(245,245,247,.94);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans Thai",sans-serif;color:#1d1d1f}
#dealLineCloseGuide.is-visible{display:block}
#dealLineCloseGuide .deal-close-arrow{position:fixed;top:max(12px,env(safe-area-inset-top));right:14px;display:flex;align-items:flex-start;gap:8px;z-index:2;pointer-events:none}
#dealLineCloseGuide .deal-close-arrow-text{max-width:190px;margin-top:38px;padding:10px 12px;border-radius:14px;background:#1d1d1f;color:#fff;font-size:13px;font-weight:800;line-height:1.35;text-align:center;box-shadow:0 12px 35px rgba(0,0,0,.28)}
#dealLineCloseGuide .deal-close-arrow-icon{font-size:48px;line-height:1;color:#1d1d1f;transform:rotate(-8deg);filter:drop-shadow(0 3px 8px rgba(0,0,0,.18));animation:dealPointClose 1.05s ease-in-out infinite}
#dealLineCloseGuide .deal-close-card{position:absolute;left:50%;top:54%;transform:translate(-50%,-50%);width:min(92vw,450px);background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:28px;padding:30px 24px;text-align:center;box-shadow:0 24px 80px rgba(0,0,0,.16)}
#dealLineCloseGuide .deal-close-check{width:54px;height:54px;margin:0 auto 16px;border-radius:50%;display:grid;place-items:center;background:#1d1d1f;color:#fff;font-size:28px;font-weight:900}
#dealLineCloseGuide h2{margin:0 0 10px;font-size:27px;line-height:1.2;letter-spacing:-.025em}
#dealLineCloseGuide .deal-close-main{margin:0;color:#4a4a4f;font-size:16px;line-height:1.65}
#dealLineCloseGuide .deal-close-note{margin:16px 0 0;padding:13px 14px;border-radius:15px;background:#f5f5f7;color:#6e6e73;font-size:13px;line-height:1.55}
#dealLineCloseGuide .deal-close-confirm{width:100%;min-height:54px;margin-top:20px;border:0;border-radius:15px;background:#1d1d1f;color:#fff;font:800 15px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans Thai",sans-serif;padding:14px 16px}
#dealLineCloseGuide .deal-close-confirm:active{transform:scale(.985)}
#dealLineCloseGuide.pulse .deal-close-arrow-icon{animation-duration:.45s}
@keyframes dealPointClose{0%,100%{transform:translate(0,0) rotate(-8deg)}50%{transform:translate(5px,-8px) rotate(-8deg)}}
@keyframes dealSpin{to{transform:rotate(360deg)}}
@keyframes dealProgress{0%{transform:translateX(-120%)}50%{transform:translateX(105%)}100%{transform:translateX(260%)}}
@media(max-width:520px){#dealMobileBusy .deal-busy-card{padding:28px 20px;border-radius:24px}#dealMobileBusy h2{font-size:22px}}
@media(prefers-reduced-motion:reduce){#dealMobileBusy .deal-spinner,#dealMobileBusy .deal-progress i{animation-duration:1.8s}}
</style>`;

const SCRIPT = String.raw`<script id="deal-mobile-web-ux-script">
(()=>{
  if(window.__DEAL_MOBILE_WEB_UX__)return;
  window.__DEAL_MOBILE_WEB_UX__=true;

  const LINE_CHATS_URL='https://line.me/R/nv/chat';
  const LIFF_ID=__DEAL_LIFF_ID__;
  let liffReadyPromise=null;
  let busyDepth=0;
  let busyShownAt=0;
  let showTimer=null;
  let slowTimer=null;
  let verySlowTimer=null;
  let lastAction={text:'',el:null,at:0};

  const clean=v=>String(v||'').replace(/\s+/g,' ').trim();
  const actionText=()=>Date.now()-lastAction.at<8000?lastAction.text:'';

  function operationCopy(text){
    const t=clean(text);
    if(/ตีกลับ|ส่งกลับ|แก้ไข/.test(t))return ['กำลังตีกลับเอกสาร…','ระบบกำลังบันทึกเหตุผลและแจ้งกลับไปยัง LINE'];
    if(/เอกสารผ่าน|ตรวจเอกสาร|ตรวจและยืนยัน|อนุมัติ/.test(t))return ['กำลังตรวจและบันทึกเอกสาร…','ระบบกำลังสร้างเอกสารและอัปเดตสถานะ กรุณาอย่ากดซ้ำ'];
    if(/โอน|จ่าย|หลักฐาน/.test(t))return ['กำลังบันทึกการโอน…','ระบบกำลังอัปโหลดหลักฐาน บันทึกสถานะ และแจ้ง LINE'];
    if(/สร้าง|รวม|ใบเบิก|PDF/.test(t))return ['กำลังสร้างเอกสาร…','ระบบกำลังจัดชุดเอกสาร กรุณารอสักครู่'];
    if(/อัปโหลด|upload/i.test(t))return ['กำลังอัปโหลดไฟล์…','กรุณาอย่าปิดหน้านี้จนกว่าการอัปโหลดจะเสร็จ'];
    if(/เชื่อม|connect|login/i.test(t))return ['กำลังเชื่อมต่อ…','ระบบกำลังตรวจสอบและบันทึกการเชื่อมต่อ'];
    if(/บันทึก|ยืนยัน|save|confirm/i.test(t))return ['กำลังบันทึกข้อมูล…','ระบบกำลังทำงาน กรุณาอย่ากดซ้ำหรือปิดหน้านี้'];
    return ['กำลังดำเนินการ…','ระบบกำลังทำงาน กรุณาอย่ากดซ้ำหรือปิดหน้านี้'];
  }

  function ensureBusy(){
    let root=document.getElementById('dealMobileBusy');
    if(root)return root;
    root=document.createElement('div');
    root.id='dealMobileBusy';
    root.setAttribute('role','status');
    root.setAttribute('aria-live','assertive');
    root.setAttribute('aria-busy','true');
    root.innerHTML='<div class="deal-busy-card"><div class="deal-spinner" aria-hidden="true"></div><h2 id="dealBusyTitle">กำลังดำเนินการ…</h2><p id="dealBusyText">ระบบกำลังทำงาน กรุณาอย่ากดซ้ำหรือปิดหน้านี้</p><div class="deal-progress" aria-hidden="true"><i></i></div><div class="deal-return-fallback"><p>แตะ X มุมขวาบนเพื่อปิดหน้านี้และกลับ LINE</p></div></div>';
    document.body.appendChild(root);
    return root;
  }

  function setBusyCopy(title,detail){
    const root=ensureBusy();
    const h=root.querySelector('#dealBusyTitle');
    const p=root.querySelector('#dealBusyText');
    if(h)h.textContent=title;
    if(p)p.textContent=detail;
  }

  function lockAction(){
    const target=lastAction.el;
    if(!target||!target.isConnected)return;
    if(target.dataset.dealActionBusy==='1')return;
    target.dataset.dealActionBusy='1';
    target.dataset.dealWasDisabled=target.disabled?'1':'0';
    if('disabled' in target)target.disabled=true;
  }

  function unlockAction(){
    const target=lastAction.el;
    if(!target||!target.isConnected)return;
    if(target.dataset.dealActionBusy!=='1')return;
    if('disabled' in target&&target.dataset.dealWasDisabled!=='1')target.disabled=false;
    delete target.dataset.dealActionBusy;
    delete target.dataset.dealWasDisabled;
  }

  function beginBusy(label){
    busyDepth+=1;
    lockAction();
    const [title,detail]=operationCopy(label||actionText());
    clearTimeout(showTimer);
    showTimer=setTimeout(()=>{
      if(busyDepth<1)return;
      const root=ensureBusy();
      root.classList.remove('is-returning');
      setBusyCopy(title,detail);
      root.classList.add('is-visible');
      busyShownAt=Date.now();
      clearTimeout(slowTimer);
      clearTimeout(verySlowTimer);
      slowTimer=setTimeout(()=>{if(busyDepth>0)setBusyCopy(title,'ยังทำงานอยู่… บางขั้นตอนต้องสร้าง PDF และแจ้ง LINE');},5000);
      verySlowTimer=setTimeout(()=>{if(busyDepth>0)setBusyCopy(title,'ใช้เวลานานกว่าปกติ แต่ระบบยังทำงานอยู่ กรุณารอต่อและอย่ากดซ้ำ');},15000);
    },160);
    return Symbol('busy');
  }

  function endBusy(){
    busyDepth=Math.max(0,busyDepth-1);
    if(busyDepth>0)return;
    clearTimeout(showTimer);
    clearTimeout(slowTimer);
    clearTimeout(verySlowTimer);
    const root=document.getElementById('dealMobileBusy');
    const elapsed=Date.now()-busyShownAt;
    setTimeout(()=>{
      if(busyDepth===0&&root&&!root.classList.contains('is-returning'))root.classList.remove('is-visible');
      unlockAction();
    },Math.max(0,420-elapsed));
  }

  function loadLiffSdk(){
    if(!LIFF_ID)return Promise.resolve(null);
    if(window.liff)return Promise.resolve(window.liff);
    if(liffReadyPromise)return liffReadyPromise;
    liffReadyPromise=new Promise(resolve=>{
      const existing=document.querySelector('script[data-deal-liff-sdk="1"]');
      if(existing){
        existing.addEventListener('load',()=>resolve(window.liff||null),{once:true});
        existing.addEventListener('error',()=>resolve(null),{once:true});
        return;
      }
      const script=document.createElement('script');
      script.src='https://static.line-scdn.net/liff/edge/2/sdk.js';
      script.async=true;
      script.dataset.dealLiffSdk='1';
      script.onload=()=>resolve(window.liff||null);
      script.onerror=()=>resolve(null);
      document.head.appendChild(script);
    });
    return liffReadyPromise;
  }

  async function prepareLiff(){
    if(!LIFF_ID)return null;
    try{
      const sdk=await loadLiffSdk();
      if(!sdk)return null;
      await sdk.init({liffId:LIFF_ID});
      return sdk;
    }catch(error){
      console.warn('[return-line] LIFF init failed',error);
      return null;
    }
  }

  function ensureCloseGuide(){
    let guide=document.getElementById('dealLineCloseGuide');
    if(guide)return guide;
    guide=document.createElement('div');
    guide.id='dealLineCloseGuide';
    guide.setAttribute('role','dialog');
    guide.setAttribute('aria-modal','true');
    guide.setAttribute('aria-labelledby','dealCloseGuideTitle');
    guide.innerHTML='<div class="deal-close-arrow"><div class="deal-close-arrow-text">แตะ X ตรงนี้เพื่อปิดหน้า</div><div class="deal-close-arrow-icon" aria-hidden="true">↗</div></div><div class="deal-close-card"><div class="deal-close-check">✓</div><h2 id="dealCloseGuideTitle">บันทึกเรียบร้อยแล้ว</h2><p class="deal-close-main">แตะเครื่องหมาย <b>X มุมขวาบน</b> เพื่อปิดหน้านี้และกลับไปยังแชต LINE</p><p class="deal-close-note">ระบบกำลังสร้าง PDF ต่อให้อัตโนมัติ ไม่ต้องกดบันทึกซ้ำ และปิดหน้านี้ได้เลย</p><button type="button" class="deal-close-confirm">เข้าใจแล้ว — ปิดด้วย X ด้านบน</button></div>';
    const confirm=guide.querySelector('.deal-close-confirm');
    if(confirm)confirm.addEventListener('click',()=>{
      guide.classList.remove('pulse');
      void guide.offsetWidth;
      guide.classList.add('pulse');
      const arrowText=guide.querySelector('.deal-close-arrow-text');
      if(arrowText)arrowText.textContent='กด X มุมขวาบนได้เลย';
    });
    document.body.appendChild(guide);
    return guide;
  }

  function showCloseGuide(){
    const busy=document.getElementById('dealMobileBusy');
    if(busy)busy.classList.remove('is-visible','is-returning');
    const guide=ensureCloseGuide();
    guide.classList.add('is-visible','pulse');
    document.documentElement.style.overflow='hidden';
    document.body.style.overflow='hidden';
    const button=guide.querySelector('.deal-close-confirm');
    if(button)setTimeout(()=>button.focus({preventScroll:true}),60);
  }

  async function returnToLine(){
    // LIFF เปิดผ่าน LINE Client จริงสามารถปิดหน้าต่างให้ได้ทันที
    const sdk=await prepareLiff();
    if(sdk&&typeof sdk.isInClient==='function'&&sdk.isInClient()){
      try{
        sdk.closeWindow();
        return;
      }catch(error){
        console.warn('[return-line] LIFF close failed',error);
      }
    }

    // workers.dev / external webview บน iPhone ปิดแท็บด้วย JavaScript ไม่ได้อย่างน่าเชื่อถือ
    // จึงบอกผู้ใช้ให้กด X ของ LINE browser อย่างชัดเจนแทน
    showCloseGuide();
  }
  window.returnToLine=returnToLine;

  document.addEventListener('pointerdown',event=>{
    const target=event.target.closest('button,a,[role="button"],input[type="submit"]');
    if(!target)return;
    lastAction={text:clean(target.textContent||target.value||target.getAttribute('aria-label')||''),el:target,at:Date.now()};
  },true);

  document.addEventListener('click',event=>{
    const target=event.target.closest('button,a,[role="button"]');
    if(!target)return;
    const text=clean(target.textContent||target.getAttribute('aria-label')||'');
    if(/กลับ(?:ไป)?\s*LINE|เปิด\s*LINE/i.test(text)){
      event.preventDefault();
      event.stopImmediatePropagation();
      returnToLine();
    }
  },true);

  const nativeFetch=window.fetch.bind(window);
  window.fetch=async function(input,init){
    const method=clean((init&&init.method)||(input&&input.method)||'GET').toUpperCase();
    const shouldWait=!['GET','HEAD','OPTIONS'].includes(method);
    if(shouldWait)beginBusy(actionText());
    try{return await nativeFetch(input,init);}
    finally{if(shouldWait)endBusy();}
  };

  document.addEventListener('submit',event=>{
    if(event.defaultPrevented)return;
    beginBusy(actionText()||'บันทึกข้อมูล');
  });

  function addReturnButtonWhenNeeded(){
    const bodyText=clean(document.body&&document.body.innerText);
    if(!/กลับไป(?:ที่)?\s*LINE/i.test(bodyText))return;
    const hasControl=[...document.querySelectorAll('button,a,[role="button"]')].some(node=>/กลับ(?:ไป)?\s*LINE|เปิด\s*LINE/i.test(clean(node.textContent||node.getAttribute('aria-label')||'')));
    if(hasControl)return;
    const button=document.createElement('button');
    button.type='button';
    button.className='deal-auto-line-button';
    button.textContent='ปิดหน้านี้เพื่อกลับ LINE';
    button.addEventListener('click',returnToLine);
    document.body.appendChild(button);
  }

  function clarifyReturnButtons(){
    document.querySelectorAll('button,a,[role="button"]').forEach(node=>{
      const text=clean(node.textContent||node.getAttribute('aria-label')||'');
      if(/กลับ(?:ไป)?\s*LINE/i.test(text)&&!/ปิดหน้านี้/i.test(text)){
        if(node.tagName==='INPUT')node.value='ปิดหน้านี้เพื่อกลับ LINE';
        else node.textContent='ปิดหน้านี้เพื่อกลับ LINE';
      }
    });
  }

  const boot=()=>{clarifyReturnButtons();addReturnButtonWhenNeeded();prepareLiff();};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});
  else boot();
})();
</script>`;

export async function enhanceMobileWebResponse(response, options = {}) {
  if (!(response instanceof Response)) return response;
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("text/html")) return response;

  const source = await response.text();
  if (source.includes('id="deal-mobile-web-ux-script"')) {
    return new Response(source, response);
  }

  const script = SCRIPT.replace("__DEAL_LIFF_ID__", JSON.stringify(String(options.liffId || "")));
  const injection = STYLE + BRAND_THEME + script;
  let body;
  if (/<\/body>/i.test(source)) body = source.replace(/<\/body>/i, `${injection}</body>`);
  else if (/<\/html>/i.test(source)) body = source.replace(/<\/html>/i, `${injection}</html>`);
  else body = `${source}${injection}`;

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("cache-control", "no-store");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
