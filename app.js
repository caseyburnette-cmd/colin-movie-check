'use strict';
const $ = s => document.querySelector(s);
const unlockPanel=$('#unlockPanel'), appPanel=$('#appPanel'), unlockForm=$('#unlockForm'), passInput=$('#passphrase'), rememberPass=$('#rememberPass'), unlockError=$('#unlockError');
const searchInput=$('#searchInput'), result=$('#result'), catalogStatus=$('#catalogStatus'), refreshBtn=$('#refreshBtn'), forgetBtn=$('#forgetBtn');
const scanBtn=$('#scanBtn'), cameraPanel=$('#cameraPanel'), cameraVideo=$('#cameraVideo'), cameraStatus=$('#cameraStatus'), closeCameraBtn=$('#closeCameraBtn');
let catalog=null, passphrase='', stream=null, scanTimer=null, detector=null;
const CACHE_KEY='cmc.catalog.v1', PASS_KEY='cmc.pass.v1';

function norm(s){return (s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim()}
function escapeHtml(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function b64bytes(s){const raw=atob(s);const u=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)u[i]=raw.charCodeAt(i);return u}
function concat(...arrs){const n=arrs.reduce((a,b)=>a+b.length,0),o=new Uint8Array(n);let p=0;for(const a of arrs){o.set(a,p);p+=a.length}return o}
function constTimeEq(a,b){if(a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a[i]^b[i];return x===0}

async function decryptCatalog(wrapper, phrase){
  if(wrapper.v!==1) throw new Error('Unsupported catalog version');
  const salt=b64bytes(wrapper.salt), iv=b64bytes(wrapper.iv), ct=b64bytes(wrapper.ct), tag=b64bytes(wrapper.tag);
  const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(phrase),'PBKDF2',false,['deriveBits']);
  const bits=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:wrapper.iterations,hash:'SHA-256'},base,512));
  const aesKey=await crypto.subtle.importKey('raw',bits.slice(0,32),{name:'AES-CBC'},false,['decrypt']);
  const macKey=await crypto.subtle.importKey('raw',bits.slice(32),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const macData=concat(new TextEncoder().encode('CMC1'),salt,iv,ct);
  const calc=new Uint8Array(await crypto.subtle.sign('HMAC',macKey,macData));
  if(!constTimeEq(calc,tag)) throw new Error('Wrong passphrase or damaged catalog');
  const plain=await crypto.subtle.decrypt({name:'AES-CBC',iv},aesKey,ct);
  return JSON.parse(new TextDecoder().decode(plain));
}

async function fetchAndUnlock(phrase){
  let networkErr=null;
  try{
    const r=await fetch('catalog.enc?ts='+Date.now(),{cache:'no-store'}); if(!r.ok) throw new Error('Catalog HTTP '+r.status);
    const data=await decryptCatalog(await r.json(),phrase);
    localStorage.setItem(CACHE_KEY,JSON.stringify(data));
    return data;
  }catch(e){networkErr=e}
  const cached=localStorage.getItem(CACHE_KEY);
  if(cached){try{return JSON.parse(cached)}catch(_){} }
  throw networkErr || new Error('No cached catalog is available');
}

function showApp(){unlockPanel.classList.add('hidden');appPanel.classList.remove('hidden');updateStatus();searchInput.focus()}
function updateStatus(){if(!catalog)return;const d=new Date(catalog.library_changed_at);catalogStatus.textContent=`${catalog.count} movies • library changed ${Number.isNaN(d.getTime())?'recently':d.toLocaleString()}`}

async function unlock(phrase,remember){unlockError.textContent='';try{catalog=await fetchAndUnlock(phrase);passphrase=phrase;if(remember)localStorage.setItem(PASS_KEY,phrase);else localStorage.removeItem(PASS_KEY);showApp()}catch(e){unlockError.textContent=e.message||'Could not unlock catalog'}}
unlockForm.addEventListener('submit',e=>{e.preventDefault();unlock(passInput.value,rememberPass.checked)});
refreshBtn.addEventListener('click',async()=>{if(!passphrase)return;refreshBtn.disabled=true;try{catalog=await fetchAndUnlock(passphrase);updateStatus();runSearch(searchInput.value)}catch(e){alert('Refresh failed: '+e.message)}finally{refreshBtn.disabled=false}});
forgetBtn.addEventListener('click',()=>{localStorage.removeItem(PASS_KEY);passphrase='';catalog=null;appPanel.classList.add('hidden');unlockPanel.classList.remove('hidden');passInput.value='';passInput.focus()});

function tokenScore(q,t){const qa=norm(q).split(' ').filter(x=>x.length>1),ta=new Set(norm(t).split(' '));if(!qa.length)return 0;return qa.filter(x=>ta.has(x)).length/qa.length}
function rankMatches(q){const nq=norm(q);if(!nq||!catalog)return[];return catalog.movies.map(m=>{const nt=m.norm||norm(m.title);let score=0;if(nt===nq)score=100;else if(nt.startsWith(nq))score=88;else if(nt.includes(nq))score=82;else if(nq.includes(nt)&&nt.length>3)score=78;else score=Math.round(tokenScore(nq,nt)*70);return {...m,score}}).filter(m=>m.score>=42).sort((a,b)=>b.score-a.score||a.title.localeCompare(b.title)).slice(0,8)}
function renderExact(m){result.innerHTML=`<div class="answer good"><div class="kicker">✓ YOU ALREADY HAVE THIS ONE</div><div class="movie-title">${escapeHtml(m.title)} <span class="movie-year">${m.year?`(${m.year})`:''}</span></div></div>`}
function renderMatches(ms,label='PARTIAL MATCHES'){if(!ms.length){result.innerHTML='<div class="answer bad"><div class="kicker">NO MATCH FOUND</div><div>Nothing in your ripped movie library matches that title.</div></div>';return}result.innerHTML=`<div class="answer warn"><div class="kicker">${escapeHtml(label)}</div><div class="match-list">${ms.map(m=>`<div class="match-row"><strong>${escapeHtml(m.title)}</strong><span class="movie-year">${m.year||''}</span></div>`).join('')}</div></div>`}
function runSearch(q){if(!catalog)return;const nq=norm(q);if(!nq){result.innerHTML='<div class="empty-state">Type a title or scan a disc case.</div>';return}const ms=rankMatches(q);const exact=ms.find(m=>(m.norm||norm(m.title))===nq);if(exact)renderExact(exact);else renderMatches(ms)}
searchInput.addEventListener('input',()=>runSearch(searchInput.value));

function cleanProductTitle(s){return (s||'').replace(/\b(4k|uhd|ultra hd|blu[ -]?ray|dvd|digital|disc|widescreen|fullscreen|special edition|collector'?s edition|steelbook|combo pack)\b/ig,' ').replace(/[\[\]{}]/g,' ').replace(/\s+/g,' ').trim()}
async function resolveBarcode(code){
  cameraStatus.textContent=`Barcode ${code} read. Looking up title…`;
  try{
    const r=await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(code)}`,{headers:{Accept:'application/json'}});
    if(!r.ok) throw new Error('lookup HTTP '+r.status);
    const j=await r.json(), item=j.items&&j.items[0]; if(!item||!item.title) throw new Error('barcode not found');
    const title=cleanProductTitle(item.title); searchInput.value=title; runSearch(title);
    if(!rankMatches(title).length) result.insertAdjacentHTML('beforeend',`<div class="barcode-note">Scanner identified: <strong>${escapeHtml(item.title)}</strong><br>UPC ${escapeHtml(code)}</div>`);
    closeCamera();
  }catch(e){
    closeCamera();
    result.innerHTML=`<div class="answer warn"><div class="kicker">BARCODE READ</div><div>UPC <strong>${escapeHtml(code)}</strong></div><div class="barcode-note">Automatic title lookup was unavailable. You can type the title above, or use the public movie-UPC lookup below.</div><a class="online-link" target="_blank" rel="noopener" href="https://v2.my-upc.com/upc/${encodeURIComponent(code)}">Look up this barcode ↗</a></div>`;
  }
}

async function scanLoop(){if(!detector||!stream)return;try{const codes=await detector.detect(cameraVideo);if(codes&&codes[0]&&codes[0].rawValue){await resolveBarcode(codes[0].rawValue);return}}catch(_){}scanTimer=setTimeout(scanLoop,280)}
async function openCamera(){
  if(!('BarcodeDetector' in window)){result.innerHTML='<div class="answer warn"><div class="kicker">CAMERA SCAN NOT SUPPORTED</div><div>This browser does not expose barcode scanning. Manual title search still works; on Android, current Chrome is recommended.</div></div>';return}
  try{
    detector=new BarcodeDetector({formats:['upc_a','upc_e','ean_13','ean_8']});
    cameraPanel.classList.remove('hidden');cameraStatus.textContent='Starting camera…';
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false});
    cameraVideo.srcObject=stream;await cameraVideo.play();cameraStatus.textContent='Hold the barcode inside the box.';scanLoop();
  }catch(e){cameraStatus.textContent='Camera could not start: '+e.message}
}
function closeCamera(){if(scanTimer){clearTimeout(scanTimer);scanTimer=null}if(stream){for(const t of stream.getTracks())t.stop();stream=null}cameraVideo.srcObject=null;cameraPanel.classList.add('hidden')}
scanBtn.addEventListener('click',openCamera);closeCameraBtn.addEventListener('click',closeCamera);document.addEventListener('visibilitychange',()=>{if(document.hidden)closeCamera()});

(async function init(){
  if('serviceWorker' in navigator){navigator.serviceWorker.register('sw.js').catch(()=>{})}
  const saved=localStorage.getItem(PASS_KEY);
  if(saved){passInput.value=saved;await unlock(saved,true)}else{unlockPanel.classList.remove('hidden');passInput.focus()}
})();
