/**
 * 판촉물 관리대장 – 구글 시트 저장소 (Google Apps Script)
 *
 * 사용 방법은 저장소의 README.md 를 보세요.
 * 1) 아래 두 비밀번호를 원하는 값으로 바꿉니다. (이 파일은 강소연 님 구글 계정에만 보관됩니다)
 * 2) 맨 위 메뉴에서 setup 함수를 한 번 실행합니다.
 * 3) [배포] → [새 배포] → 유형 '웹 앱', 실행 계정 '나', 액세스 '모든 사용자' 로 배포합니다.
 */

// ===== 여기 두 비밀번호를 바꾸세요 =====
const TEAM_PASSWORD  = '여기에-팀-비밀번호';
const ADMIN_PASSWORD = '여기에-관리자-비밀번호';
// ======================================

const SHEETS = { items: '품목', inbound: '입고', txns: '출고', settings: '설정', history: '변경이력' };
const ADMIN_ONLY_WRITE = ['items', 'inbound', 'settings'];

function doGet() {
  return out({ ok: true, app: 'promo-ledger' });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (x) { return out({ ok: false, error: 'bad_request' }); }
  if (TEAM_PASSWORD.indexOf('여기에') === 0 || ADMIN_PASSWORD.indexOf('여기에') === 0) {
    return out({ ok: false, error: 'not_configured' });
  }
  const role = req.pw === ADMIN_PASSWORD ? 'admin' : req.pw === TEAM_PASSWORD ? 'team' : null;
  if (!role) return out({ ok: false, error: 'wrong_password' });
  try {
    switch (req.action) {
      case 'login':  return out({ ok: true, role: role });
      case 'load':   return out({ ok: true, role: role, data: loadAll(role) });
      case 'set':    return out(withLock(function () { return doSet(role, req); }));
      case 'delete': return out(withLock(function () { return doDelete(role, req); }));
      default:       return out({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    return out({ ok: false, error: String((err && err.message) || err) });
  }
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function sheetFor(col) {
  const name = SHEETS[col];
  if (!name) throw new Error('unknown_collection');
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1).setValue('id').setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function headers(sh) {
  return sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String);
}

function readAll(col) {
  const sh = sheetFor(col);
  const h = headers(sh);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const vals = sh.getRange(2, 1, n, h.length).getValues();
  const tz = Session.getScriptTimeZone();
  return vals.filter(function (r) { return r[0] !== ''; }).map(function (r) {
    const o = {};
    h.forEach(function (k, i) {
      let v = r[i];
      if (k === '' || v === '') return;
      if (v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
      if (typeof v === 'string' && (v.charAt(0) === '[' || v.charAt(0) === '{')) {
        try { v = JSON.parse(v); } catch (x) {}
      }
      o[k] = v;
    });
    o.id = String(o.id);
    return o;
  });
}

function loadAll(role) {
  return {
    items: readAll('items'),
    inbound: readAll('inbound'),
    txns: readAll('txns'),
    settings: readAll('settings'),
    history: role === 'admin' ? readAll('history') : []
  };
}

function checkWrite(role, col) {
  if (!SHEETS[col]) throw new Error('unknown_collection');
  if (ADMIN_ONLY_WRITE.indexOf(col) >= 0 && role !== 'admin') throw new Error('forbidden');
}

function enc(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return String(v);
  return v;
}

function newId() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 20);
}

function findRow(sh, id) {
  const last = sh.getLastRow();
  if (last < 2) return -1;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === id) return i + 2;
  return -1;
}

function doSet(role, req) {
  const col = req.col;
  checkWrite(role, col);
  const data = req.data || {};
  const id = String(req.id || data.id || newId());
  const sh = sheetFor(col);
  const h = headers(sh);
  Object.keys(data).forEach(function (k) {
    if (k !== 'id' && h.indexOf(k) < 0) {
      sh.getRange(1, h.length + 1).setValue(k).setFontWeight('bold');
      h.push(k);
    }
  });
  let row = findRow(sh, id);
  if (col === 'history' && row > 0) throw new Error('forbidden');
  if (row < 0) row = sh.getLastRow() + 1;
  const vals = h.map(function (k) { return k === 'id' ? id : (k in data ? enc(data[k]) : ''); });
  const fmts = vals.map(function (v) { return typeof v === 'number' ? '0.##########' : '@'; });
  const range = sh.getRange(row, 1, 1, h.length);
  range.setNumberFormats([fmts]);
  range.setValues([vals]);
  return { ok: true, id: id };
}

function doDelete(role, req) {
  const col = req.col;
  checkWrite(role, col);
  if (col === 'history') throw new Error('forbidden');
  const sh = sheetFor(col);
  const row = findRow(sh, String(req.id));
  if (row > 0) sh.deleteRow(row);
  return { ok: true };
}

/** 처음 한 번만 실행: 시트를 만들고 기존 데이터를 옮겨 넣습니다. */
function setup() {
  Object.keys(SHEETS).forEach(sheetFor);
  const seed = {
    items: [
      { id: 'bjhbepc3hr511zvumwhx', name: '와인', price: 50000, components: '상자', note: '', createdAt: 1795326980959, createdBy: '강소연' },
      { id: 'jp1vnaxscouryshq9zc6', name: '바이레도 핸드크림', price: 30000, components: '종이백', note: '', createdAt: 1795327315537, createdBy: '강소연' },
      { id: 'le32apk4xtv62s7wq7c7', name: '텀블러', price: 45000, components: '없음', note: '', createdAt: 1795326766682, createdBy: '강소연' },
      { id: 'oolao9q3he9tda2m7v1z', name: '화장품', price: 40000, components: '종이백', note: '', createdAt: 1795326791510, createdBy: '강소연' }
    ],
    inbound: [
      { id: '8axskwvp62j85hed58c4', type: 'in', date: '2026-11-22', itemId: 'bjhbepc3hr511zvumwhx', itemName: '와인', qty: 20, price: 50000, kind: '신규 구매', components: '상자', person: '강소연', memo: '', createdAt: 1795326981261, createdBy: '강소연' },
      { id: 'dyly93hsa6x2j19epi9m', type: 'in', date: '2026-11-23', itemId: 'le32apk4xtv62s7wq7c7', itemName: '텀블러', qty: 10, price: 45000, kind: '신규 구매', components: '없음', person: '강소연', memo: '', createdAt: 1795326767048, createdBy: '강소연' },
      { id: 'gzm3fama6pyjk1riu6lj', type: 'in', date: '2026-11-25', itemId: 'oolao9q3he9tda2m7v1z', itemName: '화장품', qty: 5, price: 40000, kind: '신규 구매', components: '종이백', person: '강소연', memo: '', createdAt: 1795326791805, createdBy: '강소연' },
      { id: 'quptlv61ajz0q54p1fjx', type: 'in', date: '2026-11-24', itemId: 'jp1vnaxscouryshq9zc6', itemName: '바이레도 핸드크림', qty: 10, price: 30000, kind: '신규 구매', components: '종이백', person: '강소연', memo: '집시워터 : 상큼, 발랄 향', createdAt: 1795327315857, createdBy: '강소연' }
    ],
    txns: [
      { id: '8ggq175em3oot4udloou', type: 'out', date: '2026-11-23', itemId: 'bjhbepc3hr511zvumwhx', itemName: '와인', qty: 1, price: 50000, kind: '고객사 제공', partner: '카카오', contact: '홍길동', person: '강소연', memo: '', createdAt: 1795327162349, createdBy: '강소연' },
      { id: 'jmo5p89lbkmegxvq0jmc', type: 'out', date: '2026-11-24', itemId: 'le32apk4xtv62s7wq7c7', itemName: '텀블러', qty: 1, price: 45000, kind: '내부 사용', partner: '가비아', contact: '', person: '임영택', memo: '', createdAt: 1795327179326, createdBy: '강소연' },
      { id: 'tff5ui3xgfx940fldey6', type: 'out', date: '2026-10-21', itemId: 'jp1vnaxscouryshq9zc6', itemName: '바이레도 핸드크림', qty: 1, price: 30000, kind: '고객사 제공', partner: 'ㅇㅇ', contact: '', person: '임영택', memo: '', createdAt: 1795327847277, createdBy: '강소연' }
    ],
    settings: [
      { id: 'staff', names: ['이성우', '이상윤', '임영택', '전성민', '강소연', '류승백', '이정환', '박은경', '전승규', '정예진'], updatedAt: 1795328400000 }
    ]
  };
  Object.keys(seed).forEach(function (col) {
    if (readAll(col).length) return; // 이미 데이터가 있으면 건너뜀
    seed[col].forEach(function (o) { doSet('admin', { col: col, id: o.id, data: o }); });
  });
  SpreadsheetApp.getActive().toast('준비 완료! 이제 [배포] → [새 배포] 를 진행하세요.');
}
