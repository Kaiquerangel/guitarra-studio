/* ═══════════════════════════════════════════════════
   GUITARRA STUDIO v5.1 — Refatoração Clean Code
   ─────────────────────────────────────────────
   Arquitetura:
   · Store   — estado global desacoplado (window.GS.Store)
   · Logger  — logging estruturado com retry (window.GS.Logger)
   · Metro   — class Metronome (AudioContext, sem setInterval drift)
   · Sync    — retry automático em 8s com fila de pendentes
   · UI      — buildExCard + updateCard (re-render parcial)
   ═══════════════════════════════════════════════════ */

const DIFF_LABELS=['','Iniciante','Básico','Intermediário','Avançado','Expert'];
const DIFF_CLS   =['','d1','d2','d3','d4','d5'];
const WK_NAMES   =['Semana 1','Semana 2','Semana 3','Semana 4'];
function weekName(w){return WK_NAMES[w]??`Semana ${(w||0)+1}`;}
const DAY_NAMES  =['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
const SUGGESTIONS=['','Aumente o andamento em 5 bpm ao completar 3 sessões com clareza.','Pratique sem olhar para as mãos após dominar o padrão.','Combine com o exercício anterior em sequência.','Reduza o tempo olhando para o braço.','Varie a dinâmica (forte/piano) e o timbre.'];

// ════════════════════════════════════════
// STORE — estado global desacoplado da UI
// Toda mutação passa por Store.set() → notifica listeners
// ════════════════════════════════════════
const Store = (() => {
  const _state = {
    exercises:    [],
    history:      [],
    goals:        [],
    schedule:     {},
    cycles:       [],
    activeCycleId: null,
    nextId:        31,
    editingId:     null,
    editingGoalId: null,
    editingCycleId:null,
  };
  const _listeners = {};

  return {
    get(key)         { return _state[key]; },
    getAll()         { return { ..._state }; },

    set(key, value){
      _state[key] = value;
      (_listeners[key] || []).forEach(fn => fn(value));
    },

    patch(key, updater){
      const next = updater(_state[key]);
      Store.set(key, next);
      return next;
    },

    // Hidrata o store todo de uma vez (ex: ao carregar do Firebase)
    hydrate(data){
      Object.entries(data).forEach(([k,v]) => { if(k in _state) _state[k]=v; });
    },

    // Subscrever mudanças de uma chave
    on(key, fn){ (_listeners[key] = _listeners[key]||[]).push(fn); },

    // Resetar para estado limpo (logout)
    reset(){
      Object.keys(_state).forEach(k => {
        _state[k] = Array.isArray(_state[k]) ? [] :
                    typeof _state[k] === 'object' && _state[k] !== null ? {} :
                    null;
      });
      _state.nextId = 31;
    },
  };
})();

// Aliases de compatibilidade — variáveis globais apontam para o Store
// Isso permite que o código legado continue funcionando sem reescrita total
Object.defineProperty(window,'exercises',   {get:()=>Store.get('exercises'),   set:v=>Store.set('exercises',v)});
Object.defineProperty(window,'history',     {get:()=>Store.get('history'),      set:v=>Store.set('history',v)});
Object.defineProperty(window,'goals',       {get:()=>Store.get('goals'),        set:v=>Store.set('goals',v)});
Object.defineProperty(window,'schedule',    {get:()=>Store.get('schedule'),     set:v=>Store.set('schedule',v)});
Object.defineProperty(window,'cycles',      {get:()=>Store.get('cycles'),       set:v=>Store.set('cycles',v)});
Object.defineProperty(window,'activeCycleId',{get:()=>Store.get('activeCycleId'),set:v=>Store.set('activeCycleId',v)});
Object.defineProperty(window,'nextId',       {get:()=>Store.get('nextId'),       set:v=>Store.set('nextId',v)});
Object.defineProperty(window,'editingId',    {get:()=>Store.get('editingId'),    set:v=>Store.set('editingId',v)});
Object.defineProperty(window,'editingGoalId',{get:()=>Store.get('editingGoalId'),set:v=>Store.set('editingGoalId',v)});
Object.defineProperty(window,'editingCycleId',{get:()=>Store.get('editingCycleId'),set:v=>Store.set('editingCycleId',v)});

// UI state (não é domínio — fica em variáveis normais)
let showCfg=false, paletteOpen=false, userMenuOpen=false, agendaOffset=0, praticaOpen=false;
let _goalTab='active', doneColOpen=true, isDark=false;
let histPage=0; const HIST_PER_PAGE=30;
let currentTab='dash';

// ════════════════════════════════════════
// MODAL DE CONFIRMAÇÃO (substitui confirm() nativo)
// ════════════════════════════════════════
function showConfirm(msg, onConfirm, danger=true){
  const overlay=document.createElement('div');
  overlay.className='modal-overlay open';
  overlay.innerHTML=`<div class="modal" style="max-width:360px;gap:16px">
    <div class="modal-title" style="font-size:15px">${msg}</div>
    <div class="modal-actions">
      <button class="btn ghost" id="_conf-cancel">Cancelar</button>
      <button class="btn ${danger?'danger':'pri'}" id="_conf-ok">${danger?'Excluir':'Confirmar'}</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#_conf-cancel').onclick=()=>overlay.remove();
  overlay.querySelector('#_conf-ok').onclick=()=>{overlay.remove();onConfirm();};
  overlay.onclick=e=>{if(e.target===overlay)overlay.remove();};
  setTimeout(()=>overlay.querySelector('#_conf-ok').focus(),50);
}

// ════════════════════════════════════════
// UNDO TOAST (desfaz ação destrutiva)
// ════════════════════════════════════════
function showToastUndo(msg, onUndo, dur=5000){
  const c=document.getElementById('toast-container');
  const t=document.createElement('div');
  t.className='toast info toast-undo';
  t.innerHTML=`<span>ℹ</span> ${msg} <button class="btn xs" style="margin-left:8px;background:rgba(255,255,255,.2);border-color:rgba(255,255,255,.3);color:#fff" id="_undo-btn">Desfazer</button>`;
  c.appendChild(t);
  let undid=false;
  const timer=setTimeout(()=>{if(!undid){t.classList.add('toast-out');setTimeout(()=>t.remove(),250);}},dur);
  t.querySelector('#_undo-btn').onclick=()=>{undid=true;clearTimeout(timer);t.remove();onUndo();showToast('Ação desfeita!','success');};
}

const LS={
  get:(k,fb)=>{try{const r=localStorage.getItem(k);return r?JSON.parse(r):fb;}catch{return fb;}},
  set:(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v));}catch{}}
};

// ════════════════════════════════════════
// AUTH & LOGIN
// ════════════════════════════════════════
// firebase-signout unificado com auth-logout (ver index.html)

// Disparado pelo AUTH.logout()
window.addEventListener('auth-logout', ()=>{
  // Limpar estado da aplicação
  Store.reset();
  histPage=0; agendaOffset=0;
  // Parar timer se estiver rodando
  if(tRun){ clearInterval(tInt); tRun=false; }
  stopMetro();
  document.getElementById('login-screen').classList.remove('hidden');
});

window.addEventListener('auth-error', e=>{
  showToast('Erro no login: '+e.detail,'info');
  // Garantir que a tela de login apareça se escondida por algum motivo
  document.getElementById('login-screen').classList.remove('hidden');
});

window.addEventListener('beforeunload', e=>{
  if(tRun){ e.preventDefault(); e.returnValue=''; }
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
  updateUserUI(window._user||null);
  loadAndInit();
}

// Modo offline removido — autenticação obrigatória
// function useOffline() removida por segurança

// ════════════════════════════════════════
// PERFIL DO USUÁRIO
// ════════════════════════════════════════
function openProfile(tab='info'){
  const user = window._user;
  if(!user) return;

  // Preencher dados do usuário
  const nameEl  = document.getElementById('pf-name');
  const emailEl = document.getElementById('pf-email');
  const bigAv   = document.getElementById('profile-avatar-big');
  const nameDisp= document.getElementById('profile-display-name');
  const emailDisp=document.getElementById('profile-email-display');
  const badge   = document.getElementById('profile-provider-badge');

  if(nameEl)   nameEl.value   = user.displayName||'';
  if(emailEl)  emailEl.value  = user.email||'';
  if(nameDisp) nameDisp.textContent = user.displayName||'Usuário';
  if(emailDisp)emailDisp.textContent= user.email||'';

  // Avatar grande
  if(bigAv){
    if(user.photoURL&&user.photoURL.startsWith('https://')){
      bigAv.innerHTML=`<img src="${user.photoURL}" style="width:100%;height:100%;border-radius:50%;object-fit:cover" alt="Avatar" onerror="this.parentElement.textContent='${(user.displayName||'U')[0].toUpperCase()}'">`;
    } else {
      bigAv.textContent=(user.displayName||'U')[0].toUpperCase();
    }
  }

  // Detectar provedor (Google vs e-mail)
  const isGoogle = user.photoURL?.includes('googleusercontent');
  if(badge) badge.textContent = isGoogle ? '🔵 Google' : '📧 E-mail';

  // Mostrar/ocultar campos de senha conforme provedor
  const pwSection = document.getElementById('pf-change-pw-section');
  const pwHint    = document.getElementById('pf-pw-method-hint');
  if(isGoogle && pwSection){
    if(pwHint) pwHint.innerHTML='<span style="color:var(--muted);font-size:12px">Sua conta usa o Google para autenticar. Para alterar a senha acesse sua <a href="https://myaccount.google.com" target="_blank" style="color:var(--acc)">Conta Google</a>.</span>';
    pwSection.querySelectorAll('input').forEach(i=>i.disabled=true);
    pwSection.querySelector('button.btn.pri')?.setAttribute('disabled','');
  } else {
    if(pwHint) pwHint.innerHTML='';
    pwSection?.querySelectorAll('input').forEach(i=>i.disabled=false);
    pwSection?.querySelector('button.btn.pri')?.removeAttribute('disabled');
  }

  // Stats do perfil
  const statsRow = document.getElementById('pf-stats-row');
  if(statsRow){
    const totalSess = history.length;
    const totalDone = exercises.filter(e=>e.done).length;
    const streak    = calcStreak().current;
    const totalMin  = history.reduce((a,h)=>a+(h.duration||25),0);
    statsRow.innerHTML=`
      <div class="profile-stat"><div class="profile-stat-n">${totalSess}</div><div class="profile-stat-l">Sessões</div></div>
      <div class="profile-stat"><div class="profile-stat-n">${totalDone}</div><div class="profile-stat-l">Dominados</div></div>
      <div class="profile-stat"><div class="profile-stat-n">${streak}</div><div class="profile-stat-l">Streak dias</div></div>
      <div class="profile-stat"><div class="profile-stat-n">${totalMin>=60?Math.round(totalMin/60)+'h':totalMin+'min'}</div><div class="profile-stat-l">Praticado</div></div>`;
  }

  // Data stats
  const dataStats = document.getElementById('pf-data-stats');
  if(dataStats){
    dataStats.innerHTML=`
      <div class="pf-data-item"><span>Exercícios</span><strong>${exercises.length}</strong></div>
      <div class="pf-data-item"><span>Sessões no histórico</span><strong>${history.length}</strong></div>
      <div class="pf-data-item"><span>Metas</span><strong>${goals.length}</strong></div>
      <div class="pf-data-item"><span>Ciclos</span><strong>${cycles.length}</strong></div>`;
  }

  // Nível salvo
  const savedLevel = LS.get('gs-user-level',0);
  document.querySelectorAll('.profile-level-btn').forEach((b,i)=>{
    b.classList.toggle('active', i+1===savedLevel);
  });

  // Instrumento salvo
  const savedInstr = LS.get('gs-instrument','guitarra');
  const instrSel = document.getElementById('pf-instrument');
  if(instrSel) instrSel.value = savedInstr;

  // Preferências do timer
  const cfgWork  = document.getElementById('cfg-work');
  const cfgShort = document.getElementById('cfg-short');
  const cfgLong  = document.getElementById('cfg-long');
  const cfgCyc   = document.getElementById('cfg-cyc');
  if(document.getElementById('pref-work'))  document.getElementById('pref-work').value  = cfgWork?.value||25;
  if(document.getElementById('pref-short')) document.getElementById('pref-short').value = cfgShort?.value||5;
  if(document.getElementById('pref-long'))  document.getElementById('pref-long').value  = cfgLong?.value||15;
  if(document.getElementById('pref-cyc'))   document.getElementById('pref-cyc').value   = cfgCyc?.value||4;

  // Toggle dark
  updatePrefsDarkToggle();

  // Paleta de preferências
  _buildPrefPalette();

  // Toggle som
  const sndEl = document.getElementById('pref-snd-toggle');
  const sndOn = document.getElementById('snd')?.checked;
  if(sndEl) sndEl.classList.toggle('active', sndOn);

  openModal('profile-modal');
  switchProfileTab(tab, document.querySelector(`.profile-tab:nth-child(${['info','senha','dados','prefs'].indexOf(tab)+1})`));
}

function switchProfileTab(tab, btn){
  document.querySelectorAll('.profile-section').forEach(s=>s.classList.add('hidden'));
  document.querySelectorAll('.profile-tab').forEach(b=>b.classList.remove('active'));
  const el = document.getElementById(`ptab-${tab}`);
  if(el) el.classList.remove('hidden');
  if(btn) btn.classList.add('active');
}

async function saveProfileName(){
  const name = document.getElementById('pf-name')?.value.trim().replace(/[<>"']/g,'');
  if(!name||name.length<2){showToast('Nome inválido.','info');return;}
  try{
    const {updateProfile}=await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
    await updateProfile(window._auth.currentUser,{displayName:name});
    window._user.displayName=name;
    updateUserUI(window._user);
    document.getElementById('profile-display-name').textContent=name;
    showToast('Nome atualizado!','success');
    Logger.info('profile name updated');
  }catch(e){showToast('Erro ao atualizar nome: '+e.message,'info');Logger.error('saveProfileName',{err:e.message});}
}

async function saveProfileEmail(){
  const email=document.getElementById('pf-email')?.value.trim();
  const re=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if(!email||!re.test(email)){showToast('E-mail inválido.','info');return;}
  if(email===window._user?.email){showToast('É o mesmo e-mail atual.','info');return;}
  try{
    const {updateEmail}=await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
    await updateEmail(window._auth.currentUser,email);
    window._user.email=email;
    document.getElementById('profile-email-display').textContent=email;
    const hint=document.getElementById('pf-email-hint');
    if(hint) hint.textContent='E-mail atualizado! Pode ser necessário verificar o novo endereço.';
    showToast('E-mail atualizado!','success');
  }catch(e){
    const msgs={'auth/requires-recent-login':'Por segurança, saia e entre novamente antes de alterar o e-mail.','auth/email-already-in-use':'Este e-mail já está em uso.'};
    showToast(msgs[e.code]||'Erro: '+e.message,'info');
  }
}

async function saveProfilePassword(){
  const current = document.getElementById('pf-pw-current')?.value;
  const novo    = document.getElementById('pf-pw-new')?.value;
  const confirm = document.getElementById('pf-pw-confirm')?.value;
  const hint    = document.getElementById('pf-pw-hint');
  const setHint = (msg,ok=false)=>{ if(hint){hint.textContent=msg;hint.style.color=ok?'var(--acc)':'var(--danger)';} };
  if(!current){ setHint('Digite sua senha atual.'); return; }
  if(novo.length<8){ setHint('A nova senha deve ter ao menos 8 caracteres.'); return; }
  if(novo!==confirm){ setHint('As senhas não coincidem.'); return; }
  if(novo===current){ setHint('A nova senha deve ser diferente da atual.'); return; }
  try{
    const {reauthenticateWithCredential,EmailAuthProvider,updatePassword}=await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
    const cred=EmailAuthProvider.credential(window._user.email,current);
    await reauthenticateWithCredential(window._auth.currentUser,cred);
    await updatePassword(window._auth.currentUser,novo);
    document.getElementById('pf-pw-current').value='';
    document.getElementById('pf-pw-new').value='';
    document.getElementById('pf-pw-confirm').value='';
    document.getElementById('pf-pw-strength-fill').style.width='0%';
    document.getElementById('pf-pw-strength-label').textContent='';
    setHint('Senha alterada com sucesso!',true);
    showToast('Senha alterada!','success');
    Logger.info('password changed');
  }catch(e){
    const msgs={'auth/wrong-password':'Senha atual incorreta.','auth/requires-recent-login':'Saia e entre novamente para alterar a senha.','auth/weak-password':'Nova senha muito fraca.'};
    setHint(msgs[e.code]||'Erro: '+e.message);
  }
}

function saveProfileLevel(level,btn){
  LS.set('gs-user-level',level);
  document.querySelectorAll('.profile-level-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  showToast('Nível salvo!','success');
}

function saveProfilePrefs(){
  const instr=document.getElementById('pf-instrument')?.value||'guitarra';
  LS.set('gs-instrument',instr);
  showToast('Preferências salvas!','success');
}

function saveTimerPrefs(){
  const w=document.getElementById('pref-work')?.value;
  const s=document.getElementById('pref-short')?.value;
  const l=document.getElementById('pref-long')?.value;
  const c=document.getElementById('pref-cyc')?.value;
  if(w) document.getElementById('cfg-work').value=w;
  if(s) document.getElementById('cfg-short').value=s;
  if(l) document.getElementById('cfg-long').value=l;
  if(c) document.getElementById('cfg-cyc').value=c;
  applyConfig();
  showToast('Timer configurado!','success');
}

function updatePwStrengthProfile(pw){
  const fill  = document.getElementById('pf-pw-strength-fill');
  const label = document.getElementById('pf-pw-strength-label');
  if(!fill||!label)return;
  let score=0;
  if(pw.length>=8)score++;if(pw.length>=12)score++;
  if(/[A-Z]/.test(pw))score++;if(/[0-9]/.test(pw))score++;if(/[^A-Za-z0-9]/.test(pw))score++;
  const lvls=[{p:'20%',c:'#EF4444',t:'Muito fraca'},{p:'40%',c:'#F97316',t:'Fraca'},{p:'60%',c:'#EAB308',t:'Razoável'},{p:'80%',c:'#22C55E',t:'Forte'},{p:'100%',c:'#16A34A',t:'Muito forte'}];
  const lvl=lvls[Math.min(score,4)];
  fill.style.width=pw.length?lvl.p:'0%';fill.style.background=lvl.c;
  label.textContent=pw.length?lvl.t:'';label.style.color=lvl.c;
}

function updatePrefsDarkToggle(){
  const t=document.getElementById('pref-dark-toggle');
  if(t) t.classList.toggle('active',isDark);
}

function _buildPrefPalette(){
  const grid=document.getElementById('pref-palette-grid');
  if(!grid)return;
  const themes=[
    {id:'amber',name:'Âmbar',c:['#92400E','#C2610F','#FEF3E2']},
    {id:'moss',name:'Musgo',c:['#1A4731','#3D7A4A','#ECFDF5']},
    {id:'slate',name:'Grafite',c:['#1E293B','#334155','#F1F5F9']},
    {id:'wine',name:'Vinho',c:['#6B0F25','#9F1239','#FFF1F2']},
    {id:'midnight',name:'Meia-Noite',c:['#312E81','#4F46E5','#EEF2FF']},
    {id:'metal',name:'Metal',c:['#0A0A0A','#3A3A3A','#E0E0E0']},
  ];
  const cur=document.body.getAttribute('data-theme')||'amber';
  grid.innerHTML=themes.map(t=>`
    <button class="pref-palette-btn${t.id===cur?' active':''}" onclick="setPalette('${t.id}',document.querySelector('[data-theme=${t.id}]'));_buildPrefPalette()" title="${t.name}">
      <div class="pref-palette-swatch">
        ${t.c.map(c=>`<span style="background:${c}"></span>`).join('')}
      </div>
      <span>${t.name}</span>
    </button>`).join('');
}

function togglePrefSound(){
  const el=document.getElementById('snd');
  if(el){el.checked=!el.checked;}
  const t=document.getElementById('pref-snd-toggle');
  if(t) t.classList.toggle('active',el?.checked);
}

function togglePrefInactivity(){
  const t=document.getElementById('pref-inactivity-toggle');
  if(t) t.classList.toggle('active');
}

async function deleteAccount(){
  showConfirm(
    '🗑 Excluir conta permanentemente?<br><span style="font-size:12px;color:var(--danger);font-weight:400">Todos os seus dados serão apagados. Esta ação não pode ser desfeita.</span>',
    async()=>{
      try{
        // Limpar Firestore primeiro
        const colNames=['exercises','sessions','goals','cycles','schedule'];
        for(const c of colNames){
          const docs=await FB.loadAll(c).catch(()=>[]);
          if(docs) for(const d of docs) await FB.del(`${c}/${d.id||d._id||Date.now()}`).catch(()=>{});
        }
        const {deleteUser}=await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
        await deleteUser(window._auth.currentUser);
        Store.reset();
        showToast('Conta excluída. Até logo!','info',4000);
        setTimeout(()=>location.reload(),2000);
      }catch(e){
        const msgs={'auth/requires-recent-login':'Por segurança, saia e entre novamente antes de excluir a conta.'};
        showToast(msgs[e.code]||'Erro ao excluir: '+e.message,'info');
      }
    }
  );
}

async function clearAllData(){
  showConfirm(
    'Apagar todos os dados?<br><span style="font-size:12px;font-weight:400;color:var(--muted)">Exercícios, histórico, metas e ciclos serão removidos. Sua conta permanece ativa.</span>',
    async()=>{
      Store.reset();saveAll();
      const cols=['exercises','sessions','goals','cycles','schedule'];
      for(const c of cols) await FB.del(c).catch(()=>{});
      render();renderDash();
      closeModal('profile-modal');
      showToast('Dados apagados.','info');
    }
  );
}

// ════════════════════════════════════════
// ONBOARDING
// ════════════════════════════════════════
let _obLevel=1;

function checkOnboarding(){
  // Só mostra se for a primeira vez (sem exercícios do usuário além dos default)
  const isFirst = !LS.get('gs-ob-done', false);
  if(isFirst){
    document.getElementById('onboarding-overlay').classList.remove('hidden');
    obGoStep(1);
  }
}

function obGoStep(n){
  document.querySelectorAll('.ob-step').forEach(s=>s.classList.add('hidden'));
  document.getElementById(`ob-step-${n}`)?.classList.remove('hidden');
}

function obSetLevel(level){
  _obLevel = level;
  document.querySelectorAll('.ob-level-btn').forEach(b=>b.classList.remove('active'));
  event.currentTarget.classList.add('active');
  setTimeout(()=>obGoStep(2), 250);
}

function obStep3(){
  const name = document.getElementById('ob-cycle-name').value.trim() || 'Meu primeiro ciclo';
  const levelNames = ['','Iniciante','Intermediário','Avançado'];
  document.getElementById('ob-summary').innerHTML=`
    <div class="ob-summary-item">📚 Ciclo criado: <strong>${name}</strong></div>
    <div class="ob-summary-item">🎸 Nível: <strong>${levelNames[_obLevel]}</strong></div>
    <div class="ob-summary-item">✅ Exercícios de exemplo carregados para o seu nível</div>`;
  obGoStep(3);
}

async function obFinish(){
  const name = document.getElementById('ob-cycle-name')?.value.trim() || 'Meu primeiro ciclo';
  // Criar ciclo
  const c = {
    id: `cy-${Date.now()}`, name, icon: _obLevel===1?'🌱':_obLevel===2?'🎵':'🔥',
    status:'active', startDate: dateStr(new Date()), endDate:'', desc:'',
    createdAt: new Date().toISOString()
  };
  cycles.push(c); activeCycleId = c.id;
  await syncCycle(c);
  // Carregar exercícios do nível escolhido
  _loadLevelExercises(_obLevel, c.id);
  LS.set('gs-ob-done', true);
  document.getElementById('onboarding-overlay').classList.add('hidden');
  render(); renderDash(); renderCycles();
  showToast(`Ciclo "${name}" criado! Bora praticar 🎸`, 'success', 4000);
  switchTab('dash', null, 'dash');
}

function obSkip(){
  LS.set('gs-ob-done', true);
  document.getElementById('onboarding-overlay').classList.add('hidden');
}

function _loadLevelExercises(level, cycleId){
  const banks = {
    1: [ // Iniciante
      {name:'Escala pentatônica — posição 1',desc:'Pentatônica menor na 1ª posição. Suba e desça devagar, 60 bpm.',diff:1,week:0},
      {name:'Mudança de acorde Am → Em',desc:'Alterne Am e Em em semínimas a 60 bpm. 3 séries de 2 min.',diff:1,week:0},
      {name:'Picking alternado — corda solta',desc:'Palheta alternada em cada corda solta, 4 tempos por corda. 70 bpm.',diff:2,week:0},
      {name:'Escala cromática',desc:'1º ao 4º dedo em todas as cordas. Foco na clareza.',diff:1,week:0},
      {name:'Arpejo em Am',desc:'Arpejo ascendente e descendente. 4 repetições a 60 bpm.',diff:2,week:1},
      {name:'Ritmo em semínimas — acorde G',desc:'Strumming down em G maior. Metrônomo 70 bpm, 3 min.',diff:1,week:1},
    ],
    2: [ // Intermediário
      {name:'Escala pentatônica — 5 posições',desc:'Conecte as 5 caixas da pentatônica. 80 bpm.',diff:3,week:0},
      {name:'Acorde F — barre',desc:'Barre chord na 1ª casa. 15 repetições limpas.',diff:3,week:0},
      {name:'Mudança Am–F–G–C',desc:'Progressão clássica. 4/4 a 70 bpm.',diff:2,week:0},
      {name:'Bend de 1 tom',desc:'Bend limpo na 2ª corda, posição 7. Afinação precisa.',diff:3,week:1},
      {name:'Legato — hammer-on / pull-off',desc:'Sequência 1-2-4 em todas as cordas. 90 bpm.',diff:3,week:1},
      {name:'Improvisação em Lá menor',desc:'Improvisar 5 min sobre backing track Am. Foco na musicalidade.',diff:2,week:2},
    ],
    3: [ // Avançado
      {name:'Sweep picking — arpejo de 3 cordas',desc:'Varrida limpa em Am, 3 cordas. 100→140 bpm.',diff:4,week:0},
      {name:'Tapping — padrão 1-2-T',desc:'Two-hand tapping. Sequência A min. 100 bpm.',diff:5,week:0},
      {name:'Alternate picking — escala em oitavas',desc:'Picking alternado em tercinas. 130 bpm, metrônomo obrigatório.',diff:4,week:0},
      {name:'Vibrato controlado',desc:'Vibrato de ½ tom e 1 tom em todas as cordas. Consistência.',diff:4,week:1},
      {name:'String skipping — escala maior',desc:'Pular cordas na escala de Sol maior. 100 bpm.',diff:5,week:1},
      {name:'Improvisação modal — Dórico',desc:'Improvisar em Dórico sobre backing track. 10 min.',diff:4,week:2},
    ],
  };
  const bank = banks[level] || banks[1];
  bank.forEach((e,i) => {
    const ex = {
      id: Date.now()+i, week: e.week, name: e.name, desc: e.desc,
      done: false, focus: i===0, diff: e.diff,
      weekSince: dateStr(new Date()), cycleId
    };
    exercises.push(ex);
    syncEx(ex);
  });
  saveAll();
}

function updateUserUI(user){
  const av=document.getElementById('user-avatar');
  const nm=document.getElementById('um-name');
  const em=document.getElementById('um-email');
  if(user){
    nm.textContent=user.displayName||'Usuário';
    em.textContent=user.email||'';
    if(user.photoURL && user.photoURL.startsWith('https://')){
      const img=document.createElement('img');
      img.src=user.photoURL;
      img.style.cssText='width:28px;height:28px;border-radius:50%;border:2px solid rgba(255,255,255,.4)';
      img.alt='Avatar';
      img.onerror=()=>{av.textContent=(user.displayName||'U')[0].toUpperCase();};
      av.innerHTML='';
      av.appendChild(img);
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
  closeAllPopups();
  showConfirm('Sair da conta?<br><span style="font-size:12px;font-weight:400;color:var(--muted)">Seus dados ficam salvos no Firebase.</span>', ()=>{AUTH.logout();}, false);
}

document.addEventListener('click',e=>{
  if(!e.target.closest('.card-menu')&&!e.target.closest('.card-menu-btn'))closeCardMenus();
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
// ════════════════════════════════════════
// ONBOARDING — exibido apenas na primeira vez
// ════════════════════════════════════════
function checkOnboarding(){
  if(LS.get('gs-onboarded',false)) return;
  if(exercises.length > 0) { LS.set('gs-onboarded',true); return; }
  showOnboarding();
}

function showOnboarding(){
  const ov=document.createElement('div');
  ov.id='onboarding-overlay';
  ov.className='onboarding-overlay';
  ov.innerHTML=`
    <div class="onboarding-card" id="ob-card">
      <!-- Passo 1 -->
      <div class="ob-step active" id="ob-step-1">
        <div class="ob-icon">🎸</div>
        <div class="ob-title">Bem-vindo ao Guitarra Studio!</div>
        <div class="ob-sub">Seu diário de prática. Registre seus exercícios, acompanhe sua evolução e mantenha o ritmo.</div>
        <div class="ob-question">Como você prefere começar?</div>
        <div class="ob-options">
          <button class="ob-opt" onclick="onboardChoose('guided')">
            <span class="ob-opt-icon">🚀</span>
            <span class="ob-opt-label">Me ajude a começar</span>
            <span class="ob-opt-sub">Criar exercícios prontos para meu nível</span>
          </button>
          <button class="ob-opt" onclick="onboardChoose('own')">
            <span class="ob-opt-icon">✏️</span>
            <span class="ob-opt-label">Vou criar meus próprios</span>
            <span class="ob-opt-sub">Já sei o que quero estudar</span>
          </button>
        </div>
      </div>

      <!-- Passo 2 — nível -->
      <div class="ob-step" id="ob-step-2">
        <div class="ob-icon">🎯</div>
        <div class="ob-title">Qual é o seu nível?</div>
        <div class="ob-sub">Vamos criar um conjunto de exercícios ideal para você.</div>
        <div class="ob-options">
          <button class="ob-opt" onclick="onboardLevel(1)">
            <span class="ob-opt-icon">🌱</span>
            <span class="ob-opt-label">Iniciante</span>
            <span class="ob-opt-sub">Acordes abertos, escalas básicas, ritmo simples</span>
          </button>
          <button class="ob-opt" onclick="onboardLevel(2)">
            <span class="ob-opt-icon">🔥</span>
            <span class="ob-opt-label">Intermediário</span>
            <span class="ob-opt-sub">Barre chords, pentatônica, progressões</span>
          </button>
          <button class="ob-opt" onclick="onboardLevel(3)">
            <span class="ob-opt-icon">⚡</span>
            <span class="ob-opt-label">Avançado</span>
            <span class="ob-opt-sub">Técnicas, improvisação, teoria aplicada</span>
          </button>
        </div>
        <button class="ob-back" onclick="onboardBack(1)">← Voltar</button>
      </div>

      <!-- Passo 3 — pronto -->
      <div class="ob-step" id="ob-step-3">
        <div class="ob-icon">✅</div>
        <div class="ob-title">Tudo pronto!</div>
        <div class="ob-sub" id="ob-ready-msg">Seu primeiro ciclo de estudos foi criado com exercícios do seu nível.</div>
        <div class="ob-explain">
          <div class="ob-explain-item">📋 <strong>Quadro</strong> — seus exercícios, organizados por semana</div>
          <div class="ob-explain-item">⏱ <strong>Barra de prática</strong> — timer e metrônomo sempre visíveis no topo</div>
          <div class="ob-explain-item">📊 <strong>Início</strong> — seu resumo diário de evolução</div>
        </div>
        <button class="btn pri" style="width:100%;margin-top:16px" onclick="onboardFinish()">Começar a praticar 🎸</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
}

function onboardChoose(mode){
  if(mode==='guided'){
    document.getElementById('ob-step-1').classList.remove('active');
    document.getElementById('ob-step-2').classList.add('active');
  } else {
    onboardFinishEmpty();
  }
}

function onboardBack(step){
  document.querySelectorAll('.ob-step').forEach(s=>s.classList.remove('active'));
  document.getElementById(`ob-step-${step}`).classList.add('active');
}

const OB_PRESETS = {
  1: [
    {name:'Acordes básicos — Am, Em, E',desc:'Troque entre Am, Em e E em colcheias a 60 bpm. Foco na clareza.',diff:1},
    {name:'Escala pentatônica — posição 1',desc:'Pentatônica menor, 1ª posição. Suba e desça lentamente.',diff:1},
    {name:'Ritmo em semínimas — acorde G',desc:'Batida simples Down em G maior. Metrônomo 70 bpm.',diff:1},
    {name:'Mudança de acorde Am→Em',desc:'Troque sem parar, 4 tempos em cada. 60 bpm.',diff:1},
  ],
  2: [
    {name:'Barre chord F — 1ª casa',desc:'Barre completo. 10 repetições. Foco na pressão do indicador.',diff:3},
    {name:'Pentatônica menor — 5 posições',desc:'Conecte todas as posições pela escala inteira.',diff:3},
    {name:'Progressão Am–F–C–G',desc:'Clássica. 4/4 a 70 bpm. Todas as trocas limpas.',diff:2},
    {name:'Picking alternado — corda solta',desc:'Palheta alternada em cada corda. 80 bpm, 4 tempos.',diff:2},
  ],
  3: [
    {name:'Legato — hammer-on e pull-off',desc:'Pentatônica com legato em todas as posições. 100 bpm.',diff:4},
    {name:'Sweep picking — arpejo em Am',desc:'Arpejo de 3 cordas. Começa a 60 bpm com metrônomo.',diff:5},
    {name:'Alternate picking 16 avos',desc:'Escala maior em colcheias de semicolcheias. 90→130 bpm.',diff:4},
    {name:'Improvisação sobre backing track',desc:'Blues em Am. 12 compassos. Grave e ouça de volta.',diff:4},
  ],
};

async function onboardLevel(level){
  document.getElementById('ob-step-2').classList.remove('active');
  document.getElementById('ob-step-3').classList.add('active');
  const levelNames={1:'Iniciante',2:'Intermediário',3:'Avançado'};
  document.getElementById('ob-ready-msg').textContent=
    `Seu ciclo "${levelNames[level]}" foi criado com 4 exercícios prontos para começar.`;
  // Criar ciclo
  const cycle={id:`cy-${Date.now()}`,name:levelNames[level],desc:`Ciclo de estudos gerado no início`,
    startDate:dateStr(new Date()),endDate:null,icon:['🌱','🔥','⚡'][level-1],
    status:'active',createdAt:dateStr(new Date())};
  cycles.push(cycle);activeCycleId=cycle.id;await syncCycle(cycle);
  // Criar exercícios
  for(const [i,p] of OB_PRESETS[level].entries()){
    const ex={id:Date.now()+i,week:0,name:p.name,desc:p.desc,done:false,
      focus:i===0,diff:p.diff,weekSince:dateStr(new Date()),cycleId:cycle.id};
    exercises.push(ex);await syncEx(ex);
    await new Promise(r=>setTimeout(r,30));
  }
  saveAll();renderDash();render();renderBoardCycleTag();
}

function onboardFinishEmpty(){
  document.getElementById('ob-step-1').classList.remove('active');
  document.getElementById('ob-step-3').classList.add('active');
  document.getElementById('ob-ready-msg').textContent='Vá ao Quadro e adicione seu primeiro exercício para começar.';
}

function onboardFinish(){
  LS.set('gs-onboarded',true);
  const ov=document.getElementById('onboarding-overlay');
  if(ov){ov.classList.add('ob-exit');setTimeout(()=>ov.remove(),400);}
  // Abrir painel de prática para mostrar que existe
  if(!praticaOpen) togglePraticaPanel();
  renderDash();render();
  const ex=getFocusEx();
  if(ex) showToast(`Comece praticando "${ex.name}" 🎸`,'success',4000);
}

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

  Store.set('nextId', Math.max(0,...Store.get('exercises').map(e=>e.id),30)+1);
  agendaOffset=LS.get('gs-agenda-offset',0);
  Store.set('activeCycleId', Store.get('cycles').find(c=>c.status==='active')?.id||null);
  hideLoad();
  restorePrefs();
  checkInactivity();
  checkOnboarding();
  renderDash(); render(); updatePomo(); renderPomoDots();
  document.getElementById('tb-date').textContent=new Date().toLocaleDateString('pt-BR',{weekday:'long',day:'numeric',month:'long'});
  if('Notification'in window&&Notification.permission==='default')Notification.requestPermission();
  checkOnboarding();
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
// LOGGER
// ════════════════════════════════════════
const Logger = {
  _log: [],
  info:  (msg, ctx={}) => Logger._write('INFO',  msg, ctx),
  warn:  (msg, ctx={}) => Logger._write('WARN',  msg, ctx),
  error: (msg, ctx={}) => Logger._write('ERROR', msg, ctx),
  _write(level, msg, ctx){
    const entry = { level, msg, ctx, ts: new Date().toISOString() };
    Logger._log.push(entry);
    if(Logger._log.length > 200) Logger._log.shift();
    if(level === 'ERROR') console.error(`[GS] ${msg}`, ctx);
    else if(level === 'WARN') console.warn(`[GS] ${msg}`, ctx);
    else console.log(`[GS] ${msg}`, ctx);
  },
  dump(){ return Logger._log.map(e=>`[${e.ts}] ${e.level} — ${e.msg}`).join('\n'); }
};
// Expor Logger e Store no window para debug via DevTools
window.GS = { Logger, Store, version: '5.1' };

// ════════════════════════════════════════
// SYNC COM RETRY
// ════════════════════════════════════════
const _syncQueue = new Map(); // path → {data, retries}
let _syncRetryTimer = null;

function saveAll(){
  LS.set('gs-ex',     Store.get('exercises'));
  LS.set('gs-hist',   Store.get('history').slice(0,500));
  LS.set('gs-goals',  Store.get('goals'));
  LS.set('gs-sched',  Store.get('schedule'));
  LS.set('gs-cycles', Store.get('cycles'));
}

async function sync(path, data){
  saveAll();
  if(!window._db || !window._uid || window._uid==='offline') return;
  setSyncStatus('syncing');
  try {
    await FB.save(path, data);
    _syncQueue.delete(path);
    if(!_syncQueue.size) setSyncStatus('synced');
    Logger.info('sync ok', { path });
  } catch(err) {
    Logger.error('sync falhou, agendando retry', { path, err: err?.message });
    _syncQueue.set(path, { data, retries: (_syncQueue.get(path)?.retries||0)+1 });
    setSyncStatus('offline');
    _scheduleRetry();
    // Notificar apenas na 1ª falha para não spammar
    if(_syncQueue.get(path).retries === 1){
      showToast('Falha ao sincronizar — tentando novamente...','info',3000);
    }
  }
}

function _scheduleRetry(){
  if(_syncRetryTimer) return;
  _syncRetryTimer = setTimeout(async ()=>{
    _syncRetryTimer = null;
    if(!_syncQueue.size) return;
    Logger.info('retry sync', { pending: _syncQueue.size });
    for(const [path, {data, retries}] of _syncQueue){
      if(retries >= 5){
        Logger.warn('sync desistiu após 5 tentativas', { path });
        _syncQueue.delete(path);
        continue;
      }
      await sync(path, data);
    }
  }, 8000); // retry em 8s
}

async function syncEx(ex)    { await sync(`exercises/${ex.id}`, ex); }
async function syncSess(s)   { await sync(`sessions/${s.id||Date.now()}`, s); }
async function syncGoal(g)   { await sync(`goals/${g.id}`, g); }
async function syncCycle(c)  { await sync(`cycles/${c.id}`, c); }
async function syncSched(day,ids){ LS.set('gs-sched',schedule); await sync(`schedule/${day}`,{day,exIds:ids}); }

// ════════════════════════════════════════
// EXPORT
// ════════════════════════════════════════
function importData(){
  const inp=document.createElement('input');
  inp.type='file';inp.accept='.json';
  inp.onchange=async(e)=>{
    const file=e.target.files[0];if(!file)return;
    try{
      const data=JSON.parse(await file.text());
      if(!data.exercises&&!data.history){showToast('Arquivo inválido.','info');return;}
      showConfirm(`Importar backup de ${data.exportedAt?new Date(data.exportedAt).toLocaleDateString('pt-BR'):'data desconhecida'}?<br><span style="font-size:12px;font-weight:400;color:var(--muted)">Os dados atuais serão substituídos.</span>`,async()=>{
        if(data.exercises)exercises=data.exercises;
        if(data.history)history=data.history;
        if(data.goals)goals=data.goals;
        if(data.cycles)cycles=data.cycles;
        if(data.schedule)schedule=data.schedule;
        nextId=Math.max(0,...exercises.map(e=>e.id),30)+1;
        activeCycleId=cycles.find(c=>c.status==='active')?.id||null;
        saveAll();
        showToast('Backup importado com sucesso!','success');
        renderDash();render();renderCycles&&renderCycles();
      },false);
    }catch(err){showToast('Erro ao ler o arquivo.','info');console.warn(err);}
  };
  inp.click();
}

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
function setPalette(t,el){
  document.body.setAttribute('data-theme',t);
  document.querySelectorAll('.palette-option').forEach(o=>o.classList.remove('active'));
  el.classList.add('active');
  LS.set('gs-theme',t);
  // Metal sempre em dark mode
  if(t==='metal' && !isDark){ isDark=true; document.body.classList.add('dark'); LS.set('gs-dark',true); }
  setTimeout(()=>{paletteOpen=false;document.getElementById('palette-popup').classList.remove('open');},150);
}

function restorePrefs(){
  const t=LS.get('gs-theme',null);
  if(t){
    document.body.setAttribute('data-theme',t);
    const o=document.querySelector(`.palette-option[data-theme="${t}"]`);
    if(o){document.querySelectorAll('.palette-option').forEach(x=>x.classList.remove('active'));o.classList.add('active');}
  }
  isDark=LS.get('gs-dark', t==='metal'); // Metal sempre dark
  if(t==='metal') isDark=true;
  document.body.classList.toggle('dark',isDark);
}

// ════════════════════════════════════════
// UI UTILS
// ════════════════════════════════════════
function showLoad(m){document.getElementById('load-msg').textContent=m;document.getElementById('app-loading').classList.remove('hidden');}
function hideLoad(){document.getElementById('app-loading').classList.add('hidden');}
function setSyncStatus(s){const d=document.getElementById('sync-dot'),l=document.getElementById('sync-label');d.className='sync-dot';if(s==='syncing'){d.classList.add('syncing');l.textContent='Salvando...';}else if(s==='offline'){d.classList.add('offline');l.textContent='Offline';}else{l.textContent='Sincronizado';}}
function showToast(msg,type='info',dur=2800){const c=document.getElementById('toast-container'),t=document.createElement('div');t.className=`toast ${type}`;t.innerHTML=`<span>${type==='success'?'✓':'ℹ'}</span> ${msg}`;c.appendChild(t);setTimeout(()=>{t.classList.add('toast-out');setTimeout(()=>t.remove(),250);},dur);}
function showToastRich(html,type='info',dur=4500){const c=document.getElementById('toast-container'),t=document.createElement('div');t.className=`toast ${type}`;t.innerHTML=`<span>${type==='success'?'✓':'ℹ'}</span> ${html}`;c.appendChild(t);setTimeout(()=>{t.classList.add('toast-out');setTimeout(()=>t.remove(),250);},dur);}
function closeModal(id){document.getElementById(id).classList.remove('open');}
function openModal(id){
  const m=document.getElementById(id);
  m.classList.add('open');
  const first=m.querySelector('input,select,textarea,button:not(.btn.ghost)');
  setTimeout(()=>first?.focus(),50);
}

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
// class Metronome — AudioContext preciso (sem setInterval drift)
// Usa Web Audio API scheduling: T_next = T_current + 60/BPM
// ════════════════════════════════════════
class Metronome {
  constructor(){
    this.bpm       = 80;
    this.beats     = 4;
    this.current   = 0;
    this.running   = false;
    this._actx     = null;
    this._nextTime = 0;       // próximo beat em AudioContext.currentTime
    this._lookahead   = 25;   // ms — quão cedo agendar (intervalo do scheduler)
    this._schedWindow = 0.1;  // s  — janela de agendamento (evita glitches)
    this._timer    = null;
    this._tapTimes = [];
    this._tapReset = null;
  }

  // BPM com clamp 30–240
  setBpm(v){
    this.bpm = Math.max(30, Math.min(240, Number.isFinite(v) ? v : 80));
    const n = document.getElementById('metro-num');
    const s = document.getElementById('metro-slider');
    if(n) n.textContent = this.bpm;
    if(s) s.value       = this.bpm;
    Logger.info('metro BPM', { bpm: this.bpm });
  }
  changeBpm(d){ this.setBpm(this.bpm + d); }

  _getCtx(){
    if(!this._actx) this._actx = new (window.AudioContext||window.webkitAudioContext)();
    return this._actx;
  }

  // Agenda um clique no tempo exato via AudioContext
  _scheduleClick(time, isAccent){
    const ctx  = this._getCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type            = 'square';
    osc.frequency.value = isAccent ? 1200 : 900;
    gain.gain.setValueAtTime(isAccent ? 0.3 : 0.15, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + (isAccent ? 0.08 : 0.05));
    osc.start(time);
    osc.stop(time + 0.1);
  }

  // Atualiza visual no beat correto
  _flashBeat(beatIndex){
    document.querySelectorAll('.metro-beat').forEach((b,i)=>{
      b.classList.toggle('on', i === beatIndex);
    });
  }

  // Scheduler loop — roda a cada _lookahead ms
  // Agenda todos os beats dentro da janela _schedWindow
  _scheduler(){
    const ctx = this._getCtx();
    while(this._nextTime < ctx.currentTime + this._schedWindow){
      const beatIdx = this.current;
      const t       = this._nextTime;
      // Agendar visual com requestAnimationFrame sincronizado ao áudio
      const delay = (t - ctx.currentTime) * 1000;
      setTimeout(()=>this._flashBeat(beatIdx), Math.max(0, delay));
      this._scheduleClick(t, beatIdx === 0);
      this._nextTime += 60 / this.bpm; // T_next = T_current + 60/BPM
      this.current    = (this.current + 1) % this.beats;
    }
  }

  start(){
    if(this.running) return;
    this.running  = true;
    this.current  = 0;
    const ctx     = this._getCtx();
    if(ctx.state === 'suspended') ctx.resume();
    this._nextTime = ctx.currentTime + 0.05; // pequeno offset inicial
    this._scheduler();
    this._timer = setInterval(()=>this._scheduler(), this._lookahead);
    const btn = document.getElementById('metro-play-btn');
    if(btn) btn.textContent = '⏹ Parar';
    Logger.info('metro start', { bpm: this.bpm, beats: this.beats });
  }

  stop(){
    this.running = false;
    clearInterval(this._timer); this._timer = null;
    document.querySelectorAll('.metro-beat').forEach(b=>b.classList.remove('on'));
    const btn = document.getElementById('metro-play-btn');
    if(btn) btn.textContent = '▶ Iniciar';
    Logger.info('metro stop');
  }

  toggle(){ this.running ? this.stop() : this.start(); }

  setBeats(n){
    this.beats = n;
    this._renderBeats();
  }

  _renderBeats(){
    const el = document.getElementById('metro-beats');
    if(!el) return;
    el.innerHTML = Array.from({length:this.beats},(_,i)=>
      `<div class="metro-beat${i===0?' accent':''}" id="mb-${i}"></div>`
    ).join('');
  }

  tapTempo(){
    const now = Date.now();
    this._tapTimes.push(now);
    if(this._tapTimes.length > 8) this._tapTimes.shift();
    if(this._tapTimes.length > 1){
      const gaps = this._tapTimes.slice(1).map((t,i)=>t-this._tapTimes[i]);
      const avg  = gaps.reduce((a,b)=>a+b) / gaps.length;
      this.setBpm(Math.round(60000 / avg));
    }
    clearTimeout(this._tapReset);
    this._tapReset = setTimeout(()=>{ this._tapTimes = []; }, 2000);
  }

  destroy(){
    this.stop();
    if(this._actx){ this._actx.close(); this._actx = null; }
  }
}

// Instância global
const Metro = new Metronome();

// Wrappers para compatibilidade com onclick= no HTML
function setBpm(v)       { Metro.setBpm(v); }
function changeBpm(d)    { Metro.changeBpm(d); }
function toggleMetro()   { Metro.toggle(); }
function startMetro()    { Metro.start(); }
function stopMetro()     { Metro.stop(); }
function tapTempo()      { Metro.tapTempo(); }
function renderMetroBeats(){ Metro._renderBeats(); }

// Proxy de estado para compatibilidade com código existente
Object.defineProperty(window,'metroRunning',{ get:()=>Metro.running });
Object.defineProperty(window,'metroBpm',    { get:()=>Metro.bpm, set:(v)=>Metro.setBpm(v) });
Object.defineProperty(window,'metroBeats',  { get:()=>Metro.beats, set:(v)=>Metro.setBeats(v) });

function renderMetro(exBpm){
  if(exBpm) Metro.setBpm(exBpm);
  return ''; // painel está no HTML estático (pratica-bar), não injetado
}

// ════════════════════════════════════════
// POMODORO
// ════════════════════════════════════════
let tInt=null,tRun=false,totSec=25*60,remSec=25*60,phase='work',pomoDone=0,_pomoExId=null;
function toggleCfg(){showCfg=!showCfg;document.getElementById('cfg-panel').classList.toggle('open',showCfg);document.getElementById('cfg-btn').classList.toggle('active',showCfg);}
function togglePraticaPanel(){
  praticaOpen=!praticaOpen;
  const panel=document.getElementById('pratica-panel');
  const icon=document.getElementById('pratica-expand-icon');
  const btn=document.getElementById('pratica-expand-btn');
  panel.classList.toggle('open',praticaOpen);
  btn.classList.toggle('active',praticaOpen);
  if(icon)icon.textContent=praticaOpen?'▴':'▾';
  if(praticaOpen) updatePraticaSession();
}
function updatePraticaSession(){
  const area=document.getElementById('pratica-session-area');
  if(!area)return;
  const ex=getFocusEx();
  if(!ex){area.innerHTML='<div style="font-size:12px;color:var(--muted);text-align:center;padding:16px 0">Selecione um exercício no <strong>Quadro</strong> para registrar</div>';return;}
  const lastBpm=history.filter(h=>h.exId===ex.id&&h.bpm).sort((a,b)=>(b.isoDate||b.date||'').localeCompare(a.isoDate||a.date||'')).slice(0,1)[0]?.bpm||'';
  area.innerHTML=`
    <div style="font-size:12px;font-weight:600;color:var(--acc);margin-bottom:8px">🎯 ${ex.name}</div>
    <label class="note-label">Anotação</label>
    <textarea class="note-area" id="focus-note" placeholder="Como foi? O que melhorou?" style="height:44px"></textarea>
    <div class="bpm-row" style="margin-bottom:8px"><label>BPM</label><input type="number" class="bpm-input" id="focus-bpm" placeholder="${lastBpm||'ex: 80'}" min="20" max="300" value="${lastBpm}">${lastBpm?`<span style="font-size:10px;color:var(--muted)">último: ${lastBpm}</span>`:''}</div>
    <div style="display:flex;gap:6px">
      <button class="btn pri sm" style="flex:1" onclick="saveSession(${ex.id})">Salvar sessão</button>
      <button class="btn sm" onclick="markDone(${ex.id})">✓ Concluir</button>
    </div>`;
}
function applyConfig(){if(!tRun){totSec=parseInt(document.getElementById('cfg-work').value)*60;remSec=totSec;phase='work';pomoDone=0;updatePomo();renderPomoDots();document.getElementById('p-btn').innerHTML='Iniciar <span class="kbd tab-desktop-only">Space</span>';;showToast('Config aplicada!','info');}else{showToast('Pare o timer antes de alterar.','info');}}
function getFmt(s){return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');}
function renderPomoDots(){const cyc=parseInt(document.getElementById('cfg-cyc').value)||4;document.getElementById('p-dots').innerHTML=Array.from({length:cyc},(_,i)=>`<div class="pdot${i<pomoDone?' dn':i===pomoDone?' cur':''}"></div>`).join('');}
function updatePomo(){document.getElementById('p-time').textContent=getFmt(remSec);const c=2*Math.PI*19,o=c*(remSec/totSec);document.getElementById('p-arc').style.stroke=phase==='work'?'var(--acc)':'var(--acc-mid)';document.getElementById('p-arc').setAttribute('stroke-dashoffset',o);document.getElementById('p-phase').textContent={work:'Foco',short:'Intervalo',long:'Descanso longo'}[phase];}
function togglePomo(){
  if(tRun){clearInterval(tInt);tRun=false;document.getElementById('p-btn').innerHTML='Iniciar <span class="kbd tab-desktop-only">Space</span>';}
  else{tRun=true;_pomoExId=getFocusEx()?.id||null;document.getElementById('p-btn').innerHTML='Pausar <span class="kbd tab-desktop-only">Space</span>';
    clearInterval(tInt);tInt=setInterval(()=>{remSec--;
      if(document.getElementById('snd-tick').checked&&remSec<=5&&remSec>0)playTick();
      if(remSec<=0){clearInterval(tInt);tRun=false;const cyc=parseInt(document.getElementById('cfg-cyc').value)||4;
        if(phase==='work'){playWorkEnd();pomoDone++;renderPomoDots();phase=pomoDone>=cyc?'long':'short';totSec=parseInt(document.getElementById(phase==='long'?'cfg-long':'cfg-short').value)*60;showToast('Sessão concluída! 🎸','success');}
        else{playBreakEnd();if(phase==='long')pomoDone=0;phase='work';totSec=parseInt(document.getElementById('cfg-work').value)*60;renderPomoDots();showToast('Hora de focar! 💪','info');}
        remSec=totSec;updatePomo();document.getElementById('p-btn').innerHTML='Iniciar <span class="kbd tab-desktop-only">Space</span>';
        const ex_n=getFocusEx();
        if('Notification'in window&&Notification.permission==='granted')new Notification('Guitarra Studio',{body:phase==='work'?`Hora de focar! ${ex_n?'— '+ex_n.name:''}`:ex_n?`Pausa! Continue em "${ex_n.name}"`:' Descanse!'});
        document.title=phase==='work'?`⏱ Foco — Guitarra Studio`:`☕ Pausa — Guitarra Studio`;
        return;}updatePomo();updateDashTimer_safe();},1000);}
}
function updateDashTimer_safe(){ if(currentTab==='dash') updateDashTimer(); }
function resetPomo(){clearInterval(tInt);tRun=false;phase='work';pomoDone=0;totSec=parseInt(document.getElementById('cfg-work').value)*60;remSec=totSec;updatePomo();renderPomoDots();document.getElementById('p-btn').innerHTML='Iniciar <span class="kbd tab-desktop-only">Space</span>';}

// ════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ════════════════════════════════════════
document.addEventListener('keydown', e=>{
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.tagName==='SELECT')return;
  if(e.key===' '){e.preventDefault();togglePomo();}
  if(e.key==='s'||e.key==='S'){const ex=getFocusEx();if(ex)saveSession(ex.id);}
  if(e.key==='d'||e.key==='D')toggleDark();
  if(e.key==='Escape'){document.querySelectorAll('.modal-overlay.open').forEach(m=>m.classList.remove('open'));closeAllPopups();closeCardMenus?.();}
  if(e.key==='1')switchTab('dash',null,'dash');
  if(e.key==='2')switchTab('board',null,'board');
  if(e.key==='3')switchTab('cycles',null,'cycles');
  if(e.key==='4')switchTab('hist',null,'hist');
  if(e.key==='5')switchTab('agenda',null,'agenda');
  if(e.key==='6')switchTab('goals',null,'goals');
  if(e.key==='7')switchTab('repertorio',null,'repertorio');
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
  // Sempre atualiza a barra de prática (visível em todas as abas)
  const ex=getFocusEx();
  const pex=document.getElementById('p-ex');
  if(pex&&ex) pex.textContent=ex.name;
  if(praticaOpen) updatePraticaSession();
  // Só re-renderiza o painel se estiver na aba Início
  if(currentTab!=='dash') return;
  renderDashCycleBanner();renderDashStats();renderDashUrgent();renderDashFocus();renderDashNext();renderDashToday();renderDashRepertorio();
}

// Sincroniza o mini-timer embutido no Dashboard
function updateDashTimer(){
  const tEl=document.getElementById('dash-p-time');
  const aEl=document.getElementById('dash-p-arc');
  const phEl=document.getElementById('dash-p-phase');
  const dotsEl=document.getElementById('dash-p-dots');
  const btnEl=document.getElementById('dash-p-btn');
  if(!tEl)return;
  tEl.textContent=getFmt(remSec);
  if(aEl){
    const c=2*Math.PI*30, o=c*(remSec/totSec);
    aEl.style.stroke=phase==='work'?'var(--acc)':'var(--acc-mid)';
    aEl.setAttribute('stroke-dashoffset',o);
  }
  if(phEl) phEl.textContent={work:'Foco',short:'Pausa curta',long:'Pausa longa'}[phase];
  if(btnEl) btnEl.innerHTML=tRun?'⏸ Pausar':'▶ Praticar agora';
  if(dotsEl){
    const cyc=parseInt(document.getElementById('cfg-cyc').value)||4;
    dotsEl.innerHTML=Array.from({length:cyc},(_,i)=>`<div class="pdot${i<pomoDone?' dn':i===pomoDone?' cur':''}"></div>`).join('');
  }
}

// saveDashSession — salva sessão a partir dos campos do dashboard
async function saveDashSession(id){
  const bpmEl=document.getElementById('dash-focus-bpm');
  const noteEl=document.getElementById('dash-focus-note');
  const bpmVal=bpmEl?parseInt(bpmEl.value)||null:null;
  const noteVal=noteEl?noteEl.value.trim():'';
  // Sincronizar para o painel de prática
  const bpmSrc=document.getElementById('focus-bpm');
  const noteSrc=document.getElementById('focus-note');
  if(bpmSrc&&bpmVal) bpmSrc.value=bpmVal;
  if(noteSrc&&noteVal) noteSrc.value=noteVal;
  await saveSession(id);
  if(bpmEl) bpmEl.value='';
  if(noteEl) noteEl.value='';
}

function renderDashCycleBanner(){
  const c=getActiveCycle();
  const el=document.getElementById('dash-cycle-banner');
  if(!c){el.innerHTML=`<div class="cycle-banner" style="border-style:dashed;opacity:.8">
    <div class="cycle-icon">📚</div>
    <div class="cycle-info">
      <div class="cycle-name" style="font-size:14px;color:var(--text)">Sem ciclo ativo</div>
      <div class="cycle-meta">Um ciclo organiza sua fase de estudo atual — ex: "Fundamentos", "Blues"</div>
    </div>
    <button class="btn pri sm" onclick="switchTab('cycles',null,'cycles')">Criar ciclo →</button>
  </div>`;return;}
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
  if(!ex){
    el.innerHTML=`<div class="dash-no-focus">
      <div class="dash-no-focus-icon">🎸</div>
      <div class="dash-no-focus-title">Nenhum exercício selecionado</div>
      <div class="dash-no-focus-sub">Vá ao Quadro, clique em um exercício e volte aqui para praticar.</div>
      <button class="btn pri" onclick="switchTab('board',null,'board')" style="width:100%">Abrir Quadro →</button>
    </div>`;
    return;
  }
  const lastBpm=history.filter(h=>h.exId===ex.id&&h.bpm).sort((a,b)=>(b.isoDate||'').localeCompare(a.isoDate||'')).slice(0,1)[0]?.bpm||'';
  const sessCount=history.filter(h=>h.exId===ex.id).length;
  const isRunning=tRun;
  el.innerHTML=`<div class="dash-praticar-card">
    <!-- Exercício -->
    <div class="dash-praticar-ex">
      <div class="dash-praticar-label">Praticando agora</div>
      <div class="dash-praticar-name">${ex.name}</div>
      <div class="dash-praticar-pills">${diffPill(ex.diff)} ${weekPill(ex.week)} ${deadlineBadge(ex)}${sessCount?`<span class="week-pill">${sessCount}× praticado</span>`:''}</div>
      <div class="dash-praticar-desc">${ex.desc}</div>
      ${SUGGESTIONS[ex.diff]?`<div class="dash-focus-suggest">💡 ${SUGGESTIONS[ex.diff]}</div>`:''}
    </div>

    <!-- Timer inline no dash -->
    <div class="dash-praticar-timer">
      <div class="dash-timer-display">
        <div class="dash-timer-circle">
          <svg width="72" height="72"><circle cx="36" cy="36" r="30" fill="none" stroke="var(--border)" stroke-width="3.5"/><circle cx="36" cy="36" r="30" fill="none" stroke="var(--acc)" stroke-width="3.5" stroke-dasharray="188" stroke-dashoffset="188" id="dash-p-arc" stroke-linecap="round" transform="rotate(-90 36 36)"/></svg>
          <div class="dash-timer-time" id="dash-p-time">${getFmt(remSec)}</div>
        </div>
        <div>
          <div class="dash-timer-phase" id="dash-p-phase">${{work:'Foco',short:'Pausa curta',long:'Pausa longa'}[phase]}</div>
          <div class="pdots" id="dash-p-dots" style="margin-top:4px"></div>
        </div>
      </div>
      <div class="dash-praticar-btns">
        <button class="btn pri" style="flex:1" id="dash-p-btn" onclick="togglePomo();updateDashTimer()">${isRunning?'⏸ Pausar':'▶ Praticar agora'}</button>
        <button class="btn" onclick="resetPomo();updateDashTimer()" title="Reiniciar">↺</button>
      </div>
      <!-- Registro rápido -->
      <div class="dash-registro">
        <div class="dash-registro-label">Registrar sessão</div>
        <div class="dash-registro-row">
          <input type="number" class="bpm-input" id="dash-focus-bpm" placeholder="BPM ${lastBpm||'ex: 80'}" min="20" max="300" value="${lastBpm}" style="width:80px">
          <textarea class="note-area" id="dash-focus-note" placeholder="Anotação rápida..." style="flex:1;height:32px;resize:none"></textarea>
        </div>
        <div style="display:flex;gap:6px;margin-top:6px">
          <button class="btn pri sm" style="flex:1" onclick="saveDashSession(${ex.id})">💾 Salvar sessão</button>
          <button class="btn sm" onclick="markDone(${ex.id})" title="Marcar como concluído">✓ Concluir</button>
          <button class="btn ghost sm" onclick="openEditModal(${ex.id})" title="Editar exercício">✏️</button>
        </div>
      </div>
    </div>
  </div>`;

  updateDashTimer();
  const pex=document.getElementById('p-ex');
  if(pex)pex.textContent=ex.name;
  if(praticaOpen)updatePraticaSession();
}

function updateDashTimer(){
  const arc=document.getElementById('dash-p-arc');
  const time=document.getElementById('dash-p-time');
  const ph=document.getElementById('dash-p-phase');
  const btn=document.getElementById('dash-p-btn');
  const dots=document.getElementById('dash-p-dots');
  if(arc){const total=188;arc.setAttribute('stroke-dashoffset',total*(remSec/totSec));}
  if(time)time.textContent=getFmt(remSec);
  if(ph)ph.textContent={work:'Foco',short:'Pausa curta',long:'Pausa longa'}[phase];
  if(btn)btn.textContent=tRun?'⏸ Pausar':'▶ Praticar agora';
  if(dots){const cyc=parseInt(document.getElementById('cfg-cyc')?.value)||4;dots.innerHTML=Array.from({length:cyc},(_,i)=>`<div class="pdot${i<pomoDone?' dn':i===pomoDone?' cur':''}"></div>`).join('');}
}

async function saveDashSession(id){
  const bpmEl=document.getElementById('dash-focus-bpm');
  const noteEl=document.getElementById('dash-focus-note');
  const bpm=parseInt(bpmEl?.value)||null;
  const note=noteEl?.value||'';
  const resolvedId=_pomoExId||id;
  const ex=Store.get('exercises').find(e=>e.id===resolvedId)||Store.get('exercises').find(e=>e.id===id);
  if(!ex)return;
  const dur=parseInt(document.getElementById('cfg-work')?.value)||25;
  const now=new Date();
  const sess={id:String(Date.now()),exId:ex.id,ex:ex.name,diff:ex.diff,cycleId:ex.cycleId||activeCycleId||null,
    isoDate:dateStr(now),date:now.toLocaleDateString('pt-BR'),
    time:now.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}),
    week:getISOWeek(now),duration:dur,note:note||'—',bpm};
  history.unshift(sess);
  await syncSess(sess);
  if(bpmEl)bpmEl.value='';
  if(noteEl)noteEl.value='';
  showToast(`Sessão de "${ex.name}" salva! ✓`,'success');
  if(currentTab==='hist')renderHist();
  const sessTotal=history.filter(h=>h.exId===ex.id).length;
  if(sessTotal>=3&&!ex.done){
    showToastUndo(
      `Sessão ${sessTotal} salva! Deseja concluir "${ex.name}"?`,
      ()=>markDone(ex.id), 6000
    );
    setTimeout(()=>{const b=document.getElementById('_undo-btn');if(b)b.textContent='✓ Concluir';},50);
  }else{
    showToast(`Sessão de "${ex.name}" salva! ✓`,'success');
  }
  if(currentTab==='hist')renderHist();
  renderDash();updateDashTimer_safe();
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
  el.innerHTML=`<div class="dash-next"><div class="dash-next-title">Próximos exercícios<button class="btn xs ghost" onclick="switchTab('board',null,'board')">Ver todos →</button></div>${next.map(e=>`<div class="next-item" onclick="setFocus(${e.id});switchTab('board',null,'board')"><span class="next-item-name">${e.name}</span><span class="next-item-meta">${diffPill(e.diff)} ${weekPill(e.week)}${deadlineBadge(e)}</span></div>`).join('')}</div>`;
}

function renderDashRepertorio(){
  const el=document.getElementById('dash-rep-preview');
  if(!el)return;
  const done=exercises.filter(e=>e.done);
  if(!done.length){el.innerHTML='';return;}
  const recent=done.slice().sort((a,b)=>b.id-a.id).slice(0,3);
  el.innerHTML=`<div class="dash-next">
    <div class="dash-next-title">🎸 Repertório <span style="font-size:11px;color:var(--muted);font-weight:400">${done.length} dominado${done.length>1?'s':''}</span>
      <button class="btn xs ghost" onclick="switchTab('repertorio',null,'repertorio')">Ver tudo →</button>
    </div>
    ${recent.map(e=>{
      const sess=history.filter(h=>h.exId===e.id).length;
      const bpm=history.filter(h=>h.exId===e.id&&h.bpm).sort((a,b)=>b.bpm-a.bpm)[0]?.bpm||null;
      return`<div class="next-item" style="opacity:.8" onclick="switchTab('repertorio',null,'repertorio')">
        <span class="next-item-name">✅ ${e.name}</span>
        <span class="next-item-meta">${diffPill(e.diff)}${bpm?`<span class="week-pill">${bpm} BPM</span>`:''}${sess?`<span class="week-pill">${sess}×</span>`:''}</span>
      </div>`;
    }).join('')}
  </div>`;
}

function renderDashToday(){
  const el=document.getElementById('dash-today-agenda');
  if(!el)return;
  const todayDs=dateStr(new Date());
  const todayIds=schedule[todayDs]||[];
  const todayExs=todayIds.map(id=>exercises.find(e=>e.id===id)).filter(Boolean).filter(e=>!e.done);
  if(!todayExs.length){el.innerHTML='';return;}
  el.innerHTML=`<div class="dash-next">
    <div class="dash-next-title">📅 Agendados para hoje<button class="btn xs ghost" onclick="switchTab('agenda',null,'agenda')">Ver agenda →</button></div>
    ${todayExs.map(e=>`<div class="next-item" onclick="setFocus(${e.id})"><span class="next-item-name">${e.name}</span><span class="next-item-meta">${diffPill(e.diff)}</span></div>`).join('')}
  </div>`;
}

// ════════════════════════════════════════
// BOARD
// ════════════════════════════════════════
function buildExCard(e, isFocus, sd, db, adv){
  return`<div class="ex-card${isFocus?' in-focus':''}" data-ex-id="${e.id}" onclick="setFocus(${e.id})"
  style="${e.cycleId&&e.cycleId===activeCycleId?'border-left:3px solid var(--acc)':''}">
          <div class="ex-card-top">
            <div class="ex-card-name">${e.name}</div>
            ${(()=>{const c=cycles.find(x=>x.id===e.cycleId);return c&&c.id===activeCycleId?`<span style="font-size:9px;color:var(--acc);font-weight:600;letter-spacing:.04em;opacity:.8">${c.icon||'🎸'}</span>`:''})()}
            <button class="card-menu-btn" onclick="event.stopPropagation();toggleCardMenu(${e.id})" title="Opções">⋯</button>
            <div class="card-menu" id="card-menu-${e.id}">
              <div class="card-menu-item" onclick="event.stopPropagation();closeCardMenus();openEditModal(${e.id})">✏️ Editar</div>
              <div class="card-menu-item" onclick="event.stopPropagation();closeCardMenus();addGoalInline(${e.id})">🎯 Adicionar meta</div>
              <div class="card-menu-item" onclick="event.stopPropagation();closeCardMenus();scheduleExInline(${e.id})">📅 Agendar para hoje</div>
              <div class="card-menu-item danger" onclick="event.stopPropagation();closeCardMenus();deleteExById(${e.id})">🗑️ Excluir</div>
            </div>
          </div>
          <div class="ex-card-desc">${sd}</div>
          <div class="card-pills">${diffPill(e.diff)}${isFocus?'<span class="focus-badge">foco</span>':''}${deadlineBadge(e)}${db}<div class="card-check${e.done?' dn':''}" onclick="event.stopPropagation();markDone(${e.id})"></div></div>
          <div class="card-advance-row">
          ${adv}
          <button class="btn xs ghost card-meta-btn" onclick="event.stopPropagation();openInlineMeta(${e.id})" title="Adicionar meta de BPM">🎯</button>
        </div>
        <div class="card-inline-meta" id="inline-meta-${e.id}" style="display:none"></div>
        </div>`;
}

function render(){renderPending();renderDone();renderPomoDots();renderBoardCycleTag();}

// Atualiza um único card sem re-renderizar o quadro inteiro
function updateCard(id){
  const ex = Store.get('exercises').find(e=>e.id===id);
  // Se não encontrado ou mudou de status done→pending, re-render completo
  if(!ex){ render(); return; }
  const cardEl = document.querySelector(`[data-ex-id="${id}"]`);
  if(!cardEl){ render(); return; }
  const isFocus = ex.focus && !ex.done;
  const focEx   = getFocusEx();
  const sd      = ex.desc?.length>80 ? ex.desc.slice(0,80)+'…' : ex.desc||'';
  const db      = `<span class="week-pill">${weekName(ex.week)}</span>`;
  const adv     = ex.week<3
    ? `<button class="btn xs advance-btn" onclick="event.stopPropagation();advanceWeek(${ex.id})">→ Sem ${ex.week+2}</button>`
    : `<span class="last-week-tag">✓ Final</span>`;
  const newHTML = buildExCard(ex, isFocus, sd, db, adv);
  cardEl.outerHTML = newHTML;
}
function renderBoardCycleTag(){const c=getActiveCycle();document.getElementById('board-cycle-tag').textContent=c?`${c.icon||'🎸'} ${c.name}`:'Sem ciclo ativo';}

function renderPending(){
  if(!exercises.length){
    document.getElementById('pending-area').innerHTML=`<div style="padding:40px 20px;text-align:center;color:var(--muted);line-height:2">
      <div style="font-size:36px;margin-bottom:8px">🎸</div>
      <div style="font-size:14px;font-weight:600;color:var(--text)">Nenhum exercício ainda</div>
      <div style="font-size:12px">Clique em <strong>+ Adicionar</strong> abaixo para começar seu estudo</div>
    </div>`;
    document.getElementById('cnt-done').textContent='0';
    document.getElementById('done-col-body').innerHTML='';
    return;
  }
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
        return buildExCard(e, isFocus, sd, db, adv);
      }).join('')}
      <div id="addform-w${w}" style="display:none"></div>
      <button class="add-btn" onclick="openAdd(${w})">+ Adicionar</button>
    </div>`;
  }).join('');
}

function openInlineMeta(id){
  document.querySelectorAll('.card-inline-meta').forEach(el=>{if(el.id!==`inline-meta-${id}`)el.style.display='none';});
  const el=document.getElementById(`inline-meta-${id}`);if(!el)return;
  if(el.style.display==='block'){el.style.display='none';return;}
  const ex=exercises.find(e=>e.id===id);
  const existGoal=goals.find(g=>g.exId===id&&!g.done);
  if(existGoal){
    el.innerHTML=`<div class="inline-meta-box"><div style="font-size:11px;color:var(--muted);margin-bottom:6px">Meta ativa: <strong>${existGoal.targetBpm?existGoal.targetBpm+' BPM':existGoal.desc||'—'}</strong></div><div style="display:flex;gap:6px"><button class="btn xs" onclick="markGoalDone('${existGoal.id}');document.getElementById('inline-meta-${id}').style.display='none'">Concluída ✓</button><button class="btn xs ghost" onclick="document.getElementById('inline-meta-${id}').style.display='none'">Fechar</button></div></div>`;
    el.style.display='block';return;
  }
  el.innerHTML=`<div class="inline-meta-box"><div style="font-size:11px;font-weight:600;margin-bottom:8px">🎯 Meta para: ${ex?ex.name:'exercício'}</div><div style="display:flex;gap:6px;margin-bottom:6px"><input type="number" id="im-bpm-${id}" placeholder="BPM alvo" style="width:80px;padding:5px 8px;border:1.5px solid var(--border);border-radius:var(--radius);font-size:12px;background:var(--bg-card);color:var(--text)" min="20" max="300"><input type="date" id="im-date-${id}" style="flex:1;padding:5px 8px;border:1.5px solid var(--border);border-radius:var(--radius);font-size:12px;background:var(--bg-card);color:var(--text)" min="${dateStr(new Date())}"></div><div style="display:flex;gap:6px"><button class="btn xs pri" style="flex:1" onclick="saveInlineMeta(${id})">Salvar</button><button class="btn xs ghost" onclick="document.getElementById('inline-meta-${id}').style.display='none'">✕</button></div></div>`;
  el.style.display='block';
  document.getElementById(`im-bpm-${id}`)?.focus();
}

async function saveInlineMeta(exId){
  const bpm=parseInt(document.getElementById(`im-bpm-${exId}`)?.value)||0;
  const date=document.getElementById(`im-date-${exId}`)?.value||'';
  if(!bpm&&!date){showToast('Informe BPM alvo ou prazo.','info');return;}
  const ex=exercises.find(e=>e.id===exId);
  const g={id:Date.now(),exId,targetBpm:bpm||null,desc:bpm?`${bpm} BPM em "${ex?.name||''}"`:(ex?.name||''),deadline:date,done:false,createdAt:new Date().toISOString()};
  goals.push(g);await syncGoal(g);
  document.getElementById(`inline-meta-${exId}`).style.display='none';
  showToast(`Meta criada${bpm?' — alvo: '+bpm+' BPM':''}!`,'success');
  render();renderDash();
}

function markGoalDone(id){
  const g=goals.find(g=>String(g.id)===String(id));if(!g)return;
  g.done=true;syncGoal(g);
  showToast('Meta concluída! 🎯','success');
  render();renderDash();
}

function markDone(id){
  const ex=exercises.find(e=>e.id===id);if(!ex)return;
  ex.done=true;ex.focus=false;
  // Próximo exercício assume o foco
  const next=exercises.find(e=>!e.done&&e.week===ex.week&&e.id!==id)||exercises.find(e=>!e.done&&e.id!==id);
  if(next){next.focus=true;document.getElementById('p-ex').textContent=next.name;syncEx(next);}
  else{const pex=document.getElementById('p-ex');if(pex)pex.textContent='Selecione um exercício';}
  syncEx(ex);
  // Fechar inline meta se aberta
  const _im=document.getElementById(`inline-meta-${id}`);
  if(_im)_im.style.display='none';
  // Ciclo completo?
  if(activeCycleId){
    const cExs=exercises.filter(e=>e.cycleId===activeCycleId);
    if(cExs.length&&cExs.every(e=>e.done)) showToast('🏆 Todos os exercícios do ciclo concluídos!','success',6000);
  }
  // Toast com Desfazer + link para Repertório
  showToastUndo(
    `"${ex.name}" concluído! 🎸`,
    ()=>{ ex.done=false;ex.focus=false;syncEx(ex);render();renderDash(); },
    5000
  );
  setTimeout(()=>{
    const undobtn=document.getElementById('_undo-btn');
    if(undobtn) undobtn.insertAdjacentHTML('afterend',
      ` <span onclick="switchTab('repertorio',null,'repertorio')" style="cursor:pointer;text-decoration:underline;color:#fff;font-size:12px;margin-left:6px">Ver Repertório →</span>`
    );
  },80);
  render();renderDash();
}

function reactivateEx(id){
  const ex=exercises.find(e=>e.id===id);if(!ex)return;
  ex.done=false;ex.focus=false;
  syncEx(ex);
  showToast(`"${ex.name}" reativado!`,'success');
  render();renderDash();
}

// ════════════════════════════════════════
// REPERTÓRIO — exercícios que o usuário já domina
// ════════════════════════════════════════
function renderRepertorio(){
  const done = exercises.filter(e=>e.done);
  const search = (document.getElementById('rep-search')?.value||'').toLowerCase().trim();
  const filterDiff = parseInt(document.getElementById('rep-filter-diff')?.value)||0;
  const filterCycle = document.getElementById('rep-filter-cycle')?.value||'';
  const sort = document.getElementById('rep-sort')?.value||'date';

  // Popular filtro de ciclos
  const cycleSelect = document.getElementById('rep-filter-cycle');
  if(cycleSelect && cycleSelect.options.length <= 1){
    cycles.forEach(c=>{
      const opt = document.createElement('option');
      opt.value = c.id; opt.textContent = c.name;
      cycleSelect.appendChild(opt);
    });
  }

  // Filtrar
  let filtered = done.filter(e=>{
    const matchSearch = !search || e.name.toLowerCase().includes(search) || (e.desc||'').toLowerCase().includes(search);
    const matchDiff   = !filterDiff || e.diff===filterDiff;
    const matchCycle  = !filterCycle || e.cycleId===filterCycle;
    return matchSearch && matchDiff && matchCycle;
  });

  // Ordenar
  filtered.sort((a,b)=>{
    if(sort==='name')    return a.name.localeCompare(b.name);
    if(sort==='diff')    return b.diff-a.diff;
    if(sort==='sessions'){
      const sa=history.filter(h=>h.exId===a.id).length;
      const sb=history.filter(h=>h.exId===b.id).length;
      return sb-sa;
    }
    if(sort==='bpm'){
      const ba=history.filter(h=>h.exId===a.id&&h.bpm).sort((x,y)=>y.bpm-x.bpm)[0]?.bpm||0;
      const bb=history.filter(h=>h.exId===b.id&&h.bpm).sort((x,y)=>y.bpm-x.bpm)[0]?.bpm||0;
      return bb-ba;
    }
    // date: mais recente primeiro (id é Date.now())
    return b.id-a.id;
  });

  // Stats
  const statsEl = document.getElementById('rep-stats');
  if(statsEl && done.length){
    const totalSess = done.reduce((acc,e)=>acc+history.filter(h=>h.exId===e.id).length, 0);
    const totalMin  = done.reduce((acc,e)=>acc+history.filter(h=>h.exId===e.id).reduce((s,h)=>s+(h.duration||25),0), 0);
    const bestBpm   = done.reduce((acc,e)=>{
      const b=history.filter(h=>h.exId===e.id&&h.bpm).sort((x,y)=>y.bpm-x.bpm)[0]?.bpm||0;
      return Math.max(acc,b);
    },0);
    const byCycle   = {};
    done.forEach(e=>{ const c=cycles.find(c=>c.id===e.cycleId); const k=c?c.name:'Sem ciclo'; byCycle[k]=(byCycle[k]||0)+1; });
    const topCycle  = Object.entries(byCycle).sort((a,b)=>b[1]-a[1])[0];
    statsEl.innerHTML=`
      <div class="rep-stat"><div class="rep-stat-num">${done.length}</div><div class="rep-stat-lbl">Dominados</div></div>
      <div class="rep-stat"><div class="rep-stat-num">${totalSess}</div><div class="rep-stat-lbl">Sessões totais</div></div>
      <div class="rep-stat"><div class="rep-stat-num">${totalMin>=60?Math.round(totalMin/60)+'h':totalMin+'min'}</div><div class="rep-stat-lbl">Tempo praticado</div></div>
      ${bestBpm?`<div class="rep-stat"><div class="rep-stat-num">${bestBpm}</div><div class="rep-stat-lbl">Maior BPM</div></div>`:''}
      ${topCycle?`<div class="rep-stat rep-stat-wide"><div class="rep-stat-num">${topCycle[1]}</div><div class="rep-stat-lbl">de "${topCycle[0]}"</div></div>`:''}
    `;
  } else if(statsEl) statsEl.innerHTML='';

  // Sub-título
  const subEl=document.getElementById('rep-sub');
  if(subEl) subEl.textContent=done.length
    ? `${done.length} exercício${done.length>1?'s':''} dominado${done.length>1?'s':''}${filtered.length<done.length?' · '+filtered.length+' exibidos':''}`
    : 'Exercícios e músicas que você já domina';

  // Vazio
  const emptyEl=document.getElementById('rep-empty');
  const gridEl=document.getElementById('rep-grid');
  if(!done.length){
    if(emptyEl) emptyEl.classList.remove('hidden');
    if(gridEl)  gridEl.innerHTML='';
    return;
  }
  if(emptyEl) emptyEl.classList.add('hidden');

  if(!gridEl) return;

  if(!filtered.length){
    gridEl.innerHTML=`<div class="rep-no-results">Nenhum resultado para "<strong>${search||'filtro aplicado'}</strong>"</div>`;
    return;
  }

  gridEl.innerHTML = filtered.map(e=>{
    const sess     = history.filter(h=>h.exId===e.id);
    const sessCount= sess.length;
    const totalMin = sess.reduce((s,h)=>s+(h.duration||25),0);
    const bestBpm  = sess.filter(h=>h.bpm).sort((a,b)=>b.bpm-a.bpm)[0]?.bpm||null;
    const lastDate = sess.sort((a,b)=>(b.isoDate||'').localeCompare(a.isoDate||''))[0]?.date||'—';
    const lastNote = sess.find(h=>h.note&&h.note!=='—')?.note||'';
    const cycle    = cycles.find(c=>c.id===e.cycleId);
    const diffStars= '★'.repeat(e.diff)+'☆'.repeat(5-e.diff);
    return `<div class="rep-card" data-id="${e.id}">
      <div class="rep-card-header">
        <div class="rep-card-name">${e.name}</div>
        <div class="rep-card-menu">
          <button class="rep-card-menu-btn" onclick="toggleRepMenu(${e.id})" title="Opções">⋯</button>
          <div class="rep-card-dropdown" id="rep-menu-${e.id}">
            <div class="rep-menu-item" onclick="reactivateEx(${e.id});renderRepertorio()">↩ Mover para o Quadro</div>
            <div class="rep-menu-item" onclick="openEditModal(${e.id})">✏️ Editar</div>
            <div class="rep-menu-item danger" onclick="deleteExById(${e.id})">🗑️ Excluir</div>
          </div>
        </div>
      </div>

      <div class="rep-card-diff" title="Dificuldade: ${DIFF_LABELS[e.diff]}">${diffStars} <span>${DIFF_LABELS[e.diff]}</span></div>

      ${e.desc&&e.desc!=='Sem descrição.'?`<div class="rep-card-desc">${e.desc}</div>`:''}

      <div class="rep-card-stats">
        ${sessCount?`<div class="rep-card-stat"><span class="rep-stat-icon">🔄</span>${sessCount} sessão${sessCount>1?'s':''}</div>`:''}
        ${totalMin?`<div class="rep-card-stat"><span class="rep-stat-icon">⏱</span>${totalMin>=60?Math.round(totalMin/60)+'h':totalMin+' min'}</div>`:''}
        ${bestBpm?`<div class="rep-card-stat"><span class="rep-stat-icon">🎯</span>${bestBpm} BPM</div>`:''}
        <div class="rep-card-stat"><span class="rep-stat-icon">📅</span>última: ${lastDate}</div>
      </div>

      ${lastNote?`<div class="rep-card-note">"${lastNote.length>80?lastNote.slice(0,80)+'…':lastNote}"</div>`:''}

      <div class="rep-card-footer">
        ${cycle?`<span class="rep-cycle-tag">${cycle.icon||'📚'} ${cycle.name}</span>`:''}
        <button class="btn xs pri" onclick="reviveEx(${e.id})" title="Revisar — mover para praticar novamente">🔁 Revisar</button>
      </div>
    </div>`;
  }).join('');

  // Fechar menus ao clicar fora
  document.querySelectorAll('.rep-card-dropdown').forEach(d=>d.classList.remove('open'));
}

function toggleRepMenu(id){
  const el=document.getElementById(`rep-menu-${id}`);
  if(!el)return;
  const wasOpen=el.classList.contains('open');
  document.querySelectorAll('.rep-card-dropdown').forEach(d=>d.classList.remove('open'));
  if(!wasOpen) el.classList.add('open');
}

// "Revisar" — move de volta ao quadro mas mantém histórico
function reviveEx(id){
  const ex=exercises.find(e=>e.id===id);if(!ex)return;
  showConfirm(
    `Revisar "<strong>${ex.name}</strong>"?<br><span style="font-size:12px;font-weight:400;color:var(--muted)">O exercício voltará ao Quadro para uma nova rodada de prática. O histórico é mantido.</span>`,
    ()=>{
      ex.done=false; ex.focus=true;
      // Desfocar os outros
      exercises.forEach(e=>{if(e.id!==id)e.focus=false;});
      syncEx(ex);
      document.getElementById('p-ex').textContent=ex.name;
      showToast(`"${ex.name}" voltou ao Quadro para revisão! 🔁`,'success',4000);
      render(); renderDash(); renderRepertorio();
      switchTab('board',null,'board');
    }, false
  );
}

function renderDone(){
  const done=exercises.filter(e=>e.done);
  document.getElementById('cnt-done').textContent=done.length;
  document.getElementById('done-col-body').innerHTML=done.length?done.map(e=>`<div class="done-card"><div class="done-card-name">${e.name}</div><div class="card-pills" style="margin-top:3px">${diffPill(e.diff)} ${weekPill(e.week)}</div><button class="btn xs ghost" style="margin-top:5px;width:100%;font-size:10px" onclick="reactivateEx(${e.id})" title="Mover de volta ao quadro">↩ Reativar</button></div>`).join(''):'<div style="font-size:12px;color:var(--muted);padding:4px 0">Nenhum ainda</div>';
}

function toggleDoneCol(){doneColOpen=!doneColOpen;document.getElementById('done-col-body').classList.toggle('collapsed',!doneColOpen);}

// ════════════════════════════════════════
// FOCO / AÇÕES
// ════════════════════════════════════════
function setFocus(id){
  const prev = getFocusEx();
  Store.get('exercises').forEach(e=>e.focus=e.id===id&&!e.done);
  const ex = Store.get('exercises').find(e=>e.id===id);
  if(ex&&!ex.done){
    document.getElementById('p-ex').textContent=ex.name;
    Store.get('exercises').forEach(e=>{if(e.focus||e.id===id)syncEx(e);});
    // Abrir painel na primeira vez que o usuário foca um exercício
  if(!praticaOpen && !LS.get('gs-panel-hinted',false)){
    togglePraticaPanel();
    LS.set('gs-panel-hinted',true);
    showToast('Painel de prática aberto! Aqui estão seu timer e metrônomo.','info',4000);
  } else if(praticaOpen) updatePraticaSession();
    const lastBpm=Store.get('history').filter(h=>h.exId===ex.id&&h.bpm).sort((a,b)=>(b.isoDate||'').localeCompare(a.isoDate||'')).slice(0,1)[0]?.bpm;
    if(lastBpm)setBpm(lastBpm);
  }
  // Atualizar apenas os cards afetados em vez de re-render total
  if(prev&&prev.id!==id) updateCard(prev.id);
  updateCard(id);
  renderDash();
}

async function saveSession(id){
  // Usar o exId gravado no início do timer para não salvar exercício errado
  const resolvedId = _pomoExId||id;
  const ex=Store.get('exercises').find(e=>e.id===resolvedId)||Store.get('exercises').find(e=>e.id===id);
  if(!ex)return;
  const note=document.getElementById('focus-note')?.value||'';
  const bpm=parseInt(document.getElementById('focus-bpm')?.value)||null;
  const dur=parseInt(document.getElementById('cfg-work').value)||25;
  const now=new Date();
  const sess={id:String(Date.now()),exId:ex.id,ex:ex.name,diff:ex.diff,cycleId:ex.cycleId||activeCycleId||null,isoDate:dateStr(now),date:now.toLocaleDateString('pt-BR'),time:now.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}),week:getISOWeek(now),duration:dur,note:note||'—',bpm};
  history.unshift(sess);
  await syncSess(sess);
  // Oferecer marcar como concluído de forma não intrusiva
  const toastMsg=`Sessão salva! <button onclick="markDone(${ex.id})" style="margin-left:8px;background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.3);color:#fff;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:12px">✓ Concluir</button>`;
  showToastRich(toastMsg,'success');
  if(currentTab==='hist')renderHist();
  renderDash();
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
async function addEx(w){const name=document.getElementById(`nf-name-${w}`).value.trim();if(!name){showToast('Informe o nome.','info');return;}const desc=document.getElementById(`nf-desc-${w}`).value.trim();const diff=parseInt(document.getElementById(`nf-diff-${w}`).value);const count=exercises.filter(e=>e.week===w&&!e.done).length;if(count>=6&&!confirm(`A ${weekName(w)} já tem ${count} exercícios. Adicionar mesmo assim?`))return;const ex={id:Date.now(),week:w,name,desc:desc||'Sem descrição.',done:false,focus:false,diff,weekSince:dateStr(new Date()),cycleId:activeCycleId||null};exercises.push(ex);await syncEx(ex);showToast(`"${name}" adicionado!`,'success');document.getElementById(`addform-w${w}`).style.display='none';document.getElementById(`addform-w${w}`).innerHTML='';render();renderDash();}
function openEditModal(id){editingId=id;const ex=exercises.find(e=>e.id===id);if(!ex)return;document.getElementById('edit-name').value=ex.name;document.getElementById('edit-desc').value=ex.desc;document.getElementById('edit-week').value=ex.week;document.getElementById('edit-diff').value=ex.diff;openModal('edit-modal');}
async function saveEdit(){const ex=exercises.find(e=>e.id===editingId);if(!ex)return;const newName=document.getElementById('edit-name').value.trim();const newDesc=document.getElementById('edit-desc').value.trim();if(!newName){showToast('O nome não pode ficar vazio.','info');return;}ex.name=newName;ex.desc=newDesc||ex.desc;ex.week=parseInt(document.getElementById('edit-week').value);ex.diff=parseInt(document.getElementById('edit-diff').value);await syncEx(ex);closeModal('edit-modal');showToast('Exercício atualizado!','success');if(ex.focus)document.getElementById('p-ex').textContent=ex.name;render();renderDash();}
// Card menu helpers
function addGoalInline(exId){
  const ex=exercises.find(e=>e.id===exId);if(!ex)return;
  const existing=goals.find(g=>g.exId===exId&&!g.done);
  if(existing){showToast(`"${ex.name}" já tem uma meta ativa.`,'info');return;}
  // Pré-preencher e abrir modal de meta
  if(typeof openGoalModal==='function'){
    openGoalModal();
    setTimeout(()=>{
      const sel=document.getElementById('goal-ex');
      if(sel){sel.value=exId; sel.dispatchEvent(new Event('change'));}
      const desc=document.getElementById('goal-desc');
      if(desc&&!desc.value) desc.value=`Tocar "${ex.name}" com precisão`;
    },100);
  }
}

function scheduleExInline(exId){
  const today=dateStr(new Date());
  if(!schedule[today])schedule[today]=[];
  if(schedule[today].includes(exId)){showToast('Já agendado para hoje!','info');return;}
  schedule[today].push(exId);
  syncSched(today,schedule[today]);
  showToast('Adicionado à agenda de hoje! 📅','success');
  renderDash(); // atualiza "agendados para hoje"
}

function toggleCardMenu(id){
  const menu=document.getElementById(`card-menu-${id}`);
  if(!menu)return;
  const isOpen=menu.classList.contains('open');
  closeCardMenus();
  if(!isOpen)menu.classList.add('open');
}
function closeCardMenus(){
  document.querySelectorAll('.card-menu.open').forEach(m=>m.classList.remove('open'));
}
async function deleteExById(id){
  const ex=exercises.find(e=>e.id===id);if(!ex)return;
  const backup={...ex};
  showConfirm(`Excluir "<strong>${ex.name}</strong>"?`, async()=>{
    exercises=exercises.filter(e=>e.id!==id);
    // Limpar schedule
    Object.keys(schedule).forEach(day=>{schedule[day]=(schedule[day]||[]).filter(eid=>eid!==id);});
    saveAll();
    showToastUndo('Exercício excluído.', async()=>{
      exercises.push(backup);exercises.sort((a,b)=>a.id-b.id);
      Object.keys(schedule).forEach(day=>{if(schedule[day]){schedule[day]=schedule[day].filter(eid=>eid!==backup.id);}});
      await syncEx(backup);render();renderDash();
    });
    await FB.del(`exercises/${id}`).catch(()=>{});
    render();renderDash();
  });
}

async function deleteEx(){
  const ex=exercises.find(e=>e.id===editingId);if(!ex)return;
  const backup={...ex},id=editingId;
  closeModal('edit-modal');
  showConfirm(`Excluir "<strong>${ex.name}</strong>"?`, async()=>{
    exercises=exercises.filter(e=>e.id!==id);
    Object.keys(schedule).forEach(day=>{schedule[day]=(schedule[day]||[]).filter(eid=>eid!==id);});
    saveAll();editingId=null;
    showToastUndo('Exercício excluído.', async()=>{
      exercises.push(backup);exercises.sort((a,b)=>a.id-b.id);
      await syncEx(backup);render();renderDash();
    });
    await FB.del(`exercises/${id}`).catch(()=>{});
    render();renderDash();
  });
}

// ════════════════════════════════════════
// CICLOS
// ════════════════════════════════════════
function openCycleModal(id=null){editingCycleId=id;const c=id?cycles.find(c=>c.id===id):null;document.getElementById('cycle-modal-title').textContent=id?'Editar ciclo':'Novo ciclo';document.getElementById('cycle-name').value=c?.name||'';document.getElementById('cycle-desc').value=c?.desc||'';document.getElementById('cycle-start').value=c?.startDate||dateStr(new Date());document.getElementById('cycle-end').value=c?.endDate||'';document.getElementById('cycle-icon').value=c?.icon||'🎸';openModal('cycle-modal');}
async function saveCycle(){const name=document.getElementById('cycle-name').value.trim();if(!name){showToast('Informe o nome.','info');return;}const cycle={id:editingCycleId||`cy-${Date.now()}`,name,desc:document.getElementById('cycle-desc').value.trim(),startDate:document.getElementById('cycle-start').value,endDate:document.getElementById('cycle-end').value||null,icon:document.getElementById('cycle-icon').value,status:editingCycleId?cycles.find(c=>c.id===editingCycleId)?.status:'active',createdAt:editingCycleId?cycles.find(c=>c.id===editingCycleId)?.createdAt:dateStr(new Date())};const idx=cycles.findIndex(c=>c.id===cycle.id);if(idx>-1)cycles[idx]=cycle;else{cycles.forEach(c=>{if(c.status==='active'){c.status='paused';syncCycle(c);}});cycles.unshift(cycle);activeCycleId=cycle.id;}await syncCycle(cycle);closeModal('cycle-modal');showToast(`Ciclo "${name}" ${editingCycleId?'atualizado':'criado'}!`,'success');renderCycles();renderDash();renderBoardCycleTag();}
async function activateCycle(id){cycles.forEach(c=>{if(c.status==='active'){c.status='paused';syncCycle(c);}});const c=cycles.find(c=>c.id===id);if(!c)return;c.status='active';activeCycleId=id;await syncCycle(c);showToast(`Ciclo "${c.name}" ativado!`,'success');renderCycles();renderDash();renderBoardCycleTag();}
async function closeCycle(id){
  const pendingGoals = Store.get('goals').filter(g=>!g.done && Store.get('exercises').find(e=>e.id===g.exId&&e.cycleId===id));
  const msg = pendingGoals.length
    ? `Encerrar este ciclo?<br><span style="font-size:12px;font-weight:400;color:var(--danger)">⚠️ Há ${pendingGoals.length} meta${pendingGoals.length>1?'s':''} pendente${pendingGoals.length>1?'s':''} neste ciclo.</span>`
    : 'Encerrar este ciclo? Ele será arquivado.';
  showConfirm(msg, async()=>{const c=cycles.find(c=>c.id===id);if(!c)return;c.status='archived';c.endedAt=dateStr(new Date());if(activeCycleId===id)activeCycleId=null;await syncCycle(c);showToast(`Ciclo encerrado e arquivado.`,'info');renderCycles();renderDash();renderBoardCycleTag();});}
async function deleteCycle(id){showConfirm('Excluir este ciclo permanentemente?',async()=>{cycles=cycles.filter(c=>c.id!==id);if(activeCycleId===id)activeCycleId=null;await FB.del(`cycles/${id}`).catch(()=>{});saveAll();showToast('Ciclo excluído.','info');renderCycles();renderDash();});}

function renderCycles(){
  const el=document.getElementById('cycles-list');
  if(!cycles.length){el.innerHTML=`<div class="cycle-empty">
  <div style="font-size:32px;margin-bottom:10px">📚</div>
  <div style="font-weight:700;font-size:15px;color:var(--text);margin-bottom:8px">Nenhum ciclo criado ainda</div>
  <div style="max-width:320px;margin:0 auto;line-height:1.8">
    Um <strong>ciclo</strong> é uma fase do seu estudo.<br>
    Exemplos: <em>"Fundamentos"</em>, <em>"Técnica Blues"</em>, <em>"Fingerpicking"</em>.<br><br>
    Ao criar um ciclo, todos os exercícios que você adicionar ao <strong>Quadro</strong> entram nele automaticamente.
  </div>
  <button class="btn pri" style="margin-top:16px" onclick="openCycleModal()">+ Criar meu primeiro ciclo</button>
</div>`;return;}
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
function agendaWeek(d){agendaOffset+=d;LS.set('gs-agenda-offset',agendaOffset);renderAgenda();}
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
function openGoalModal(id=null){editingGoalId=id;const g=id?goals.find(g=>g.id===id):null;document.getElementById('goal-modal-title').textContent=id?'Editar meta':'Nova meta';const sel=document.getElementById('goal-ex-sel');sel.innerHTML=`<option value="">Selecione...</option>`+exercises.map(e=>`<option value="${e.id}">${e.name}</option>`).join('');document.getElementById('goal-ex-sel').value=g?.exId||'';document.getElementById('goal-desc').value=g?.desc||'';document.getElementById('goal-date').value=g?.deadline||'';document.getElementById('goal-bpm').value=g?.bpmTarget||'';openModal('goal-modal');}
async function saveGoal(){const exId=parseInt(document.getElementById('goal-ex-sel').value),deadline=document.getElementById('goal-date').value;if(!exId||!deadline){showToast('Selecione exercício e data.','info');return;}const goal={id:editingGoalId||Date.now(),exId,desc:document.getElementById('goal-desc').value.trim(),deadline,bpmTarget:parseInt(document.getElementById('goal-bpm').value)||null,done:false,createdAt:dateStr(new Date())};const idx=goals.findIndex(g=>g.id===goal.id);if(idx>-1)goals[idx]=goal;else goals.push(goal);await syncGoal(goal);closeModal('goal-modal');showToast('Meta salva!','success');renderGoals();renderDash();}
async function completeGoal(id){const g=goals.find(g=>g.id===id);if(!g)return;g.done=true;await syncGoal(g);showToast('Meta concluída! 🎉','success');renderGoals();renderDash();}
async function deleteGoal(id){if(!confirm('Excluir meta?'))return;goals=goals.filter(g=>g.id!==id);await FB.del(`goals/${id}`).catch(()=>{});saveAll();showToast('Meta excluída.','info');renderGoals();renderDash();}

function renderGoals(){
  const list=document.getElementById('goals-list');
  const filtered=goals.filter(g=>_goalTab==='active'?!g.done:g.done);
  if(!filtered.length){list.innerHTML=`<div class="goal-empty">${_goalTab==='active'?'Nenhuma meta ativa. Crie uma! 🎯':'Nenhuma meta concluída ainda.'}</div>`;return;}
  list.innerHTML=filtered.map(g=>{const ex=exercises.find(e=>e.id===g.exId);const d=diffDays(new Date(),new Date(g.deadline));const isLate=d<0&&!g.done,isWarn=d>=0&&d<=7&&!g.done;const sess=history.filter(h=>h.exId===g.exId&&h.bpm>0).sort((a,b)=>(b.isoDate||b.date||'').localeCompare(a.isoDate||a.date||''));const curBpm=sess.length?sess[0].bpm:0;const pct=g.bpmTarget&&curBpm?Math.min(100,Math.round((curBpm/g.bpmTarget)*100)):0;
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
  if(!history.length)return{current:0,record:0};
  const today=new Date();today.setHours(0,0,0,0);
  const days=new Set(history.map(h=>h.isoDate||(h.date||'').split('/').reverse().join('-')).filter(Boolean));
  let cur=0,i=0;
  while(i<3650){const d=new Date(today);d.setDate(d.getDate()-i);const ds=dateStr(d);if(days.has(ds)){cur++;i++;}else if(i===0){i++;}else break;}
  let con=0,rec=0;[...days].sort().forEach((ds,idx,arr)=>{if(idx===0){con=1;return;}const p=new Date(arr[idx-1]);p.setDate(p.getDate()+1);con=dateStr(p)===ds?con+1:1;rec=Math.max(rec,con);});
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
  const W=400,H=90,P=26,bpms=data.map(d=>d.bpm);
  const rawMin=Math.min(...bpms),rawMax=Math.max(...bpms);
  const minB=rawMin-(rawMax===rawMin?10:5),maxB=rawMax+(rawMax===rawMin?10:5);
  const xS=i=>P+(i/(data.length-1))*(W-P*2),yS=v=>maxB===minB?(H-P)/2:H-P-((v-minB)/(maxB-minB))*(H-P*2);
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
  if(btn){btn.classList.add('on');}
  else{
    // Ao navegar pelo bottom nav, ativa também o botão desktop correspondente
    document.querySelectorAll('.tab').forEach(b=>{
      if(b.getAttribute('onclick')&&b.getAttribute('onclick').includes(`'${tab}'`))b.classList.add('on');
    });
  }
  if(bnavId)document.getElementById(`bnav-${bnavId}`)?.classList.add('on');
  Object.entries(TABS).forEach(([k,id])=>document.getElementById(id).style.display=k===tab?'block':'none');
  if(tab==='dash')   renderDash();
  if(tab==='board')  render();
  if(tab==='cycles') renderCycles();
  if(tab==='agenda') renderAgenda();
  if(tab==='goals')  renderGoals();
  if(tab==='hist')   renderHist();
  if(metroRunning){stopMetro();showToast('Metrônomo pausado.','info',1800);}
  window.scrollTo(0,0);
}