'use strict';
const APP_VERSION='2.0.1';
const ZXING_URL='https://unpkg.com/@zxing/browser@0.2.1/umd/zxing-browser.min.js';
const TESSERACT_URL='https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
const $=s=>document.querySelector(s);
const unlockPanel=$('#unlockPanel'),appPanel=$('#appPanel'),unlockForm=$('#unlockForm'),passInput=$('#passphrase'),rememberPass=$('#rememberPass'),unlockError=$('#unlockError');
const searchInput=$('#searchInput'),result=$('#result'),catalogStatus=$('#catalogStatus'),refreshBtn=$('#refreshBtn'),forgetBtn=$('#forgetBtn');
const scanBtn=$('#scanBtn'),coverBtn=$('#coverBtn'),cameraPanel=$('#cameraPanel'),cameraVideo=$('#cameraVideo'),cameraStatus=$('#cameraStatus'),closeCameraBtn=$('#closeCameraBtn');
const barcodePhotoBtn=$('#barcodePhotoBtn'),barcodePhotoInput=$('#barcodePhotoInput'),coverInput=$('#coverInput'),coverPanel=$('#coverPanel'),coverPreview=$('#coverPreview'),ocrStatus=$('#ocrStatus'),ocrProgress=$('#ocrProgress'),closeCoverBtn=$('#closeCoverBtn');
let catalog=null,passphrase='',stream=null,scanTimer=null,detector=null,zxingControls=null,barcodeBusy=false,ocrWorkerPromise=null,coverObjectUrl=null;
const CACHE_KEY='cmc.catalog.v1',PASS_KEY='cmc.pass.v1';

function norm(s){return (s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim()}
function escapeHtml(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function b64bytes(s){const raw=atob(s);const u=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)u[i]=raw.charCodeAt(i);return u}
function concat(...arrs){const n=arrs.reduce((a,b)=>a+b.length,0),o=new Uint8Array(n);let p=0;for(const a of arrs){o.set(a,p);p+=a.length}return o}
function constTimeEq(a,b){if(a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a[i]^b[i];return x===0}
function clamp(n,min,max){return Math.max(min,Math.min(max,n))}

async function decryptCatalog(wrapper,phrase){
  if(wrapper.v!==1)throw new Error('Unsupported catalog version');
  const salt=b64bytes(wrapper.salt),iv=b64bytes(wrapper.iv),ct=b64bytes(wrapper.ct),tag=b64bytes(wrapper.tag);
  const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(phrase),'PBKDF2',false,['deriveBits']);
  const bits=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:wrapper.iterations,hash:'SHA-256'},base,512));
  const aesKey=await crypto.subtle.importKey('raw',bits.slice(0,32),{name:'AES-CBC'},false,['decrypt']);
  const macKey=await crypto.subtle.importKey('raw',bits.slice(32),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const macData=concat(new TextEncoder().encode('CMC1'),salt,iv,ct);
  const calc=new Uint8Array(await crypto.subtle.sign('HMAC',macKey,macData));
  if(!constTimeEq(calc,tag))throw new Error('Wrong passphrase or damaged catalog');
  const plain=await crypto.subtle.decrypt({name:'AES-CBC',iv},aesKey,ct);
  return JSON.parse(new TextDecoder().decode(plain));
}

async function fetchAndUnlock(phrase){
  let networkErr=null;
  try{
    const r=await fetch('catalog.enc?ts='+Date.now(),{cache:'no-store'});if(!r.ok)throw new Error('Catalog HTTP '+r.status);
    const data=await decryptCatalog(await r.json(),phrase);localStorage.setItem(CACHE_KEY,JSON.stringify(data));return data;
  }catch(e){networkErr=e}
  const cached=localStorage.getItem(CACHE_KEY);if(cached){try{return JSON.parse(cached)}catch(_){}}
  throw networkErr||new Error('No cached catalog is available');
}

function showApp(){unlockPanel.classList.add('hidden');appPanel.classList.remove('hidden');updateStatus();searchInput.focus()}
function updateStatus(){if(!catalog)return;const d=new Date(catalog.library_changed_at);catalogStatus.textContent=`${catalog.count} movies • ${Number.isNaN(d.getTime())?'cached catalog':`updated ${d.toLocaleString()}`}`}
async function unlock(phrase,remember){unlockError.textContent='';try{catalog=await fetchAndUnlock(phrase);passphrase=phrase;if(remember)localStorage.setItem(PASS_KEY,phrase);else localStorage.removeItem(PASS_KEY);showApp()}catch(e){unlockError.textContent=e.message||'Could not unlock catalog'}}
unlockForm.addEventListener('submit',e=>{e.preventDefault();unlock(passInput.value,rememberPass.checked)});
refreshBtn.addEventListener('click',async()=>{if(!passphrase)return;refreshBtn.disabled=true;try{catalog=await fetchAndUnlock(passphrase);updateStatus();runSearch(searchInput.value)}catch(e){alert('Refresh failed: '+e.message)}finally{refreshBtn.disabled=false}});
forgetBtn.addEventListener('click',()=>{localStorage.removeItem(PASS_KEY);passphrase='';catalog=null;appPanel.classList.add('hidden');unlockPanel.classList.remove('hidden');passInput.value='';passInput.focus()});

function titleTokens(s){return norm(s).split(' ').filter(Boolean)}
function meaningfulTokens(s){const stop=new Set(['the','a','an','of','and','or','to','in','on','for','with','from','by']);return titleTokens(s).filter(t=>!stop.has(t)||t.length>3)}
function tokenScore(q,t){const qa=meaningfulTokens(q),ta=new Set(titleTokens(t));if(!qa.length)return 0;return qa.filter(x=>ta.has(x)).length/qa.length}
function rankMatches(q){const nq=norm(q);if(!nq||!catalog)return[];return catalog.movies.map(m=>{const nt=m.norm||norm(m.title);let score=0;if(nt===nq)score=100;else if(nt.startsWith(nq))score=88;else if(nt.includes(nq))score=82;else if(nq.includes(nt)&&nt.length>3)score=78;else score=Math.round(tokenScore(nq,nt)*70);return {...m,score}}).filter(m=>m.score>=42).sort((a,b)=>b.score-a.score||a.title.localeCompare(b.title)).slice(0,8)}
function renderExact(m,kicker='✓ YOU ALREADY HAVE THIS ONE',note=''){result.innerHTML=`<div class="answer good"><div class="kicker">${escapeHtml(kicker)}</div><div class="movie-title">${escapeHtml(m.title)} <span class="movie-year">${m.year?`(${m.year})`:''}</span></div>${note?`<div class="scan-source">${escapeHtml(note)}</div>`:''}</div>`}
function renderMatches(ms,label='PARTIAL MATCHES',note=''){if(!ms.length){result.innerHTML='<div class="answer bad"><div class="kicker">NO MATCH FOUND</div><div>Nothing in your ripped movie library matches that title.</div></div>';return}result.innerHTML=`<div class="answer warn"><div class="kicker">${escapeHtml(label)}</div><div class="match-list">${ms.map(m=>`<div class="match-row"><strong>${escapeHtml(m.title)}</strong><span class="movie-year">${m.year||''}</span></div>`).join('')}</div>${note?`<div class="scan-source">${escapeHtml(note)}</div>`:''}</div>`}
function runSearch(q){if(!catalog)return;const nq=norm(q);if(!nq){result.innerHTML='<div class="empty-state">Type a title, scan a barcode, or photograph the cover.</div>';return}const ms=rankMatches(q);const exact=ms.find(m=>(m.norm||norm(m.title))===nq);if(exact)renderExact(exact);else renderMatches(ms)}
searchInput.addEventListener('input',()=>runSearch(searchInput.value));

function loadScript(src,globalName){return new Promise((resolve,reject)=>{if(globalName&&window[globalName]){resolve(window[globalName]);return}const existing=document.querySelector(`script[data-cmc-src="${src}"]`);if(existing){existing.addEventListener('load',()=>resolve(globalName?window[globalName]:true),{once:true});existing.addEventListener('error',()=>reject(new Error('Could not load '+src)),{once:true});return}const s=document.createElement('script');s.src=src;s.async=true;s.crossOrigin='anonymous';s.dataset.cmcSrc=src;s.onload=()=>resolve(globalName?window[globalName]:true);s.onerror=()=>reject(new Error('Could not load scanner component'));document.head.appendChild(s)})}

function cleanProductTitle(s){return (s||'').replace(/\b(4k|uhd|ultra hd|blu[ -]?ray|dvd|digital|disc|widescreen|fullscreen|special edition|collector'?s edition|steelbook|combo pack|2[- ]disc|3[- ]disc|anniversary edition)\b/ig,' ').replace(/\([^)]*(blu|dvd|4k|uhd)[^)]*\)/ig,' ').replace(/[\[\]{}]/g,' ').replace(/\s+/g,' ').trim()}
async function resolveBarcode(code){
  if(barcodeBusy===false)barcodeBusy=true;
  cameraStatus.textContent=`Barcode ${code} read. Looking up title…`;
  try{
    const r=await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(code)}`,{headers:{Accept:'application/json'}});if(!r.ok)throw new Error('lookup HTTP '+r.status);
    const j=await r.json(),item=j.items&&j.items[0];if(!item||!item.title)throw new Error('barcode not found');
    const title=cleanProductTitle(item.title),matches=rankMatches(title);searchInput.value=title;
    closeCamera();
    const exact=matches.find(m=>(m.norm||norm(m.title))===norm(title));
    if(exact)renderExact(exact,'✓ YOU ALREADY HAVE THIS ONE',`Barcode identified: ${item.title}`);
    else if(matches.length)renderMatches(matches,'BARCODE — POSSIBLE MATCHES',`Barcode identified: ${item.title}`);
    else result.innerHTML=`<div class="answer warn"><div class="kicker">BARCODE IDENTIFIED</div><div><strong>${escapeHtml(item.title)}</strong></div><div class="barcode-note">I did not find that title in your library. UPC ${escapeHtml(code)}</div><button id="scanCoverFromResult" class="secondary inline-action" type="button">Scan the cover too</button></div>`;
  }catch(e){
    closeCamera();
    result.innerHTML=`<div class="answer warn"><div class="kicker">BARCODE READ</div><div>UPC <strong>${escapeHtml(code)}</strong></div><div class="barcode-note">The barcode scanner worked, but the public product database did not identify this disc. Cover scan does not need that database.</div><button id="scanCoverFromResult" class="secondary inline-action" type="button">Scan cover instead</button></div>`;
  }finally{barcodeBusy=false}
}

async function makeNativeDetector(){
  if(!('BarcodeDetector' in globalThis))return null;
  try{
    const wanted=['upc_a','upc_e','ean_13','ean_8'];
    if(typeof BarcodeDetector.getSupportedFormats==='function'){
      const supported=await BarcodeDetector.getSupportedFormats(),formats=wanted.filter(f=>supported.includes(f));
      return formats.length?new BarcodeDetector({formats}):new BarcodeDetector();
    }
    return new BarcodeDetector();
  }catch(_){return null}
}

async function tuneCameraTrack(s){
  try{
    const track=s.getVideoTracks()[0];if(!track||!track.getCapabilities)return;
    const caps=track.getCapabilities(),advanced={};
    if(Array.isArray(caps.focusMode)&&caps.focusMode.includes('continuous'))advanced.focusMode='continuous';
    if(Object.keys(advanced).length)await track.applyConstraints({advanced:[advanced]});
  }catch(_){ }
}

async function nativeScanLoop(){if(!detector||!stream||barcodeBusy)return;try{const codes=await detector.detect(cameraVideo);if(codes&&codes[0]&&codes[0].rawValue){barcodeBusy=true;await resolveBarcode(codes[0].rawValue);return}}catch(_){ }scanTimer=setTimeout(nativeScanLoop,180)}
async function startNativeBarcode(){
  detector=await makeNativeDetector();if(!detector)throw new Error('Native scanner unavailable');
  stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false});
  await tuneCameraTrack(stream);cameraVideo.srcObject=stream;await cameraVideo.play();cameraStatus.textContent='Hold the barcode inside the box. Move a little closer if needed.';nativeScanLoop();
}

async function startZXingBarcode(){
  await loadScript(ZXING_URL,'ZXingBrowser');
  if(!window.ZXingBrowser||!ZXingBrowser.BrowserMultiFormatReader)throw new Error('Fallback scanner did not load');
  const reader=new ZXingBrowser.BrowserMultiFormatReader(undefined,{delayBetweenScanAttempts:180,delayBetweenScanSuccess:1200});
  cameraStatus.textContent='Fallback scanner ready. Hold the barcode steady inside the box.';
  zxingControls=await reader.decodeFromConstraints({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false},cameraVideo,async scanResult=>{
    if(scanResult&&!barcodeBusy){barcodeBusy=true;const code=typeof scanResult.getText==='function'?scanResult.getText():String(scanResult.text||scanResult);await resolveBarcode(code)}
  });
}

async function openCamera(){
  closeCover();closeCamera();barcodeBusy=false;cameraPanel.classList.remove('hidden');cameraStatus.textContent='Starting camera…';
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){cameraStatus.textContent='Live camera access is unavailable in this browser. Use a barcode photo instead.';return}
  try{await startNativeBarcode();return}catch(_){closeCameraStreamsOnly();cameraPanel.classList.remove('hidden')}
  try{cameraStatus.textContent='Loading compatibility scanner…';await startZXingBarcode()}catch(e){cameraStatus.textContent='Live scan could not start. Tap “Take a barcode photo” below.'}
}
function closeCameraStreamsOnly(){if(scanTimer){clearTimeout(scanTimer);scanTimer=null}if(zxingControls){try{zxingControls.stop()}catch(_){}zxingControls=null}if(stream){for(const t of stream.getTracks())t.stop();stream=null}if(cameraVideo.srcObject){try{for(const t of cameraVideo.srcObject.getTracks())t.stop()}catch(_){}cameraVideo.srcObject=null}detector=null}
function closeCamera(){closeCameraStreamsOnly();cameraPanel.classList.add('hidden')}

async function imageFromFile(file){return new Promise((resolve,reject)=>{const url=URL.createObjectURL(file),img=new Image();img.onload=()=>resolve({img,url});img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('Could not open image'))};img.src=url})}
async function decodeBarcodePhoto(file){
  result.innerHTML='<div class="answer warn"><div class="kicker">READING BARCODE PHOTO</div><div>Please wait…</div></div>';
  let bitmap=null;
  try{
    const native=await makeNativeDetector();
    if(native&&'createImageBitmap' in window){bitmap=await createImageBitmap(file);const codes=await native.detect(bitmap);if(codes&&codes[0]&&codes[0].rawValue){bitmap.close?.();await resolveBarcode(codes[0].rawValue);return}}
  }catch(_){if(bitmap)bitmap.close?.()}
  try{
    await loadScript(ZXING_URL,'ZXingBrowser');const reader=new ZXingBrowser.BrowserMultiFormatReader();const {img,url}=await imageFromFile(file);
    try{const decoded=await reader.decodeFromImageElement(img);const code=typeof decoded.getText==='function'?decoded.getText():String(decoded.text||decoded);URL.revokeObjectURL(url);await resolveBarcode(code);return}finally{URL.revokeObjectURL(url)}
  }catch(_){result.innerHTML='<div class="answer bad"><div class="kicker">BARCODE NOT FOUND</div><div>I could not read a UPC/EAN from that photo. Try filling the frame with the barcode, or scan the front cover instead.</div><button id="scanCoverFromResult" class="secondary inline-action" type="button">Scan cover</button></div>'}
}

function levenshteinRatio(a,b){a=norm(a);b=norm(b);if(!a||!b)return 0;if(a===b)return 1;if(a.length>90)a=a.slice(0,90);if(b.length>90)b=b.slice(0,90);const prev=Array.from({length:b.length+1},(_,i)=>i),cur=new Array(b.length+1);for(let i=1;i<=a.length;i++){cur[0]=i;for(let j=1;j<=b.length;j++)cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));for(let j=0;j<=b.length;j++)prev[j]=cur[j]}return 1-prev[b.length]/Math.max(a.length,b.length)}
function ocrLines(text){return String(text||'').split(/\r?\n/).map(s=>s.trim()).filter(s=>s.length>=2&&s.length<=90).filter(s=>!/^(blu.?ray|dvd|4k|ultra hd|digital|widescreen|fullscreen|rated|disc|disk|special features?)$/i.test(s)).slice(0,50)}
function rankOcrMatches(text){
  if(!catalog)return[];const all=norm(text),allTokens=new Set(titleTokens(all)),lines=ocrLines(text).map(norm).filter(Boolean),yearMatches=new Set((text.match(/\b(?:19|20)\d{2}\b/g)||[]).map(Number));
  return catalog.movies.map(m=>{const nt=m.norm||norm(m.title),tokens=meaningfulTokens(nt),rawTokens=titleTokens(nt);let score=0,reason='';
    if(nt.length>=3&&all.includes(nt)){score=100;reason='title text found on cover'}
    else{
      const coverage=tokens.length?tokens.filter(t=>allTokens.has(t)).length/tokens.length:0;
      const rawCoverage=rawTokens.length?rawTokens.filter(t=>allTokens.has(t)).length/rawTokens.length:0;
      let bestLine=0;for(const line of lines){bestLine=Math.max(bestLine,levenshteinRatio(line,nt));if(line.includes(nt)||nt.includes(line)&&line.length>=5)bestLine=Math.max(bestLine,.9)}
      score=Math.round(Math.max(coverage*.82,rawCoverage*.76,bestLine*.86)*100);reason='fuzzy cover text';
      if(tokens.length===1&&tokens[0].length<=4&&coverage===1)score=Math.min(score,82);
    }
    if(m.year&&yearMatches.has(Number(m.year)))score=Math.min(100,score+5);
    return {...m,score,reason}
  }).filter(m=>m.score>=48).sort((a,b)=>b.score-a.score||a.title.localeCompare(b.title)).slice(0,8)
}

async function prepareOcrImage(file){
  const {img,url}=await imageFromFile(file);try{const max=1800,scale=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight)),w=Math.max(1,Math.round(img.naturalWidth*scale)),h=Math.max(1,Math.round(img.naturalHeight*scale)),canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.drawImage(img,0,0,w,h);return canvas}finally{URL.revokeObjectURL(url)}}
function setOcrProgress(p,status){ocrProgress.style.width=`${Math.round(clamp(p,0,1)*100)}%`;if(status)ocrStatus.textContent=status}
async function getOcrWorker(){
  if(ocrWorkerPromise)return ocrWorkerPromise;
  ocrWorkerPromise=(async()=>{await loadScript(TESSERACT_URL,'Tesseract');if(!window.Tesseract)throw new Error('OCR engine did not load');const oem=Tesseract.OEM&&Tesseract.OEM.LSTM_ONLY!==undefined?Tesseract.OEM.LSTM_ONLY:1;return Tesseract.createWorker('eng',oem,{logger:m=>{if(m&&typeof m.progress==='number'){const label=(m.status||'Reading cover').replace(/_/g,' ');setOcrProgress(m.progress,label.charAt(0).toUpperCase()+label.slice(1)+'…')}}})})();
  try{return await ocrWorkerPromise}catch(e){ocrWorkerPromise=null;throw e}
}
async function scanCoverFile(file){
  closeCamera();coverPanel.classList.remove('hidden');if(coverObjectUrl)URL.revokeObjectURL(coverObjectUrl);coverObjectUrl=URL.createObjectURL(file);coverPreview.src=coverObjectUrl;setOcrProgress(.03,'Preparing cover image…');
  try{
    const canvas=await prepareOcrImage(file);setOcrProgress(.08,'Loading on-phone text reader…');const worker=await getOcrWorker();const out=await worker.recognize(canvas),text=(out&&out.data&&out.data.text)||'';setOcrProgress(1,'Cover read complete.');
    const matches=rankOcrMatches(text),top=matches[0],second=matches[1];
    closeCover(false);
    const raw=ocrLines(text).slice(0,8).join('\n');
    if(top&&top.score>=92&&(top.score-(second?.score||0)>=5||top.score===100))renderExact(top,'✓ COVER MATCH — YOU HAVE THIS',`Matched from cover text (${top.score}% confidence)`);
    else if(matches.length)renderMatches(matches,'COVER — POSSIBLE MATCHES',`Best text match ${top.score}%`);
    else result.innerHTML=`<div class="answer bad"><div class="kicker">NO LIBRARY MATCH FROM COVER</div><div>I read the cover but did not find a confident match in your  library.</div>${raw?`<div class="ocr-raw">${escapeHtml(raw)}</div>`:''}<div class="ocr-note">Tip: keep the title large and square in the photo. Manual search remains available above.</div></div>`;
  }catch(e){closeCover(false);result.innerHTML=`<div class="answer warn"><div class="kicker">COVER SCAN COULD NOT FINISH</div><div>${escapeHtml(e.message||'OCR unavailable')}</div><div class="ocr-note">The first cover scan needs internet once to load the OCR engine. After that, the browser normally caches its components.</div></div>`}
}
function closeCover(clear=true){coverPanel.classList.add('hidden');if(clear&&coverObjectUrl){URL.revokeObjectURL(coverObjectUrl);coverObjectUrl=null;coverPreview.removeAttribute('src')}setOcrProgress(0,'Preparing image…')}

scanBtn.addEventListener('click',openCamera);closeCameraBtn.addEventListener('click',closeCamera);barcodePhotoBtn.addEventListener('click',()=>barcodePhotoInput.click());
barcodePhotoInput.addEventListener('change',async()=>{const f=barcodePhotoInput.files&&barcodePhotoInput.files[0];barcodePhotoInput.value='';if(f){closeCamera();await decodeBarcodePhoto(f)}});
coverBtn.addEventListener('click',()=>coverInput.click());closeCoverBtn.addEventListener('click',()=>closeCover());
coverInput.addEventListener('change',async()=>{const f=coverInput.files&&coverInput.files[0];coverInput.value='';if(f)await scanCoverFile(f)});
result.addEventListener('click',e=>{const b=e.target.closest('#scanCoverFromResult');if(b)coverInput.click()});
document.addEventListener('visibilitychange',()=>{if(document.hidden)closeCamera()});
window.addEventListener('pagehide',()=>{closeCamera();if(ocrWorkerPromise){ocrWorkerPromise.then(w=>w.terminate()).catch(()=>{});ocrWorkerPromise=null}});

(async function init(){
  if('serviceWorker' in navigator){try{const reg=await navigator.serviceWorker.register('sw.js');reg.update().catch(()=>{})}catch(_){}}
  const saved=localStorage.getItem(PASS_KEY);if(saved){passInput.value=saved;await unlock(saved,true)}else{unlockPanel.classList.remove('hidden');passInput.focus()}
  console.info('Colin Movie Check',APP_VERSION);
})();
