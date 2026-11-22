/* 판촉물 관리대장 – 구글 시트 연결 + 로그인 화면
 * 페이지 코드가 쓰는 저장소·사용자·다운로드 기능을 구글 Apps Script 백엔드로 연결합니다. */
(function () {
  const API = window.PROMO_API_URL;
  const ADMIN = window.PROMO_MODE === 'admin';
  const LS = 'promoLedgerAdmin';
  const PUBLIC_AUTH = { name: '일반 사용자', pw: '', role: 'team' };
  let auth = null;
  if (ADMIN) { try { auth = JSON.parse(localStorage.getItem(LS) || 'null'); } catch (_) {} }
  else auth = PUBLIC_AUTH;
  const saveAuth = a => { auth = a; if (!ADMIN) return; try { a ? localStorage.setItem(LS, JSON.stringify(a)) : localStorage.removeItem(LS); } catch (_) {} };

  async function call(action, extra) {
    if (!API) { const e = new Error('not_configured'); e.code = 'unavailable'; throw e; }
    let j;
    try {
      const res = await fetch(API, { method: 'POST', body: JSON.stringify(Object.assign({ action, pw: auth && auth.pw, name: auth && auth.name }, extra || {})) });
      j = await res.json();
    } catch (x) { const e = new Error('network'); e.code = 'unavailable'; throw e; }
    if (!j.ok) {
      if (j.error === 'wrong_password' && action !== 'login' && ADMIN) { saveAuth(null); location.reload(); }
      const e = new Error(j.error); e.code = j.error === 'forbidden' ? 'invalid_argument' : 'unavailable'; e.raw = j.error; throw e;
    }
    return j;
  }

  /* ---------- 저장소 (페이지의 db 코드와 같은 모양) ---------- */
  const store = { items: [], inbound: [], txns: [], settings: [], history: [] };
  const colL = {}, docL = {};
  let loaded = false, emitT = null;
  const snapDoc = o => ({ id: o.id, exists: true, data: () => Object.assign({}, o) });
  function emit() {
    if (!loaded) return;
    Object.keys(colL).forEach(c => { const docs = (store[c] || []).map(snapDoc); colL[c].forEach(f => f({ docs, size: docs.length, empty: !docs.length })); });
    Object.keys(docL).forEach(p => { const [c, id] = p.split('/'); const o = (store[c] || []).find(x => x.id === id);
      docL[p].forEach(f => f({ id, exists: !!o, data: () => (o ? Object.assign({}, o) : undefined) })); });
  }
  const queueEmit = () => { clearTimeout(emitT); emitT = setTimeout(emit, 0); };
  let loading = null;
  function refresh() {
    if (loading) return loading;
    loading = call('load').then(j => { Object.keys(j.data || {}).forEach(k => { store[k] = j.data[k]; }); loaded = true; emit(); })
      .finally(() => { loading = null; });
    return loading;
  }
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  async function write(action, c, id, data) {
    const clean = data ? JSON.parse(JSON.stringify(data)) : undefined;
    if (clean) delete clean.id;
    await call(action, { col: c, id, data: clean });
    const arr = store[c] || (store[c] = []);
    const i = arr.findIndex(x => x.id === id);
    if (action === 'delete') { if (i >= 0) arr.splice(i, 1); }
    else { const o = Object.assign({}, clean, { id }); if (i >= 0) arr[i] = o; else arr.push(o); }
    emit();
  }
  function collection(path) {
    const q = {
      path,
      orderBy() { return q; }, limit() { return q; }, where() { return q; },
      onSnapshot(cb) { (colL[path] = colL[path] || []).push(cb); queueEmit(); return () => { colL[path] = colL[path].filter(f => f !== cb); }; },
      doc: id => doc(path + '/' + (id || newId())),
      add: async data => { const id = newId(); await write('set', path, id, data); return { id }; },
      get: async () => { const docs = (store[path] || []).map(snapDoc); return { docs, size: docs.length, empty: !docs.length }; }
    };
    return q;
  }
  function doc(p) {
    const [c, id] = p.split('/');
    return {
      id, path: p,
      set: data => write('set', c, id, data),
      update: data => { const o = (store[c] || []).find(x => x.id === id) || {}; return write('set', c, id, Object.assign({}, o, data)); },
      delete: () => write('delete', c, id),
      get: async () => { const o = (store[c] || []).find(x => x.id === id); return { id, exists: !!o, data: () => o }; },
      onSnapshot(cb) { (docL[p] = docL[p] || []).push(cb); queueEmit(); return () => {}; }
    };
  }
  const dbNs = { collection, doc };
  const userNs = {
    me: async () => ({ id: auth.name, name: auth.name }),
    id: async () => auth.name,
    isOwner: async () => auth.role === 'admin',
    canEdit: async () => auth.role === 'admin',
    can: async () => true,
    profiles: async ids => Object.fromEntries((ids || []).map(i => [i, { id: i, name: i }]))
  };
  const downloadsNs = {
    save: async ({ filename, data }) => {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return { status: 'saved' };
    }
  };

  let readyResolve; const ready = new Promise(r => { readyResolve = r; });
  window.claude = { use: async name => { await ready; return { db: dbNs, user: userNs, downloads: downloadsNs }[name] || null; } };

  /* ---------- 관리자 로그인 화면 ---------- */
  function loginScreen() {
    const wrap = document.createElement('div');
    wrap.id = 'loginGate';
    wrap.innerHTML = `
      <form class="login-card" id="loginForm" autocomplete="on">
        <h1>관리자 로그인</h1>
        <p class="hint">입고 등록·수정, 출고자 명단, 변경 이력은 관리자만 볼 수 있습니다.</p>
        <input type="text" name="username" value="admin" autocomplete="username" hidden>
        <label>관리자 비밀번호<input id="loginPw" type="password" required autocomplete="current-password"></label>
        <span class="hint err" id="loginErr"></span>
        <button class="btn primary" type="submit" id="loginBtn">들어가기</button>
        <a class="hint" href="./" style="text-align:center">← 일반 화면으로 돌아가기</a>
      </form>`;
    document.body.appendChild(wrap);
    wrap.querySelector('#loginPw').focus();
    if (!API) { wrap.querySelector('#loginErr').textContent = '구글 시트 주소(config.js)가 설정되지 않았습니다.'; wrap.querySelector('#loginBtn').disabled = true; }
    wrap.querySelector('#loginForm').onsubmit = async e => {
      e.preventDefault();
      const pw = wrap.querySelector('#loginPw').value;
      const err = wrap.querySelector('#loginErr'), btn = wrap.querySelector('#loginBtn');
      btn.disabled = true; btn.textContent = '확인 중…'; err.textContent = '';
      try {
        saveAuth({ name: '관리자', pw });
        const j = await call('login');
        if (j.role !== 'admin') { const x = new Error('wrong_password'); x.raw = 'wrong_password'; throw x; }
        saveAuth({ name: '관리자', pw, role: 'admin' });
        wrap.remove(); start();
      } catch (x) {
        saveAuth(null);
        err.textContent = x.raw === 'wrong_password' ? '관리자 비밀번호가 맞지 않습니다.' : x.raw === 'not_configured' ? '구글 시트 쪽 비밀번호가 아직 설정되지 않았습니다.' : '연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요.';
        btn.disabled = false; btn.textContent = '들어가기';
      }
    };
  }

  function addHeaderControls() {
    const hrow = document.querySelector('.hrow');
    if (!hrow || document.getElementById('whoBox')) return;
    const box = document.createElement('div');
    box.id = 'whoBox'; box.className = 'who';
    box.innerHTML = ADMIN
      ? `<span class="pill warn">관리자 모드</span><a class="btn sm" href="./">일반 화면</a><button type="button" class="btn sm" id="btnLogout">로그아웃</button>`
      : `<a class="btn sm" href="admin.html">관리자</a>`;
    hrow.insertBefore(box, document.getElementById('btnExport'));
    const lo = box.querySelector('#btnLogout');
    if (lo) lo.onclick = () => { saveAuth(null); location.href = './'; };
  }

  function banner(msg) {
    let b = document.getElementById('apiBanner');
    if (!b) { b = document.createElement('div'); b.id = 'apiBanner'; b.className = 'wrap hint err'; b.style.paddingBlock = '10px';
      const h = document.querySelector('header'); h && h.after(b); }
    b.textContent = msg;
  }

  async function start() {
    addHeaderControls();
    try { await refresh(); }
    catch (x) { banner(x && x.raw === 'wrong_password' ? '구글 시트 코드가 아직 로그인 없는 방식으로 업데이트되지 않았습니다. 관리자에게 알려주세요.' : '데이터를 불러오지 못했습니다. 잠시 후 새로고침해 주세요.'); }
    readyResolve();
    setInterval(() => { if (document.visibilityState === 'visible') refresh().catch(() => {}); }, 20000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh().catch(() => {}); });
  }

  document.addEventListener('DOMContentLoaded', () => { if (!ADMIN || (auth && auth.pw && auth.role === 'admin')) start(); else loginScreen(); });
})();
