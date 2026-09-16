'use strict';
const APP_VERSION='2.6';
const UPC_PROXY_BASE='https://colin-movie-upc.casey-burnette.workers.dev';
const ZXING_URL='https://unpkg.com/@zxing/browser@0.2.1/umd/zxing-browser.min.js';
const $=s=>document.querySelector(s);
const unlockPanel=$('#unlockPanel'),appPanel=$('#appPanel'),unlockForm=$('#unlockForm'),passInput=$('#passphrase'),rememberPass=$('#rememberPass'),unlockError=$('#unlockError');
const titleInput=$('#titleInput'),yearInput=$('#yearInput'),result=$('#result'),catalogStatus=$('#catalogStatus'),refreshBtn=$('#refreshBtn'),forgetBtn=$('#forgetBtn');
const scanBtn=$('#scanBtn'),cameraPanel=$('#cameraPanel'),cameraVideo=$('#cameraVideo'),cameraStatus=$('#cameraStatus'),closeCameraBtn=$('#closeCameraBtn');
const barcodePhotoBtn=$('#barcodePhotoBtn'),barcodePhotoInput=$('#barcodePhotoInput');
let catalog=null,passphrase='',stream=null,scanTimer=null,detector=null,zxingControls=null,barcodeBusy=false;
const CACHE_KEY='cmc.catalog.wrapper.v26',PASS_KEY='cmc.pass.v1';

function norm(s){return (s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim()}
function escapeHtml(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function b64bytes(s){const raw=atob(s);const u=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)u[i]=raw.charCodeAt(i);return u}
function concat(...arrs){const n=arrs.reduce((a,b)=>a+b.length,0),o=new Uint8Array(n);let p=0;for(const a of arrs){o.set(a,p);p+=a.length}return o}
function constTimeEq(a,b){if(a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a[i]^b[i];return x===0}

async function decryptCatalog(wrapper,phrase){
  if(wrapper.v!==1)throw new Error('Unsupported catalog version');
  const salt=b64bytes(wrapper.salt),iv=b64bytes(wrapper.iv),ct=b64bytes(wrapper.ct),tag=b64bytes(wrapper.tag);
  const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(phrase),'PBKDF2',false,['deriveBits']);
  const bits=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:wrapper.iterations,hash:'SHA-256'},base,512));
  const aesKey=await crypto.subtle.importKey('raw',bits.slice(0,32),{name:'AES-CBC'},false,['decrypt']);
  const macKey=await crypto.subtle.importKey('raw',bits.slice(32),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const calc=new Uint8Array(await crypto.subtle.sign('HMAC',macKey,concat(new TextEncoder().encode('CMC1'),salt,iv,ct)));
  if(!constTimeEq(calc,tag))throw new Error('Wrong passphrase or damaged catalog');
  const plain=await crypto.subtle.decrypt({name:'AES-CBC',iv},aesKey,ct);
  return JSON.parse(new TextDecoder().decode(plain));
}

async function fetchAndUnlock(phrase){
  let wrapper=null,networkErr=null;
  try{
    const r=await fetch('catalog.enc?fresh='+Date.now(),{cache:'no-store'});
    if(!r.ok)throw new Error('Catalog HTTP '+r.status);
    wrapper=await r.json();
  }catch(e){networkErr=e}
  if(wrapper){
    const data=await decryptCatalog(wrapper,phrase);
    localStorage.setItem(CACHE_KEY,JSON.stringify(wrapper));
    return data;
  }
  const cached=localStorage.getItem(CACHE_KEY);
  if(cached)return await decryptCatalog(JSON.parse(cached),phrase);
  throw networkErr||new Error('No cached encrypted catalog is available');
}

function showUnlock(message=''){appPanel.classList.add('hidden');unlockPanel.classList.remove('hidden');if(message)unlockError.textContent=message;passInput.focus()}
function showApp(){unlockPanel.classList.add('hidden');appPanel.classList.remove('hidden');updateStatus();titleInput.focus()}
function updateStatus(){if(!catalog)return;const d=new Date(catalog.library_changed_at);catalogStatus.textContent=`${catalog.count} movies • ${Number.isNaN(d.getTime())?'cached catalog':`updated ${d.toLocaleString()}`}`}
async function unlock(phrase,remember){unlockError.textContent='';try{catalog=await fetchAndUnlock(phrase);passphrase=phrase;if(remember)localStorage.setItem(PASS_KEY,phrase);else localStorage.removeItem(PASS_KEY);showApp();runSearch();return true}catch(e){showUnlock(e.message||'Could not unlock catalog');return false}}
unlockForm.addEventListener('submit',e=>{e.preventDefault();unlock(passInput.value,rememberPass.checked)});
refreshBtn.addEventListener('click',async()=>{if(!passphrase)return;refreshBtn.disabled=true;try{catalog=await fetchAndUnlock(passphrase);updateStatus();runSearch()}catch(e){alert('Refresh failed: '+e.message)}finally{refreshBtn.disabled=false}});
forgetBtn.addEventListener('click',()=>{localStorage.removeItem(PASS_KEY);localStorage.removeItem(CACHE_KEY);passphrase='';catalog=null;passInput.value='';unlockError.textContent='';showUnlock()});

const STOP=new Set(['the','a','an','of','and','or','to','in','on','for','with','from','by','part']);
function tokens(s){return norm(s).split(' ').filter(Boolean)}
function usefulTokens(s){return tokens(s).filter(t=>!STOP.has(t)||t.length>3)}
function editRatio(a,b){a=norm(a);b=norm(b);if(!a||!b)return 0;if(a===b)return 1;if(a.length>80)a=a.slice(0,80);if(b.length>80)b=b.slice(0,80);const prev=Array.from({length:b.length+1},(_,i)=>i),cur=new Array(b.length+1);for(let i=1;i<=a.length;i++){cur[0]=i;for(let j=1;j<=b.length;j++)cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));for(let j=0;j<=b.length;j++)prev[j]=cur[j]}return 1-prev[b.length]/Math.max(a.length,b.length)}
function parseYear(){const s=yearInput.value.trim();if(!s)return null;const y=Number(s);return Number.isInteger(y)&&y>=1880&&y<=2100?y:null}
function rankMatches(q,year=null){
  const nq=norm(q);if(!nq||!catalog)return[];const qt=usefulTokens(nq);
  return catalog.movies.map(m=>{
    const nt=m.norm||norm(m.title),tt=new Set(tokens(nt));let score=0;
    if(nt===nq)score=100;
    else if(nt.startsWith(nq))score=92;
    else if(nt.includes(nq))score=88;
    else {
      const coverage=qt.length?qt.filter(t=>tt.has(t)||[...tt].some(x=>x.startsWith(t)||t.startsWith(x))).length/qt.length:0;
      const fuzzy=editRatio(nq,nt);
      score=Math.round(Math.max(coverage*82,fuzzy*72));
    }
    if(year){if(Number(m.year)===year)score+=15;else if(m.year&&Math.abs(Number(m.year)-year)===1)score+=4;else if(m.year)score-=18}
    return {...m,score:Math.min(115,score)};
  }).filter(m=>m.score>=44).sort((a,b)=>b.score-a.score||((a.year||0)-(b.year||0))||a.title.localeCompare(b.title)).slice(0,10)
}
function renderExact(m,kicker='✓ YOU ALREADY HAVE THIS ONE',note=''){result.innerHTML=`<div class="answer good"><div class="kicker">${escapeHtml(kicker)}</div><div class="movie-title">${escapeHtml(m.title)} <span class="movie-year">${m.year?`(${m.year})`:''}</span></div>${note?`<div class="scan-source">${escapeHtml(note)}</div>`:''}</div>`}
function renderMatches(ms,label='POSSIBLE MATCHES',note=''){if(!ms.length){result.innerHTML='<div class="answer bad"><div class="kicker">NO MATCH FOUND</div><div>Nothing in your ripped movie library matches that title/year.</div></div>';return}result.innerHTML=`<div class="answer warn"><div class="kicker">${escapeHtml(label)}</div><div class="match-list">${ms.map(m=>`<div class="match-row"><strong>${escapeHtml(m.title)}</strong><span class="movie-year">${m.year||''}</span></div>`).join('')}</div>${note?`<div class="scan-source">${escapeHtml(note)}</div>`:''}</div>`}
function runSearch(){if(!catalog)return;const q=titleInput.value.trim(),year=parseYear();if(!q){result.innerHTML='<div class="empty-state">Type a rough title and, if useful, a year — or scan the barcode.</div>';return}const ms=rankMatches(q,year);const nq=norm(q);const exact=ms.find(m=>(m.norm||norm(m.title))===nq&&(!year||!m.year||Number(m.year)===year));if(exact)renderExact(exact);else renderMatches(ms,year?'TITLE + YEAR MATCHES':'PARTIAL TITLE MATCHES')}
titleInput.addEventListener('input',runSearch);yearInput.addEventListener('input',runSearch);

function loadScript(src,globalName){return new Promise((resolve,reject)=>{if(globalName&&window[globalName]){resolve(window[globalName]);return}const existing=document.querySelector(`script[data-cmc-src="${src}"]`);if(existing){existing.addEventListener('load',()=>resolve(globalName?window[globalName]:true),{once:true});existing.addEventListener('error',()=>reject(new Error('Could not load '+src)),{once:true});return}const s=document.createElement('script');s.src=src;s.async=true;s.crossOrigin='anonymous';s.dataset.cmcSrc=src;s.onload=()=>resolve(globalName?window[globalName]:true);s.onerror=()=>reject(new Error('Could not load scanner component'));document.head.appendChild(s)})}

function productYear(s){const m=String(s||'').match(/\b((?:18|19|20)\d{2})\b/);return m?Number(m[1]):null}
function cleanProductTitle(s){
  let x=String(s||'');
  x=x.replace(/\([^)]*(?:dvd|blu[ -]?ray|4k|uhd|ultra hd|disc|edition|steelbook|widescreen|fullscreen|digital|combo|standard)[^)]*\)/ig,' ');
  x=x.replace(/\[[^\]]*(?:dvd|blu[ -]?ray|4k|uhd|disc|edition|steelbook|widescreen|fullscreen|digital|combo|standard)[^\]]*\]/ig,' ');
  x=x.replace(/\b(4k|uhd|ultra hd|blu[ -]?ray|dvd|digital|video disc|disc|widescreen|fullscreen|special edition|collector'?s edition|steelbook|combo pack|2[- ]disc|3[- ]disc|anniversary edition|standard edition|standard)\b/ig,' ');
  x=x.replace(/\b(?:18|19|20)\d{2}\b/g,' ');
  x=x.replace(/[\[\]{}()]/g,' ');
  x=x.replace(/\s+/g,' ').trim();
  return x;
}
function barcodeVariants(code){const d=String(code||'').replace(/\D/g,'');const out=[d];if(d.length===12)out.push('0'+d);if(d.length===13&&d.startsWith('0'))out.push(d.slice(1));if(d.length===14&&d.startsWith('00'))out.push(d.slice(2));return [...new Set(out.filter(Boolean))]}
async function fetchJsonWithTimeout(url,ms=7000){const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),ms);try{const r=await fetch(url,{headers:{Accept:'application/json'},signal:ctrl.signal,cache:'no-store'});let j=null;try{j=await r.json()}catch(_){}if(!r.ok){const err=new Error((j&&j.error)||('HTTP '+r.status));err.status=r.status;err.payload=j;throw err}return j}finally{clearTimeout(timer)}}
function validYear(v){const y=Number(v);return Number.isInteger(y)&&y>=1880&&y<=2100?y:null}
async function lookupProxy(code){
  if(!UPC_PROXY_BASE||UPC_PROXY_BASE.includes('__UPC_PROXY'))throw new Error('UPC lookup relay is not configured');
  const j=await fetchJsonWithTimeout(`${UPC_PROXY_BASE}/lookup/${encodeURIComponent(code)}`,7000);
  if(!j||j.ok!==true)throw new Error((j&&j.error)||'lookup relay error');
  if(!j.found||!j.title){const e=new Error('not_found');e.code='NOT_FOUND';throw e}
  const raw=String(j.title).trim(),title=cleanProductTitle(raw),year=productYear(raw);
  if(title.length<2)throw new Error('no usable movie title');
  return {raw,title,year,format:'',source:String(j.source||'UPCitemdb'),lookupCode:code};
}
async function lookupBarcode(code){
  const attempts=[];
  for(const c of barcodeVariants(code)){
    try{return await lookupProxy(c)}catch(e){attempts.push({code:c,error:e});if(e&&e.status===429)break}
  }
  const rateLimited=attempts.some(a=>a.error&&a.error.status===429);
  const allNotFound=attempts.length&&attempts.every(a=>a.error&&a.error.code==='NOT_FOUND');
  const e=new Error(rateLimited?'UPC lookup daily/rate limit reached':allNotFound?'UPC not found in database':(attempts[0]?.error?.message||'UPC lookup failed'));
  e.code=rateLimited?'RATE_LIMIT':allNotFound?'NOT_FOUND':'LOOKUP_FAILED';
  e.attempts=attempts;
  throw e;
}
async function resolveBarcode(code){
  barcodeBusy=true;cameraStatus.textContent=`Barcode ${code} read. Looking up title…`;
  try{
    const found=await lookupBarcode(code),title=found.title||found.raw,year=found.year||null;
    titleInput.value=title;yearInput.value=year||'';closeCamera();
    const matches=rankMatches(title,year),exact=matches.find(m=>(m.norm||norm(m.title))===norm(title)&&(!year||!m.year||Number(m.year)===year));
    const details=[found.source,found.year].filter(Boolean).join(' • ');
    if(exact)renderExact(exact,'✓ YOU ALREADY HAVE THIS ONE',`${details}: ${found.raw}`);
    else if(matches.length)renderMatches(matches,'BARCODE — POSSIBLE MATCHES',`${details}: ${found.raw}`);
    else result.innerHTML=`<div class="answer bad"><div class="kicker">BARCODE IDENTIFIED — NOT IN LIBRARY</div><div><strong>${escapeHtml(found.raw)}${found.year?` (${escapeHtml(found.year)})`:''}</strong></div><div class="barcode-note">UPC ${escapeHtml(code)} • ${escapeHtml(details)}</div></div>`;
  }catch(e){
    closeCamera();
    const q=encodeURIComponent(code+' DVD Blu-ray movie');
    const label=e&&e.code==='RATE_LIMIT'?'BARCODE READ — LOOKUP LIMIT':e&&e.code==='NOT_FOUND'?'BARCODE READ — DATABASE MISS':'BARCODE READ — LOOKUP UNAVAILABLE';
    const note=e&&e.code==='RATE_LIMIT'?'The free UPC lookup has hit its rate limit.':e&&e.code==='NOT_FOUND'?'UPCitemdb returned no product for this barcode.':'The barcode scanned correctly, but the lookup relay could not get a usable response.';
    result.innerHTML=`<div class="answer warn"><div class="kicker">${escapeHtml(label)}</div><div>UPC <strong>${escapeHtml(code)}</strong></div><div class="barcode-note">${escapeHtml(note)} You can still type a rough title above.</div><div class="fallback-links"><a class="online-link" href="https://www.google.com/search?q=${q}" target="_blank" rel="noopener">Search this UPC on the web</a></div></div>`;
  }finally{barcodeBusy=false}
}

async function makeNativeDetector(){if(!('BarcodeDetector' in globalThis))return null;try{const wanted=['upc_a','upc_e','ean_13','ean_8'];if(typeof BarcodeDetector.getSupportedFormats==='function'){const supported=await BarcodeDetector.getSupportedFormats(),formats=wanted.filter(f=>supported.includes(f));return formats.length?new BarcodeDetector({formats}):new BarcodeDetector()}return new BarcodeDetector()}catch(_){return null}}
async function tuneCameraTrack(s){try{const track=s.getVideoTracks()[0];if(!track||!track.getCapabilities)return;const caps=track.getCapabilities(),advanced={};if(Array.isArray(caps.focusMode)&&caps.focusMode.includes('continuous'))advanced.focusMode='continuous';if(Object.keys(advanced).length)await track.applyConstraints({advanced:[advanced]})}catch(_){}}
async function nativeScanLoop(){if(!detector||!stream||barcodeBusy)return;try{const codes=await detector.detect(cameraVideo);if(codes&&codes[0]&&codes[0].rawValue){barcodeBusy=true;await resolveBarcode(codes[0].rawValue);return}}catch(_){}scanTimer=setTimeout(nativeScanLoop,180)}
async function startNativeBarcode(){detector=await makeNativeDetector();if(!detector)throw new Error('Native scanner unavailable');stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false});await tuneCameraTrack(stream);cameraVideo.srcObject=stream;await cameraVideo.play();cameraStatus.textContent='Hold the barcode inside the box.';nativeScanLoop()}
async function startZXingBarcode(){await loadScript(ZXING_URL,'ZXingBrowser');if(!window.ZXingBrowser||!ZXingBrowser.BrowserMultiFormatReader)throw new Error('Fallback scanner did not load');const reader=new ZXingBrowser.BrowserMultiFormatReader(undefined,{delayBetweenScanAttempts:180,delayBetweenScanSuccess:1200});cameraStatus.textContent='Compatibility scanner ready. Hold the barcode steady.';zxingControls=await reader.decodeFromConstraints({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false},cameraVideo,async scanResult=>{if(scanResult&&!barcodeBusy){barcodeBusy=true;const code=typeof scanResult.getText==='function'?scanResult.getText():String(scanResult.text||scanResult);await resolveBarcode(code)}})}
async function openCamera(){closeCamera();barcodeBusy=false;cameraPanel.classList.remove('hidden');cameraStatus.textContent='Starting camera…';if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){cameraStatus.textContent='Live camera is unavailable. Use a barcode photo instead.';return}try{await startNativeBarcode();return}catch(_){closeCameraStreamsOnly();cameraPanel.classList.remove('hidden')}try{cameraStatus.textContent='Loading compatibility scanner…';await startZXingBarcode()}catch(_){cameraStatus.textContent='Live scan could not start. Tap “Take a barcode photo” below.'}}
function closeCameraStreamsOnly(){if(scanTimer){clearTimeout(scanTimer);scanTimer=null}if(zxingControls){try{zxingControls.stop()}catch(_){}zxingControls=null}if(stream){for(const t of stream.getTracks())t.stop();stream=null}if(cameraVideo.srcObject){try{for(const t of cameraVideo.srcObject.getTracks())t.stop()}catch(_){}cameraVideo.srcObject=null}detector=null}
function closeCamera(){closeCameraStreamsOnly();cameraPanel.classList.add('hidden')}
async function imageFromFile(file){return new Promise((resolve,reject)=>{const url=URL.createObjectURL(file),img=new Image();img.onload=()=>resolve({img,url});img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('Could not open image'))};img.src=url})}
async function decodeBarcodePhoto(file){result.innerHTML='<div class="answer warn"><div class="kicker">READING BARCODE PHOTO</div><div>Please wait…</div></div>';let bitmap=null;try{const native=await makeNativeDetector();if(native&&'createImageBitmap' in window){bitmap=await createImageBitmap(file);const codes=await native.detect(bitmap);if(codes&&codes[0]&&codes[0].rawValue){bitmap.close?.();await resolveBarcode(codes[0].rawValue);return}}}catch(_){if(bitmap)bitmap.close?.()}try{await loadScript(ZXING_URL,'ZXingBrowser');const reader=new ZXingBrowser.BrowserMultiFormatReader();const {img,url}=await imageFromFile(file);try{const decoded=await reader.decodeFromImageElement(img);const code=typeof decoded.getText==='function'?decoded.getText():String(decoded.text||decoded);await resolveBarcode(code);return}finally{URL.revokeObjectURL(url)}}catch(_){result.innerHTML='<div class="answer bad"><div class="kicker">BARCODE NOT FOUND</div><div>I could not read a UPC/EAN from that photo. Try again with the barcode filling most of the frame, or type the title.</div></div>'}}

scanBtn.addEventListener('click',openCamera);closeCameraBtn.addEventListener('click',closeCamera);barcodePhotoBtn.addEventListener('click',()=>barcodePhotoInput.click());
barcodePhotoInput.addEventListener('change',async()=>{const f=barcodePhotoInput.files&&barcodePhotoInput.files[0];barcodePhotoInput.value='';if(f){closeCamera();await decodeBarcodePhoto(f)}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)closeCamera()});window.addEventListener('pagehide',closeCamera);

(async function init(){
  if('serviceWorker' in navigator){try{const reg=await navigator.serviceWorker.register('sw.js');reg.update().catch(()=>{})}catch(_){}}
  showUnlock();
  const saved=localStorage.getItem(PASS_KEY);
  if(saved){passInput.value=saved;unlockError.textContent='Checking saved key…';await unlock(saved,true)}
  console.info('Colin Movie Check',APP_VERSION);
})();
