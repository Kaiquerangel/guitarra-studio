/* ═══════════════════════════════════════════════════
   GUITARRA STUDIO v5
   Novidades: Google Auth, Export, Mobile, Metrônomo, Dark mode
   ═══════════════════════════════════════════════════ */

const DIFF_LABELS=['','Iniciante','Básico','Intermediário','Avançado','Expert'];
const DIFF_CLS   =['','d1','d2','d3','d4','d5'];
const WK_NAMES   =['Semana 1','Semana 2','Semana 3','Semana 4'];
const DAY_NAMES  =['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
const SUGGESTIONS=['','Aumente o andamento em 5 bpm ao completar 3 sessões com clareza.','Pratique sem olhar para as mãos após dominar o padrão.','Combine com o exercício anterior em sequência.','Reduza o tempo olhando para o braço.','Varie a dinâmica (forte/piano) e o timbre.'];

let exercises=[], history=[], goals=[], schedule={}, cycles=[];
let activeCycleId=null;
let nextId=31, editingId=null, editingGoalId=null, editingCycleId=null;
let showCfg=false, paletteOpen=false, userMenuOpen=false, agendaOffset=0;
let _goalTab='active', doneColOpen=true, isDark=false;
let histPage=0; const HIST_PER_PAGE=30;
let currentTab='dash';

const LS={
  get:(k,fb)=>{try{const r=localStorage.getItem(k);return r?JSON.parse(r):fb;}catch{return fb;}},
  set:(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v));}catch{}}
};

// ════════════════════════════════════════
// AUTH & LOGIN
// ════════════════════════════════════════
window.addEventListener('firebase-signout', ()=>{
  document.getElementById('login-screen').classList.remove('hidden');
});

// Disparado pelo AUTH.logout()
window.addEventListener('auth-logout', ()=>{
  document.getElementById('login-screen').classList.remove('hidden');
});

window.addEventListener('auth-error', e=>{
  showToast('Erro no login: '+e.detail,'warn');
});

window.addEventListener('firebase-ready', async e=>{
  const user = e.detail?.user;
  document.getElementById('login-screen').classList.add('hidden');
  updateUserUI(user);
  await loadAndInit();
});

// Correção de race condition: se o Firebase já autenticou antes
// do app.js terminar de carregar, inicia direto.
if(window._uid && window._uid !== 'offline'){
  document.getElementById('login-screen').classList.add('hidden');
  updateUserUI(window._user);
  loadAndInit();
}

function useOffline(){
  document.getElementById('login-screen').classList.add('hidden');
  window._uid='offline'; window._db=null; window._user=null;
  updateUserUI(null);
  loadAndInit();
}

function updateUserUI(user){
  const av=document.getElementById('user-avatar');
  const nm=document.getElementById('um-name');
  const em=document.getElementById('um-email');
  if(user){
    nm.textContent=user.displayName||'Usuário';
    em.textContent=user.email||'';
    if(user.photoURL){
      av.innerHTML=`<img src="${user.photoURL}" style="width:28px;height:28px;border-radius:50%;border:2px solid rgba(255,255,255,.4)">`;
    }else{
      av.textContent=(user.displayName||'U')[0].toUpperCase();
    }
  }else{
    av.textContent='👤';
    nm.textContent='Modo offline';
    em.textContent='Dados salvos localmente';
  }
}

function toggleUserMenu(){
  userMenuOpen=!userMenuOpen;
  document.getElementById('user-menu').classList.toggle('open',userMenuOpen);
}

function confirmLogout(){
  if(!confirm('Sair da conta? Seus dados ficam salvos no Firebase.'))return;
  AUTH.logout();
  closeAllPopups();
}

document.addEventListener('click',e=>{
  if(userMenuOpen&&!e.target.closest('#user-menu')&&!e.target.closest('#user-avatar')){
    userMenuOpen=false;document.getElementById('user-menu').classList.remove('open');
  }
  if(paletteOpen&&!e.target.closest('.palette-popup')&&!e.target.closest('[onclick="togglePalette()"]')){
    paletteOpen=false;document.getElementById('palette-popup').classList.remove('open');
  }
});

function closeAllPopups(){
  userMenuOpen=false; paletteOpen=false;
  document.getElementById('user-menu').classList.remove('open');
  document.getElementById('palette-popup').classList.remove('open');
}

// ════════════════════════════════════════
// INIT / LOAD
// ════════════════════════════════════════
async function loadAndInit(){
  const online=window._db&&window._uid&&window._uid!=='offline';
  setSyncStatus(online?'synced':'offline');
  showLoad('Carregando...');

  if(online){
    const[fbEx,fbSess,fbGoals,fbSched,fbCyc]=await Promise.all([
      FB.loadAll('exercises'),FB.loadOrdered('sessions','_at'),
      FB.loadAll('goals'),FB.loadAll('schedule'),FB.loadAll('cycles')
    ]);
    exercises=fbEx?.length?fbEx.sort((a,b)=>a.id-b.id):LS.get('gs-ex',defaultEx());
    history  =fbSess?.length?fbSess:LS.get('gs-hist',[]);
    goals    =fbGoals?.length?fbGoals:LS.get('gs-goals',[]);
    schedule =(()=>{const o={};(fbSched||[]).forEach(d=>{if(d.day)o[d.day]=d.exIds||[];});return Object.keys(o).length?o:LS.get('gs-sched',{});})();
    cycles   =fbCyc?.length?fbCyc.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')):LS.get('gs-cycles',[]);
  }else{
    exercises=LS.get('gs-ex',defaultEx());
    history  =LS.get('gs-hist',[]);
    goals    =LS.get('gs-goals',[]);
    schedule =LS.get('gs-sched',{});
    cycles   =LS.get('gs-cycles',[]);
  }

  nextId=Math.max(0,...exercises.map(e=>e.id),30)+1;
  activeCycleId=cycles.find(c=>c.status==='active')?.id||null;
  hideLoad();
  restorePrefs();
  checkInactivity();
  renderDash(); render(); updatePomo(); renderPomoDots();
  document.getElementById('tb-date').textContent=new Date().toLocaleDateString('pt-BR',{weekday:'long',day:'numeric',month:'long'});
  if('Notification'in window&&Notification.permission==='default')Notification.requestPermission();
}

function defaultEx(){return[
  {id:1,week:0,name:'Escala pentatônica — posição 1',desc:'Pentatônica menor na 1ª posição, subindo e descendo. 60 bpm.',done:false,focus:true,diff:1,weekSince:dateStr(new Date()),cycleId:null},
  {id:2,week:0,name:'Mudança de acorde Am–Em',desc:'Alterne Am e Em em semínimas a 70 bpm. 4 séries de 2 min.',done:false,focus:false,diff:2,weekSince:dateStr(new Date()),cycleId:null},
  {id:3,week:0,name:'Picking alternado — corda solta',desc:'Palheta alternada em cada corda, 4 tempos por corda. 80 bpm.',done:false,focus:false,diff:2,weekSince:dateStr(new Date()),cycleId:null},
  {id:4,week:0,name:'Arpejo em Am',desc:'Arpejo ascendente e descendente em Am. 4 repetições, 65 bpm.',done:false,focus:false,diff:2,weekSince:dateStr(new Date()),cycleId:null},
  {id:5,week:0,name:'Escala cromática',desc:'Cromática do 1º ao 4º dedo em todas as cordas.',done:false,focus:false,diff:1,weekSince:dateStr(new Date()),cycleId:null},
  {id:6,week:0,name:'Ritmo em colcheias — acorde G',desc:'Strumming down-up em G maior. Metrônomo 80 bpm, 3 min.',done:true,focus:false,diff:2,weekSince:dateStr(new Date()),cycleId:null},
  {id:7,week:1,name:'Escala pentatônica — posição 2',desc:'Segunda caixa da pentatônica. Conecte com a posição 1.',done:false,focus:false,diff:2,weekSince:dateStr(new Date()),cycleId:null},
  {id:8,week:1,name:'Acorde F — barre',desc:'Barre chord na 1ª casa. 10 repetições.',done:false,focus:false,diff:3,weekSince:dateStr(new Date()),cycleId:null},
  {id:9,week:1,name:'Mudança Am–F–G',desc:'Progressão harmônica clássica. 4/4 a 60 bpm.',done:false,focus:false,diff:3,weekSince:dateStr(new Date()),cycleId:null},
];}

// ════════════════════════════════════════
// SYNC
// ════════════════════════════════════════
function saveAll(){LS.set('gs-ex',exercises);LS.set('gs-hist',history);LS.set('gs-goals',goals);LS.set('gs-sched',schedule);LS.set('gs-cycles',cycles);}
async function sync(path,data){saveAll();setSyncStatus('syncing');await FB.save(path,data).catch(()=>{});setSyncStatus('synced');}
async function syncEx(ex){await sync(`exercises/${ex.id}`,ex);}
async function syncSess(s){await sync(`sessions/${s.id||Date.now()}`,s);}
async function syncGoal(g){await sync(`goals/${g.id}`,g);}
async function syncCycle(c){await sync(`cycles/${c.id}`,c);}
async function syncSched(day,ids){LS.set('gs-sched',schedule);setSyncStatus('syncing');await FB.save(`schedule/${day}`,{day,exIds:ids}).catch(()=>{});setSyncStatus('synced');}

// ════════════════════════════════════════
// EXPORT
// ════════════════════════════════════════
function exportData(format='json'){
  if(format==='json'){
    const data={exportedAt:new Date().toISOString(),exercises,history,goals,cycles,schedule};
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    download(blob,`guitarra-studio-backup-${dateStr(new Date())}.json`);
    showToast('Backup JSON exportado!','success');
  }else if(format==='csv'){
    const header='Data,Exercício,Duração (min),BPM,Nota,Ciclo\n';
    const rows=history.map(h=>{
      const cyc=cycles.find(c=>c.id===h.cycleId)?.name||'';
      return[h.date||h.isoDate,`"${h.ex}"`,h.duration,h.bpm||'',`"${(h.note||'').replace(/"/g,'""')}"`,`"${cyc}"`].join(',');
    }).join('\n');
    const blob=new Blob(['\uFEFF'+header+rows],{type:'text/csv;charset=utf-8'});
    download(blob,`guitarra-studio-historico-${dateStr(new Date())}.csv`);
    showToast('Histórico CSV exportado!','success');
  }
  closeAllPopups();
}

function download(blob,filename){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ════════════════════════════════════════
// DARK MODE
// ════════════════════════════════════════
function toggleDark(){
  isDark=!isDark;
  document.body.classList.toggle('dark',isDark);
  LS.set('gs-dark',isDark);
}

// ════════════════════════════════════════
// PALETTE
// ════════════════════════════════════════
function togglePalette(){paletteOpen=!paletteOpen;document.getElementById('palette-popup').classList.toggle('open',paletteOpen);}
function setPalette(t,el){document.body.setAttribute('data-theme',t);document.querySelectorAll('.palette-option').forEach(o=>o.classList.remove('active'));el.classList.add('active');LS.set('gs-theme',t);setTimeout(()=>{paletteOpen=false;document.getElementById('palette-popup').classList.remove('open');},150);}

function restorePrefs(){
  const t=LS.get('gs-theme',null);
  if(t){document.body.setAttribute('data-theme',t);const o=document.querySelector(`.palette-option[data-theme="${t}"]`);if(o){document.querySelectorAll('.palette-option').forEach(x=>x.classList.remove('active'));o.classList.add('active');}}
  isDark=LS.get('gs-dark',false);
  document.body.classList.toggle('dark',isDark);
}

// ════════════════════════════════════════
// UI UTILS
// ════════════════════════════════════════
function showLoad(m){document.getElementById('load-msg').textContent=m;document.getElementById('app-loading').classList.remove('hidden');}
function hideLoad(){document.getElementById('app-loading').classList.add('hidden');}
function setSyncStatus(s){const d=document.getElementById('sync-dot'),l=document.getElementById('sync-label');d.className='sync-dot';if(s==='syncing'){d.classList.add('syncing');l.textContent='Salvando...';}else if(s==='offline'){d.classList.add('offline');l.textContent='Offline';}else{l.textContent='Sincronizado';}}
function showToast(msg,type='info',dur=2800){const c=document.getElementById('toast-container'),t=document.createElement('div');t.className=`toast ${type}`;t.innerHTML=`<span>${type==='success'?'✓':'ℹ'}</span> ${msg}`;c.appendChild(t);setTimeout(()=>{t.classList.add('toast-out');setTimeout(()=>t.remove(),250);},dur);}
function closeModal(id){document.getElementById(id).classList.remove('open');}

// ════════════════════════════════════════
// DATE UTILS
// ════════════════════════════════════════
function dateStr(d){return d.toISOString().slice(0,10);}
function formatPT(s){if(!s)return'';const[y,m,d]=s.split('-');return`${d}/${m}/${y}`;}
function parseDate(s){if(!s)return null;if(s.includes('/')){{const[d,m,y]=s.split('/');return new Date(`${y}-${m}-${d}`);}}return new Date(s);}
function diffDays(a,b){return Math.round((b-a)/86400000);}
function getISOWeek(date){const d=new Date(Date.UTC(date.getFullYear(),date.getMonth(),date.getDate()));d.setUTCDate(d.getUTCDate()+4-(d.getUTCDay()||7));const y=new Date(Date.UTC(d.getUTCFullYear(),0,1));return Math.ceil((((d-y)/86400000)+1)/7);}

// ════════════════════════════════════════
// INATIVIDADE
// ════════════════════════════════════════
function checkInactivity(){if(!history.length)return;const last=history.reduce((a,h)=>{const d=parseDate(h.isoDate||h.date);return(!a||d>a)?d:a;},null);if(!last)return;const days=diffDays(last,new Date());if(days>=2){document.getElementById('inactivity-msg').textContent=`Você não pratica há ${days} dia${days>1?'s':''}`;document.getElementById('inactivity-banner').classList.add('show');}}
function dismissInactivity(){document.getElementById('inactivity-banner').classList.remove('show');}

// ════════════════════════════════════════
// ÁUDIO
// ════════════════════════════════════════
let actx=null;
function getACtx(){if(!actx)actx=new(window.AudioContext||window.webkitAudioContext)();return actx;}
function playTone(f,d,v,t='sine'){try{const a=getACtx(),o=a.createOscillator(),g=a.createGain();o.connect(g);g.connect(a.destination);o.type=t;o.frequency.value=f;g.gain.setValueAtTime(v,a.currentTime);g.gain.exponentialRampToValueAtTime(0.001,a.currentTime+d);o.start();o.stop(a.currentTime+d);}catch{}}
function playWorkEnd(){if(!document.getElementById('snd').checked)return;playTone(880,.6,.35);setTimeout(()=>playTone(1100,.5,.3),300);setTimeout(()=>playTone(1320,.8,.35),600);}
function playBreakEnd(){if(!document.getElementById('snd').checked)return;playTone(660,.6,.35);setTimeout(()=>playTone(550,.8,.3),350);}
function playTick(){playTone(1200,.05,.05,'square');}

// ════════════════════════════════════════
// METRÔNOMO
// ════════════════════════════════════════
let metroRunning=false, metroBpm=80, metroBeats=4, metroCurrent=0, metroInterval=null;
let tapTimes=[];

function renderMetro(exBpm){
  const bpm=exBpm||metroBpm;
  return`<div class="metro-panel">
    <div class="metro-title">🥁 Metrônomo <button class="btn xs ghost" onclick="this.closest('.metro-panel').remove()">✕</button></div>
    <div class="metro-display">
      <div style="display:flex;flex-direction:column;align-items:center">
        <div class="metro-bpm-num" id="metro-num">${bpm}</div>
        <div style="font-size:11px;color:var(--muted)">BPM</div>
      </div>
      <div class="metro-bpm-controls">
        <button class="metro-bpm-btn" onclick="changeBpm(+5)">▲</button>
        <button class="metro-bpm-btn" onclick="changeBpm(-5)">▼</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;flex:1">
        <input type="range" class="metro-slider" min="30" max="240" value="${bpm}" id="metro-slider" oninput="setBpm(parseInt(this.value))">
        <div class="metro-sig"><span>Compasso:</span>
          <select class="metro-sig" onchange="metroBeats=parseInt(this.value);renderMetroBeats()" style="padding:2px 6px;border:1px solid var(--border);border-radius:var(--radius);font-size:12px;background:var(--bg-card);color:var(--text);">
            <option value="2">2/4</option><option value="3">3/4</option><option value="4" selected>4/4</option><option value="6">6/8</option>
          </select>
        </div>
      </div>
    </div>
    <div class="metro-beats" id="metro-beats">${Array.from({length:metroBeats},(_,i)=>`<div class="metro-beat${i===0?' accent':''}" id="mb-${i}"></div>`).join('')}</div>
    <div class="metro-controls">
      <button class="btn pri sm" id="metro-play-btn" onclick="toggleMetro()">${metroRunning?'⏹ Parar':'▶ Iniciar'}</button>
      <button class="btn sm metro-tap" onclick="tapTempo()">Tap</button>
    </div>
  </div>`;
}

function renderMetroBeats(){
  const el=document.getElementById('metro-beats');
  if(!el)return;
  el.innerHTML=Array.from({length:metroBeats},(_,i)=>`<div class="metro-beat${i===0?' accent':''}" id="mb-${i}"></div>`).join('');
}

function setBpm(v){
  metroBpm=Math.max(30,Math.min(240,v));
  const n=document.getElementById('metro-num');
  const s=document.getElementById('metro-slider');
  if(n)n.textContent=metroBpm;
  if(s)s.value=metroBpm;
  if(metroRunning){stopMetro();startMetro();}
}
function changeBpm(d){setBpm(metroBpm+d);}

function toggleMetro(){metroRunning?stopMetro():startMetro();}

function startMetro(){
  metroRunning=true;metroCurrent=0;
  const btn=document.getElementById('metro-play-btn');
  if(btn)btn.textContent='⏹ Parar';
  const interval=60000/metroBpm;
  tick();
  metroInterval=setInterval(tick,interval);
}

function tick(){
  document.querySelectorAll('.metro-beat').forEach(b=>b.classList.remove('on'));
  const cur=document.getElementById(`mb-${metroCurrent}`);
  if(cur)cur.classList.add('on');
  if(metroCurrent===0) playTone(1200,.08,.3,'square');
  else playTone(900,.05,.15,'square');
  metroCurrent=(metroCurrent+1)%metroBeats;
}

function stopMetro(){
  metroRunning=false;clearInterval(metroInterval);metroInterval=null;
  document.querySelectorAll('.metro-beat').forEach(b=>b.classList.remove('on'));
  const btn=document.getElementById('metro-play-btn');
  if(btn)btn.textContent='▶ Iniciar';
}

function tapTempo(){
  const now=Date.now();
  tapTimes.push(now);
  if(tapTimes.length>8)tapTimes.shift();
  if(tapTimes.length>1){
    const gaps=tapTimes.slice(1).map((t,i)=>t-tapTimes[i]);
    const avg=gaps.reduce((a,b)=>a+b)/gaps.length;
    setBpm(Math.round(60000/avg));
  }
  clearTimeout(tapTimes._t);
  tapTimes._t=setTimeout(()=>{tapTimes=[];},2000);
}

// ════════════════════════════════════════
// POMODORO
// ════════════════════════════════════════
let tInt=null,tRun=false,totSec=25*60,remSec=25*60,phase='work',pomoDone=0;
function toggleCfg(){showCfg=!showCfg;document.getElementById('cfg-panel').classList.toggle('open',showCfg);document.getElementById('cfg-btn').classList.toggle('active',showCfg);}
function applyConfig(){if(!tRun){totSec=parseInt(document.getElementById('cfg-work').value)*60;remSec=totSec;phase='work';pomoDone=0;updatePomo();renderPomoDots();}}
function getFmt(s){return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');}
function renderPomoDots(){const cyc=parseInt(document.getElementById('cfg-cyc').value)||4;document.getElementById('p-dots').innerHTML=Array.from({length:cyc},(_,i)=>`<div class="pdot${i<pomoDone?' dn':i===pomoDone?' cur':''}"></div>`).join('');}
function updatePomo(){document.getElementById('p-time').textContent=getFmt(remSec);const c=2*Math.PI*19,o=c*(remSec/totSec);document.getElementById('p-arc').style.stroke=phase==='work'?'var(--acc)':'var(--acc-mid)';document.getElementById('p-arc').setAttribute('stroke-dashoffset',o);document.getElementById('p-phase').textContent={work:'Foco',short:'Intervalo',long:'Descanso longo'}[phase];}
function togglePomo(){
  if(tRun){clearInterval(tInt);tRun=false;document.getElementById('p-btn').innerHTML='Iniciar <span class="kbd tab-desktop-only">Space</span>';}
  else{tRun=true;document.getElementById('p-btn').innerHTML='Pausar <span class="kbd tab-desktop-only">Space</span>';
    tInt=setInterval(()=>{remSec--;
      if(document.getElementById('snd-tick').checked&&remSec<=5&&remSec>0)playTick();
      if(remSec<=0){clearInterval(tInt);tRun=false;const cyc=parseInt(document.getElementById('cfg-cyc').value)||4;
        if(phase==='work'){playWorkEnd();pomoDone++;renderPomoDots();phase=pomoDone>=cyc?'long':'short';totSec=parseInt(document.getElementById(phase==='long'?'cfg-long':'cfg-short').value)*60;showToast('Sessão concluída! 🎸','success');}
        else{playBreakEnd();if(phase==='long')pomoDone=0;phase='work';totSec=parseInt(document.getElementById('cfg-work').value)*60;renderPomoDots();showToast('Hora de focar! 💪','info');}
        remSec=totSec;updatePomo();document.getElementById('p-btn').innerHTML='Iniciar <span class="kbd tab-desktop-only">Space</span>';
        if('Notification'in window&&Notification.permission==='granted')new Notification('Guitarra Studio',{body:phase==='work'?'Focar!':'Descansar!'});
        return;}updatePomo();},1000);}
}
function resetPomo(){clearInterval(tInt);tRun=false;phase='work';pomoDone=0;totSec=parseInt(document.getElementById('cfg-work').value)*60;remSec=totSec;updatePomo();renderPomoDots();document.getElementById('p-btn').innerHTML='Iniciar <span class="kbd tab-desktop-only">Space</span>';}

// ════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ════════════════════════════════════════
document.addEventListener('keydown', e=>{
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.tagName==='SELECT')return;
  if(e.key===' '){e.preventDefault();togglePomo();}
  if(e.key==='s'||e.key==='S'){const ex=getFocusEx();if(ex)saveSession(ex.id);}
  if(e.key==='d'||e.key==='D')toggleDark();
  if(e.key==='Escape'){document.querySelectorAll('.modal-overlay.open').forEach(m=>m.classList.remove('open'));closeAllPopups();}
  if(e.key==='1')switchTab('dash',null,'dash');
  if(e.key==='2')switchTab('board',null,'board');
  if(e.key==='3')switchTab('cycles',null,'cycles');
  if(e.key==='4')switchTab('hist',null,'hist');
});

// ════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════
function diffPill(d){return`<span class="diff-pill ${DIFF_CLS[d]}">${DIFF_LABELS[d]}</span>`;}
function weekPill(w){return`<span class="week-pill">${WK_NAMES[w]}</span>`;}
function getFocusEx(){return exercises.find(e=>e.focus&&!e.done)||null;}
function getActiveCycle(){return cycles.find(c=>c.id===activeCycleId)||null;}
function deadlineBadge(ex){const g=goals.find(g=>g.exId===ex.id&&!g.done);if(!g||!g.deadline)return'';const d=diffDays(new Date(),new Date(g.deadline));if(d<0)return`<span class="deadline-badge deadline-late">Atrasado ${Math.abs(d)}d</span>`;if(d<=7)return`<span class="deadline-badge deadline-warn">${d}d</span>`;return`<span class="deadline-badge deadline-ok">${d}d</span>`;}

// ════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════
function renderDash(){
  renderDashCycleBanner();renderDashStats();renderDashUrgent();renderDashFocus();renderDashNext();
}

function renderDashCycleBanner(){
  const c=getActiveCycle();
  const el=document.getElementById('dash-cycle-banner');
  if(!c){el.innerHTML=`<div class="cycle-banner" style="border-style:dashed;opacity:.7"><div class="cycle-icon">📚</div><div class="cycle-info"><div class="cycle-name" style="font-size:14px;color:var(--muted)">Nenhum ciclo ativo</div><div class="cycle-meta">Crie um ciclo para organizar seus estudos</div></div><div><button class="btn pri sm" onclick="switchTab('cycles',null,'cycles')">Criar ciclo</button></div></div>`;return;}
  const exs=exercises.filter(e=>e.cycleId===c.id);
  const done=exs.filter(e=>e.done).length;
  const pct=exs.length?Math.round((done/exs.length)*100):0;
  const daysIn=c.startDate?diffDays(new Date(c.startDate),new Date()):0;
  const daysLeft=c.endDate?diffDays(new Date(),new Date(c.endDate)):null;
  el.innerHTML=`<div class="cycle-banner"><div class="cycle-icon">${c.icon||'🎸'}</div><div class="cycle-info"><div class="cycle-name">${c.name}</div><div class="cycle-meta">Dia ${daysIn+1}${daysLeft!==null?` · ${daysLeft>0?daysLeft+'d restantes':'Prazo hoje'}`:''} · ${done}/${exs.length} exercícios</div><div class="cycle-progress-bar"><div class="cycle-progress-fill" style="width:${pct}%"></div></div></div><div style="display:flex;gap:6px;flex-shrink:0"><button class="btn sm" onclick="switchTab('board',null,'board')">Quadro</button><button class="btn sm" onclick="switchTab('cycles',null,'cycles')">Ciclos</button></div></div>`;
}

function renderDashStats(){
  const streak=calcStreak();
  const todaySess=history.filter(h=>h.isoDate===dateStr(new Date())).length;
  const weekSess=history.filter(h=>h.week===getISOWeek(new Date())).length;
  document.getElementById('dash-stats').innerHTML=`
    <div class="dash-stat"><div class="dash-stat-num">${streak.current}</div><div class="dash-stat-lbl">Streak</div></div>
    <div class="dash-stat"><div class="dash-stat-num">${todaySess}</div><div class="dash-stat-lbl">Hoje</div></div>
    <div class="dash-stat"><div class="dash-stat-num">${weekSess}</div><div class="dash-stat-lbl">Semana</div></div>
    <div class="dash-stat"><div class="dash-stat-num">${history.length}</div><div class="dash-stat-lbl">Total</div></div>`;
}

function renderDashUrgent(){
  const el=document.getElementById('dash-urgent');
  const urgent=goals.filter(g=>!g.done&&diffDays(new Date(),new Date(g.deadline))<=3);
  if(!urgent.length){el.innerHTML='';return;}
  el.innerHTML=`<div class="dash-urgent"><div class="dash-urgent-title">⚠️ Metas urgentes</div>${urgent.map(g=>{const ex=exercises.find(e=>e.id===g.exId);const d=diffDays(new Date(),new Date(g.deadline));return`<div class="urgent-item"><span class="urgent-item-name">${g.desc||ex?.name||'Meta'}</span><span class="deadline-badge ${d<0?'deadline-late':'deadline-warn'}">${d<0?`${Math.abs(d)}d atrasada`:d===0?'Hoje':`${d}d`}</span></div>`;}).join('')}</div>`;
}

function renderDashFocus(){
  const ex=getFocusEx(),el=document.getElementById('dash-focus-area');
  if(!ex){el.innerHTML=`<div class="dash-no-focus">🎸 Nenhum exercício em foco.<br><span style="font-size:12px">Vá ao <strong>Quadro</strong> e clique em um exercício para começar.</span></div>`;return;}
  const lastBpm=history.filter(h=>h.exId===ex.id&&h.bpm).slice(-1)[0]?.bpm||'';
  el.innerHTML=`<div class="dash-focus-card">
    <div class="dash-focus-label">🎯 Em foco agora</div>
    <div class="dash-focus-name">${ex.name}</div>
    <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px">${diffPill(ex.diff)} ${weekPill(ex.week)} ${deadlineBadge(ex)}</div>
    <div class="dash-focus-desc">${ex.desc}</div>
    <div class="dash-focus-suggest">${SUGGESTIONS[ex.diff]}</div>
    <label class="note-label">Anotação da sessão</label>
    <textarea class="note-area" id="focus-note" placeholder="Como foi? O que melhorou?"></textarea>
    <div class="bpm-row"><label>BPM atingido</label><input type="number" class="bpm-input" id="focus-bpm" placeholder="${lastBpm||'Ex: 80'}" min="20" max="300" value="${lastBpm}">${lastBpm?`<span style="font-size:10px;color:var(--muted)">último: ${lastBpm}</span>`:''}</div>
    <div class="focus-actions">
      <button class="btn pri" onclick="saveSession(${ex.id})">Salvar sessão <span class="kbd">S</span></button>
      <button class="btn" onclick="markDone(${ex.id})">Concluir</button>
      <button class="btn ghost sm" onclick="openEditModal(${ex.id})">Editar</button>
      <button class="btn sm" onclick="showMetronome(${lastBpm||80})">🥁 Metrônomo</button>
    </div>
    <div id="metro-container"></div>
  </div>`;
}

function showMetronome(bpm){
  metroBpm=bpm||80;
  const c=document.getElementById('metro-container');
  if(!c)return;
  if(c.children.length){stopMetro();c.innerHTML='';return;}
  c.innerHTML=renderMetro(bpm);
}

function renderDashNext(){
  const el=document.getElementById('dash-next-area');
  const focEx=getFocusEx();
  const next=exercises.filter(e=>!e.done&&(!focEx||e.id!==focEx.id)).slice(0,3);
  if(!next.length){el.innerHTML='';return;}
  el.innerHTML=`<div class="dash-next"><div class="dash-next-title">Próximos exercícios<button class="btn xs ghost" onclick="switchTab('board',null,'board')">Ver todos →</button></div>${next.map(e=>`<div class="next-item" onclick="setFocus(${e.id})"><span class="next-item-name">${e.name}</span><span class="next-item-meta">${diffPill(e.diff)} ${weekPill(e.week)}${deadlineBadge(e)}</span></div>`).join('')}</div>`;
}

// ════════════════════════════════════════
// BOARD
// ════════════════════════════════════════
function render(){renderPending();renderDone();renderPomoDots();renderBoardCycleTag();}
function renderBoardCycleTag(){const c=getActiveCycle();document.getElementById('board-cycle-tag').textContent=c?`${c.icon||'🎸'} ${c.name}`:'Sem ciclo ativo';}

function renderPending(){
  const weeks=[...new Set(exercises.filter(e=>!e.done).map(e=>e.week))].sort();
  const focEx=getFocusEx();
  document.getElementById('pending-area').innerHTML=weeks.map(w=>{
    const wEx=exercises.filter(e=>e.week===w&&!e.done),atMax=wEx.length>=6;
    return`<div class="week-col"><div class="wcol-head"><span class="wcol-title">${WK_NAMES[w]}</span><span class="wcol-count${atMax?' warn':''}">${wEx.length}/6</span></div>
      ${wEx.map(e=>{
        const isFocus=focEx&&focEx.id===e.id;
        const sd=e.desc.length>68?e.desc.slice(0,68)+'…':e.desc;
        const dh=e.weekSince?diffDays(new Date(e.weekSince),new Date()):null;
        const db=dh!==null?`<span class="days-badge${dh>=7?' warn':''}">${dh}d</span>`:'';
        const adv=e.week<3?`<button class="btn xs advance-btn" onclick="event.stopPropagation();advanceWeek(${e.id})">→ Sem ${e.week+2}</button>`:`<span class="last-week-tag">✓ Final</span>`;
        return`<div class="ex-card${isFocus?' in-focus':''}" onclick="setFocus(${e.id})">
          <div class="ex-card-name">${e.name}</div><div class="ex-card-desc">${sd}</div>
          <div class="card-pills">${diffPill(e.diff)}${isFocus?'<span class="focus-badge">foco</span>':''}${deadlineBadge(e)}${db}<div class="card-check${e.done?' dn':''}" onclick="event.stopPropagation();markDone(${e.id})"></div></div>
          <div class="card-advance-row">${adv}</div>
        </div>`;
      }).join('')}
      <div id="addform-w${w}" style="display:none"></div>
      <button class="add-btn" onclick="openAdd(${w})">+ Adicionar</button>
    </div>`;
  }).join('');
}

function renderDone(){
  const done=exercises.filter(e=>e.done);
  document.getElementById('cnt-done').textContent=done.length;
  document.getElementById('done-col-body').innerHTML=done.length?done.map(e=>`<div class="done-card"><div class="done-card-name">${e.name}</div><div class="card-pills" style="margin-top:3px">${diffPill(e.diff)} ${weekPill(e.week)}</div></div>`).join(''):'<div style="font-size:12px;color:var(--muted);padding:4px 0">Nenhum ainda</div>';
}

function toggleDoneCol(){doneColOpen=!doneColOpen;document.getElementById('done-col-body').classList.toggle('collapsed',!doneColOpen);}

// ════════════════════════════════════════
// FOCO / AÇÕES
// ════════════════════════════════════════
function setFocus(id){exercises.forEach(e=>e.focus=false);const ex=exercises.find(e=>e.id===id);if(ex){ex.focus=true;if(!tRun)document.getElementById('p-ex').textContent=ex.name;}syncEx(ex);render();renderDash();}

function markDone(id){const ex=exercises.find(e=>e.id===id);if(!ex)return;ex.done=true;ex.focus=false;const next=exercises.find(e=>!e.done&&e.week===ex.week)||exercises.find(e=>!e.done);if(next){next.focus=true;if(!tRun)document.getElementById('p-ex').textContent=next.name;syncEx(next);}syncEx(ex);render();renderDash();}

async function advanceWeek(id){const ex=exercises.find(e=>e.id===id);if(!ex||ex.week>=3)return;ex.week++;ex.weekSince=dateStr(new Date());await syncEx(ex);showToast(`"${ex.name}" → ${WK_NAMES[ex.week]} 🚀`,'success');render();renderDash();}

async function saveSession(id){
  const ex=exercises.find(e=>e.id===id);if(!ex)return;
  const note=document.getElementById('focus-note')?.value||'';
  const bpm=parseInt(document.getElementById('focus-bpm')?.value)||null;
  const dur=parseInt(document.getElementById('cfg-work').value)||25;
  const now=new Date();
  const sess={id:String(Date.now()),exId:ex.id,ex:ex.name,diff:ex.diff,cycleId:ex.cycleId||activeCycleId||null,isoDate:dateStr(now),date:now.toLocaleDateString('pt-BR'),time:now.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}),week:getISOWeek(now),duration:dur,note:note||'—',bpm};
  history.unshift(sess);
  await syncSess(sess);
  showToast(`"${ex.name}" salva! ✓`,'success');
  markDone(id);
}

// ════════════════════════════════════════
// ADD / EDIT / DELETE EXERCÍCIO
// ════════════════════════════════════════
function openAdd(w){
  document.querySelectorAll('[id^="addform-w"]').forEach(d=>{if(d.id!==`addform-w${w}`){d.style.display='none';d.innerHTML='';}});
  const div=document.getElementById('addform-w'+w);if(!div)return;
  if(div.style.display==='block'){div.style.display='none';div.innerHTML='';return;}
  div.style.display='block';
  div.innerHTML=`<div class="add-form"><input type="text" id="nf-name-${w}" placeholder="Nome do exercício"><textarea id="nf-desc-${w}" placeholder="Descrição, técnica, andamento..."></textarea><div class="add-form-row"><select id="nf-diff-${w}" style="flex:1">${[1,2,3,4,5].map(d=>`<option value="${d}">${d} — ${DIFF_LABELS[d]}</option>`).join('')}</select></div><div class="add-form-row"><button class="btn pri" style="flex:1" onclick="addEx(${w})">Adicionar</button><button class="btn ghost" onclick="document.getElementById('addform-w${w}').style.display='none';document.getElementById('addform-w${w}').innerHTML=''">✕</button></div></div>`;
  setTimeout(()=>document.getElementById(`nf-name-${w}`)?.focus(),50);
}
async function addEx(w){const name=document.getElementById(`nf-name-${w}`).value.trim();if(!name){showToast('Informe o nome.','info');return;}const desc=document.getElementById(`nf-desc-${w}`).value.trim();const diff=parseInt(document.getElementById(`nf-diff-${w}`).value);const count=exercises.filter(e=>e.week===w&&!e.done).length;if(count>=6&&!confirm(`A ${WK_NAMES[w]} já tem ${count} exercícios. Adicionar mesmo assim?`))return;const ex={id:nextId++,week:w,name,desc:desc||'Sem descrição.',done:false,focus:false,diff,weekSince:dateStr(new Date()),cycleId:activeCycleId||null};exercises.push(ex);await syncEx(ex);showToast(`"${name}" adicionado!`,'success');render();renderDash();}
function openEditModal(id){editingId=id;const ex=exercises.find(e=>e.id===id);if(!ex)return;document.getElementById('edit-name').value=ex.name;document.getElementById('edit-desc').value=ex.desc;document.getElementById('edit-week').value=ex.week;document.getElementById('edit-diff').value=ex.diff;document.getElementById('edit-modal').classList.add('open');}
async function saveEdit(){const ex=exercises.find(e=>e.id===editingId);if(!ex)return;ex.name=document.getElementById('edit-name').value.trim()||ex.name;ex.desc=document.getElementById('edit-desc').value.trim()||ex.desc;ex.week=parseInt(document.getElementById('edit-week').value);ex.diff=parseInt(document.getElementById('edit-diff').value);await syncEx(ex);closeModal('edit-modal');showToast('Atualizado.','info');render();renderDash();}
async function deleteEx(){if(!confirm('Excluir permanentemente?'))return;exercises=exercises.filter(e=>e.id!==editingId);await FB.del(`exercises/${editingId}`).catch(()=>{});saveAll();closeModal('edit-modal');showToast('Excluído.','info');render();renderDash();}

// ════════════════════════════════════════
// CICLOS
// ════════════════════════════════════════
function openCycleModal(id=null){editingCycleId=id;const c=id?cycles.find(c=>c.id===id):null;document.getElementById('cycle-modal-title').textContent=id?'Editar ciclo':'Novo ciclo';document.getElementById('cycle-name').value=c?.name||'';document.getElementById('cycle-desc').value=c?.desc||'';document.getElementById('cycle-start').value=c?.startDate||dateStr(new Date());document.getElementById('cycle-end').value=c?.endDate||'';document.getElementById('cycle-icon').value=c?.icon||'🎸';document.getElementById('cycle-modal').classList.add('open');}
async function saveCycle(){const name=document.getElementById('cycle-name').value.trim();if(!name){showToast('Informe o nome.','info');return;}const cycle={id:editingCycleId||`cy-${Date.now()}`,name,desc:document.getElementById('cycle-desc').value.trim(),startDate:document.getElementById('cycle-start').value,endDate:document.getElementById('cycle-end').value||null,icon:document.getElementById('cycle-icon').value,status:editingCycleId?cycles.find(c=>c.id===editingCycleId)?.status:'active',createdAt:editingCycleId?cycles.find(c=>c.id===editingCycleId)?.createdAt:dateStr(new Date())};const idx=cycles.findIndex(c=>c.id===cycle.id);if(idx>-1)cycles[idx]=cycle;else{cycles.forEach(c=>{if(c.status==='active'){c.status='paused';syncCycle(c);}});cycles.unshift(cycle);activeCycleId=cycle.id;}await syncCycle(cycle);closeModal('cycle-modal');showToast(`Ciclo "${name}" ${editingCycleId?'atualizado':'criado'}!`,'success');renderCycles();renderDash();renderBoardCycleTag();}
async function activateCycle(id){cycles.forEach(c=>{if(c.status==='active'){c.status='paused';syncCycle(c);}});const c=cycles.find(c=>c.id===id);if(!c)return;c.status='active';activeCycleId=id;await syncCycle(c);showToast(`Ciclo "${c.name}" ativado!`,'success');renderCycles();renderDash();renderBoardCycleTag();}
async function closeCycle(id){if(!confirm('Encerrar este ciclo?'))return;const c=cycles.find(c=>c.id===id);if(!c)return;c.status='archived';c.endedAt=dateStr(new Date());if(activeCycleId===id)activeCycleId=null;await syncCycle(c);showToast(`Ciclo encerrado e arquivado.`,'info');renderCycles();renderDash();renderBoardCycleTag();}
async function deleteCycle(id){if(!confirm('Excluir ciclo?'))return;cycles=cycles.filter(c=>c.id!==id);if(activeCycleId===id)activeCycleId=null;await FB.del(`cycles/${id}`).catch(()=>{});saveAll();showToast('Ciclo excluído.','info');renderCycles();renderDash();}

function renderCycles(){
  const el=document.getElementById('cycles-list');
  if(!cycles.length){el.innerHTML=`<div class="cycle-empty">📚 Nenhum ciclo ainda.<br><br>Um ciclo é uma fase do seu estudo — "Fundamentos", "Blues", "Técnica Fingerpicking".<br>Ao encerrar, tudo fica arquivado e você começa limpo.</div>`;return;}
  const ord=['active','paused','archived'];
  el.innerHTML=[...cycles].sort((a,b)=>ord.indexOf(a.status)-ord.indexOf(b.status)).map(c=>{
    const exs=exercises.filter(e=>e.cycleId===c.id);
    const done=exs.filter(e=>e.done).length;
    const pct=exs.length?Math.round((done/exs.length)*100):0;
    const sessCount=history.filter(h=>h.cycleId===c.id).length;
    const daysIn=c.startDate?diffDays(new Date(c.startDate),new Date()):0;
    const daysLeft=c.endDate&&c.status!=='archived'?diffDays(new Date(),new Date(c.endDate)):null;
    const statusLabel={active:'Ativo',paused:'Pausado',archived:'Arquivado'}[c.status];
    return`<div class="cycle-card${c.status==='active'?' active-cycle':''}">
      <div class="cycle-card-header"><div class="cycle-card-icon">${c.icon||'🎸'}</div>
        <div class="cycle-card-info"><div class="cycle-card-name">${c.name}</div><div class="cycle-card-dates">${formatPT(c.startDate)}${c.endDate?' → '+formatPT(c.endDate):''}${c.endedAt?' · encerrado '+formatPT(c.endedAt):''}</div>${c.desc?`<div class="cycle-card-desc">${c.desc}</div>`:''}</div>
        <div style="display:flex;gap:5px;flex-shrink:0">${c.status!=='archived'?`<button class="btn xs" onclick="openCycleModal('${c.id}')">Editar</button>`:''}<button class="btn xs danger" onclick="deleteCycle('${c.id}')">✕</button></div>
      </div>
      <div class="cycle-card-badges"><span class="cycle-badge ${c.status==='active'?'active':''}">${statusLabel}</span><span class="cycle-badge">${exs.length} exercícios</span><span class="cycle-badge">${sessCount} sessões</span>${daysLeft!==null?`<span class="cycle-badge">${daysLeft>=0?daysLeft+'d restantes':'Prazo vencido'}</span>`:''}${c.status==='active'?`<span class="cycle-badge">Dia ${daysIn+1}</span>`:''}</div>
      ${exs.length?`<div class="cycle-progress-label"><span>${done}/${exs.length} concluídos</span><span>${pct}%</span></div><div class="cycle-progress-bar"><div class="cycle-progress-fill" style="width:${pct}%"></div></div>`:''} 
      ${exs.length?`<div class="cycle-ex-preview">${exs.slice(0,5).map(e=>`<span class="cycle-ex-chip${e.done?' done-chip':''}">${e.name.length>18?e.name.slice(0,18)+'…':e.name}</span>`).join('')}${exs.length>5?`<span class="cycle-ex-chip">+${exs.length-5}</span>`:''}</div>`:'<div style="font-size:12px;color:var(--muted);margin-bottom:8px">Novos exercícios adicionados ao Quadro entram neste ciclo automaticamente.</div>'}
      <div class="cycle-card-actions">${c.status==='active'?`<button class="btn sm danger" onclick="closeCycle('${c.id}')">🏁 Encerrar</button>`:''}${c.status==='paused'?`<button class="btn sm pri" onclick="activateCycle('${c.id}')">▶ Ativar</button>`:''}${c.status==='archived'?`<button class="btn sm" onclick="activateCycle('${c.id}')">♻ Reativar</button>`:''}</div>
    </div>`;
  }).join('');
}

// ════════════════════════════════════════
// AGENDA
// ════════════════════════════════════════
function getWeekStart(off=0){const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()-d.getDay()+off*7);return d;}
function renderAgenda(){
  const start=getWeekStart(agendaOffset),end=new Date(start);end.setDate(end.getDate()+6);
  document.getElementById('agenda-week-label').textContent=`${start.toLocaleDateString('pt-BR',{day:'2-digit',month:'short'})} — ${end.toLocaleDateString('pt-BR',{day:'2-digit',month:'short'})}`;
  const today=dateStr(new Date()),pending=exercises.filter(e=>!e.done);
  document.getElementById('agenda-grid').innerHTML=Array.from({length:7},(_,i)=>{const d=new Date(start);d.setDate(d.getDate()+i);return d;}).map(d=>{
    const ds=dateStr(d),isToday=ds===today,exIds=schedule[ds]||[];
    const dayExs=exIds.map(id=>exercises.find(e=>e.id===id)).filter(Boolean);
    return`<div class="agenda-day${isToday?' today':''}" id="aday-${ds}" ondragover="event.preventDefault();document.getElementById('aday-${ds}').classList.add('drag-over')" ondragleave="document.getElementById('aday-${ds}').classList.remove('drag-over')" ondrop="dropOnDay('${ds}',event)"><div class="agenda-day-header"><span class="agenda-day-name">${DAY_NAMES[d.getDay()]}</span><span class="agenda-day-num">${d.getDate()}</span></div>${dayExs.map(ex=>`<div class="agenda-ex-chip" draggable="true" ondragstart="dragAgendaEx(${ex.id},'${ds}',event)"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:90px">${ex.name}</span><span class="rm" onclick="removeFromDay('${ds}',${ex.id})">✕</span></div>`).join('')}<div class="agenda-add-ex" onclick="showAgendaAdd('${ds}')">+</div><div id="agselect-${ds}" style="display:none"><select class="agenda-ex-select" onchange="addToDay('${ds}',this)"><option value="">…</option>${pending.filter(e=>!exIds.includes(e.id)).map(e=>`<option value="${e.id}">${e.name.slice(0,22)}</option>`).join('')}</select></div></div>`;
  }).join('');
}
function agendaWeek(d){agendaOffset+=d;renderAgenda();}
function showAgendaAdd(ds){const s=document.getElementById(`agselect-${ds}`);s.style.display=s.style.display==='none'?'block':'none';}
let _dragId=null,_dragDay=null;
function dragAgendaEx(id,day){_dragId=id;_dragDay=day;}
async function dropOnDay(ds,ev){document.getElementById(`aday-${ds}`)?.classList.remove('drag-over');if(!_dragId)return;if(_dragDay&&_dragDay!==ds){schedule[_dragDay]=(schedule[_dragDay]||[]).filter(i=>i!==_dragId);await syncSched(_dragDay,schedule[_dragDay]);}schedule[ds]=[...new Set([...(schedule[ds]||[]),_dragId])];await syncSched(ds,schedule[ds]);_dragId=null;_dragDay=null;renderAgenda();}
async function addToDay(ds,sel){const id=parseInt(sel.value);if(!id)return;schedule[ds]=[...new Set([...(schedule[ds]||[]),id])];await syncSched(ds,schedule[ds]);renderAgenda();}
async function removeFromDay(ds,id){schedule[ds]=(schedule[ds]||[]).filter(i=>i!==id);await syncSched(ds,schedule[ds]);renderAgenda();}

// ════════════════════════════════════════
// METAS
// ════════════════════════════════════════
function setGoalTab(t,btn){_goalTab=t;document.querySelectorAll('.goal-tab').forEach(b=>b.classList.remove('on'));btn.classList.add('on');renderGoals();}
function openGoalModal(id=null){editingGoalId=id;const g=id?goals.find(g=>g.id===id):null;document.getElementById('goal-modal-title').textContent=id?'Editar meta':'Nova meta';const sel=document.getElementById('goal-ex-sel');sel.innerHTML=`<option value="">Selecione...</option>`+exercises.map(e=>`<option value="${e.id}">${e.name}</option>`).join('');document.getElementById('goal-ex-sel').value=g?.exId||'';document.getElementById('goal-desc').value=g?.desc||'';document.getElementById('goal-date').value=g?.deadline||'';document.getElementById('goal-bpm').value=g?.bpmTarget||'';document.getElementById('goal-modal').classList.add('open');}
async function saveGoal(){const exId=parseInt(document.getElementById('goal-ex-sel').value),deadline=document.getElementById('goal-date').value;if(!exId||!deadline){showToast('Selecione exercício e data.','info');return;}const goal={id:editingGoalId||Date.now(),exId,desc:document.getElementById('goal-desc').value.trim(),deadline,bpmTarget:parseInt(document.getElementById('goal-bpm').value)||null,done:false,createdAt:dateStr(new Date())};const idx=goals.findIndex(g=>g.id===goal.id);if(idx>-1)goals[idx]=goal;else goals.push(goal);await syncGoal(goal);closeModal('goal-modal');showToast('Meta salva!','success');renderGoals();renderDash();}
async function completeGoal(id){const g=goals.find(g=>g.id===id);if(!g)return;g.done=true;await syncGoal(g);showToast('Meta concluída! 🎉','success');renderGoals();renderDash();}
async function deleteGoal(id){if(!confirm('Excluir meta?'))return;goals=goals.filter(g=>g.id!==id);await FB.del(`goals/${id}`).catch(()=>{});saveAll();renderGoals();renderDash();}

function renderGoals(){
  const list=document.getElementById('goals-list');
  const filtered=goals.filter(g=>_goalTab==='active'?!g.done:g.done);
  if(!filtered.length){list.innerHTML=`<div class="goal-empty">${_goalTab==='active'?'Nenhuma meta ativa. Crie uma! 🎯':'Nenhuma meta concluída ainda.'}</div>`;return;}
  list.innerHTML=filtered.map(g=>{const ex=exercises.find(e=>e.id===g.exId);const d=diffDays(new Date(),new Date(g.deadline));const isLate=d<0&&!g.done,isWarn=d>=0&&d<=7&&!g.done;const sess=history.filter(h=>h.exId===g.exId&&h.bpm);const curBpm=sess.length?sess[0].bpm:0;const pct=g.bpmTarget&&curBpm?Math.min(100,Math.round((curBpm/g.bpmTarget)*100)):0;
    return`<div class="goal-card${isLate?' late':isWarn?' warn':''}${g.done?' done-goal':''}"><div class="goal-header"><div class="goal-name">${g.desc||ex?.name||'Meta'}</div><div style="display:flex;gap:5px">${!g.done?`<button class="btn xs" onclick="openGoalModal(${g.id})">Editar</button>`:''}<button class="btn xs danger" onclick="deleteGoal(${g.id})">✕</button></div></div><div class="goal-meta">${ex?diffPill(ex.diff):''}<span style="font-size:11px;color:var(--muted)">${ex?.name||''}</span><span class="deadline-badge ${isLate?'deadline-late':isWarn?'deadline-warn':'deadline-ok'}">${g.done?'✓':isLate?`${Math.abs(d)}d atrasada`:d===0?'Hoje':`${d}d`}</span><span class="goal-deadline">📅 ${formatPT(g.deadline)}</span></div>${g.bpmTarget?`<div class="goal-progress-bar"><div class="goal-progress-fill" style="width:${pct}%"></div></div><div class="goal-progress-label"><span>Atual: ${curBpm||'—'} bpm</span><span>Alvo: ${g.bpmTarget} (${pct}%)</span></div>`:''} ${!g.done?`<div class="goal-actions"><button class="btn pri sm" onclick="completeGoal(${g.id})">Concluir</button></div>`:''}</div>`;
  }).join('');
}

// ════════════════════════════════════════
// HISTÓRICO
// ════════════════════════════════════════
function renderHist(){
  document.getElementById('h-total').textContent=history.length;
  document.getElementById('h-mins').textContent=history.reduce((a,h)=>a+h.duration,0);
  const streak=calcStreak();document.getElementById('h-streak').textContent=streak.current;
  renderHeatmap(streak);renderWeekBars();
  const bpmSel=document.getElementById('bpm-ex-filter'),bpmCurr=bpmSel.value;
  bpmSel.innerHTML=`<option value="">Exercício...</option>`+[...new Set(history.filter(h=>h.bpm).map(h=>h.ex))].sort().map(n=>`<option value="${n}"${n===bpmCurr?' selected':''}>${n}</option>`).join('');
  const fSel=document.getElementById('hist-filter-sel'),fCurr=fSel.value;
  fSel.innerHTML=`<option value="">Todos</option>`+[...new Set(history.map(h=>h.ex))].sort().map(n=>`<option value="${n}"${n===fCurr?' selected':''}>${n}</option>`).join('');
  const cSel=document.getElementById('hist-cycle-filter'),cCurr=cSel.value;
  cSel.innerHTML=`<option value="">Todos os ciclos</option>`+cycles.map(c=>`<option value="${c.id}"${c.id===cCurr?' selected':''}>${c.icon||''} ${c.name}</option>`).join('');
  histPage=0;renderTimeline();renderBpmChart();
}

function calcStreak(){
  const today=new Date();today.setHours(0,0,0,0);
  const days=new Set(history.map(h=>h.isoDate||h.date.split('/').reverse().join('-')));
  let cur=0,rec=0,i=0;
  while(true){const d=new Date(today);d.setDate(d.getDate()-i);const ds=dateStr(d);if(days.has(ds)){cur++;i++;}else if(i===0){i++;}else break;}
  let con=0;[...days].sort().forEach((ds,idx,arr)=>{if(idx===0){con=1;return;}const p=new Date(arr[idx-1]);p.setDate(p.getDate()+1);con=dateStr(p)===ds?con+1:1;rec=Math.max(rec,con);});
  return{current:cur,record:Math.max(rec,cur)};
}

function renderHeatmap(streak){
  const wrap=document.getElementById('heatmap-wrap');
  const today=new Date();today.setHours(0,0,0,0);
  const WEEKS=26,startDay=new Date(today);startDay.setDate(startDay.getDate()-(WEEKS*7)+1);while(startDay.getDay()!==1)startDay.setDate(startDay.getDate()-1);
  const cnt={};history.forEach(h=>{const ds=h.isoDate||h.date.split('/').reverse().join('-');cnt[ds]=(cnt[ds]||0)+1;});
  let html='<div class="heatmap-grid">';
  for(let w=0;w<WEEKS;w++){html+='<div class="heatmap-week">';for(let d=0;d<7;d++){const cur=new Date(startDay);cur.setDate(cur.getDate()+w*7+d);if(cur>today){html+='<div class="heatmap-cell"></div>';continue;}const ds=dateStr(cur),c=cnt[ds]||0;html+=`<div class="heatmap-cell${c>0?' l'+(c===1?1:c===2?2:c===3?3:4):''}${ds===dateStr(today)?' today':''}" title="${ds}: ${c}s"></div>`;}html+='</div>';}
  html+='</div><div class="heatmap-legend">Menos<div class="heatmap-legend-cells"><div class="heatmap-cell"></div><div class="heatmap-cell l1"></div><div class="heatmap-cell l2"></div><div class="heatmap-cell l3"></div><div class="heatmap-cell l4"></div></div>Mais</div>';
  wrap.innerHTML=html;
  document.getElementById('streak-info').innerHTML=`<div class="streak-badge"><div class="streak-badge-num">${streak.current}</div><div class="streak-badge-lbl">dias seguidos</div></div><div class="streak-badge"><div class="streak-badge-num">${streak.record}</div><div class="streak-badge-lbl">recorde</div></div><div class="streak-badge"><div class="streak-badge-num">${new Set(history.map(h=>h.isoDate||h.date)).size}</div><div class="streak-badge-lbl">dias praticados</div></div>`;
}

function renderWeekBars(){const now=new Date();const weeks=Array.from({length:7},(_,i)=>{const d=new Date(now);d.setDate(d.getDate()-i*7);return{iso:getISOWeek(d),label:i===0?'Atual':`-${i}`};}).reverse();const vals=weeks.map(w=>history.filter(h=>h.week===w.iso).length),maxV=Math.max(...vals,1);document.getElementById('h-bars').innerHTML=vals.map((v,i)=>`<div class="bar-col"><div class="bar-val">${v||''}</div><div class="bar${i<vals.length-1?' faded':''}" style="height:${Math.round((v/maxV)*68)}px"></div></div>`).join('');document.getElementById('h-bar-lbls').innerHTML=weeks.map((w,i)=>`<div class="bar-lbl${i===weeks.length-1?' curr':''}">${w.label}</div>`).join('');}

function renderTimeline(){
  const exF=document.getElementById('hist-filter-sel')?.value||'';
  const cyF=document.getElementById('hist-cycle-filter')?.value||'';
  let filtered=history;
  if(exF)filtered=filtered.filter(h=>h.ex===exF);
  if(cyF)filtered=filtered.filter(h=>h.cycleId===cyF);
  const total=filtered.length,start=histPage*HIST_PER_PAGE,page=filtered.slice(start,start+HIST_PER_PAGE);
  if(!page.length){document.getElementById('h-list').innerHTML='<div style="font-size:12px;color:var(--muted)">Sem sessões.</div>';document.getElementById('hist-pagination').innerHTML='';return;}
  const byDay={};page.forEach(h=>{const ds=h.isoDate||h.date;if(!byDay[ds])byDay[ds]=[];byDay[ds].push(h);});
  document.getElementById('h-list').innerHTML=`<div class="timeline">${Object.entries(byDay).sort(([a],[b])=>b.localeCompare(a)).map(([ds,sess])=>{const tot=sess.reduce((a,s)=>a+s.duration,0);const cyc=cycles.find(c=>c.id===sess[0]?.cycleId);return`<div class="tl-day"><div class="tl-day-label"><div class="tl-day-dot"></div><span class="tl-day-date">${sess[0].date||formatPT(ds)}${cyc?` <span style="font-size:10px;color:var(--acc-text)">${cyc.icon} ${cyc.name}</span>`:''}</span><span class="tl-day-total">${tot}min</span></div>${sess.map(h=>`<div class="tl-session"><div class="tl-session-name">${h.ex} ${diffPill(h.diff)}${h.bpm?`<span class="tl-bpm">🎵${h.bpm}bpm</span>`:''}</div><div class="tl-session-meta">${h.time||''} ${h.duration}min</div>${h.note&&h.note!=='—'?`<div class="tl-session-note">${h.note}</div>`:''}</div>`).join('')}</div>`;}).join('')}</div>`;
  const pages=Math.ceil(total/HIST_PER_PAGE);
  document.getElementById('hist-pagination').innerHTML=pages>1?`<button class="btn sm" onclick="histPage=Math.max(0,histPage-1);renderTimeline()" ${histPage===0?'disabled':''}>‹ Anterior</button><span class="hist-page-info">${histPage+1}/${pages} · ${total} sessões</span><button class="btn sm" onclick="histPage=Math.min(${pages-1},histPage+1);renderTimeline()" ${histPage===pages-1?'disabled':''}>Próxima ›</button>`:'';
}

function renderBpmChart(){
  const exName=document.getElementById('bpm-ex-filter')?.value||'';
  const area=document.getElementById('bpm-chart-area');
  if(!exName){area.innerHTML='<div class="bpm-no-data">Selecione um exercício</div>';return;}
  const data=history.filter(h=>h.ex===exName&&h.bpm).sort((a,b)=>(a.isoDate||a.date).localeCompare(b.isoDate||b.date));
  if(data.length<2){area.innerHTML='<div class="bpm-no-data">Mínimo 2 sessões com BPM registrado</div>';return;}
  const W=400,H=90,P=26,bpms=data.map(d=>d.bpm),minB=Math.min(...bpms)-5,maxB=Math.max(...bpms)+5;
  const xS=i=>P+(i/(data.length-1))*(W-P*2),yS=v=>H-P-((v-minB)/(maxB-minB))*(H-P*2);
  const pts=data.map((d,i)=>({x:xS(i),y:yS(d.bpm),bpm:d.bpm,date:d.date||formatPT(d.isoDate)}));
  const path='M'+pts.map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L');
  area.innerHTML=`<div class="bpm-chart-wrap"><svg class="bpm-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="${path}" fill="none" stroke="var(--acc)" stroke-width="2" stroke-linejoin="round"/><path d="${path} L${pts[pts.length-1].x},${H} L${pts[0].x},${H} Z" fill="var(--acc)" opacity=".08"/>${pts.map(p=>`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="var(--acc)"><title>${p.date}: ${p.bpm}bpm</title></circle>`).join('')}<text x="${P}" y="${H-2}" font-size="9" fill="var(--muted)" font-family="DM Mono">${data[0].date||formatPT(data[0].isoDate)}</text><text x="${W-P}" y="${H-2}" font-size="9" fill="var(--muted)" text-anchor="end" font-family="DM Mono">${data[data.length-1].date||formatPT(data[data.length-1].isoDate)}</text></svg><div style="font-size:11px;color:var(--muted);margin-top:4px;text-align:right">${bpms[0]}bpm → <strong style="color:var(--acc)">${bpms[bpms.length-1]}bpm</strong>${bpms[bpms.length-1]>bpms[0]?` <span style="color:#166534">▲ +${bpms[bpms.length-1]-bpms[0]}</span>`:''}</div></div>`;
}

// ════════════════════════════════════════
// TABS
// ════════════════════════════════════════
const TABS={dash:'tab-dash',board:'tab-board',cycles:'tab-cycles',agenda:'tab-agenda',goals:'tab-goals',hist:'tab-hist'};
function switchTab(tab, btn, bnavId){
  currentTab=tab;
  document.querySelectorAll('.tab').forEach(b=>b.classList.remove('on'));
  document.querySelectorAll('.bnav-item').forEach(b=>b.classList.remove('on'));
  if(btn)btn.classList.add('on');
  if(bnavId)document.getElementById(`bnav-${bnavId}`)?.classList.add('on');
  Object.entries(TABS).forEach(([k,id])=>document.getElementById(id).style.display=k===tab?'block':'none');
  if(tab==='dash')   renderDash();
  if(tab==='board')  render();
  if(tab==='cycles') renderCycles();
  if(tab==='agenda') renderAgenda();
  if(tab==='goals')  renderGoals();
  if(tab==='hist')   renderHist();
  stopMetro();
  window.scrollTo(0,0);
}