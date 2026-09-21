// ============================================================
// HEDERA · Голосовой помощник бригады и диспетчера
// Telegram-бот (webhook) → распознавание речи + разбор смысла (Gemini) → Firestore
// Точка входа: bot        Среда: Node.js 20        Проект Firebase: hedera-lawn
// Переменные окружения: BOT_TOKEN, GEMINI_KEY, [GEMINI_MODEL], [WEBHOOK_SECRET], [HUB_URL]
// ============================================================
const admin = require('firebase-admin');
const crypto = require('crypto');
admin.initializeApp();
const db = admin.firestore();
const { FieldPath, FieldValue } = admin.firestore;

const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const HUB_URL = process.env.HUB_URL || 'https://dnestreanschiialexei-cell.github.io/hg-lawn/';
const TZ = 'Europe/Chisinau';
const COMPANY_ID = 'hedera';
const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const DIRS = {
  lawn:    { users: 'users',         history: 'history',         shared: 'state/shared',   name: 'Газон' },
  topiary: { users: 'topiary_users', history: 'topiary_history', shared: 'topiary/shared', name: 'Топиар' },
};
const visitsCol = (dir) => db.collection(`companies/${COMPANY_ID}/directions/${dir}/visits`);
const visitDocId = (week, key) => (week + '__' + key).replace(/\//g, '-');

// ---------- Тексты ответов бота (ru / ro / en) ----------
const T = {
  ru: { start: 'Привет! Я помощник Hedera Garden.\n\n🎤 Зажми микрофон и скажи, что сделано: «Кобан готово, всё сделали».\n🚫 Или что не получилось: «У Мырзы не косили — дождь».\n\nЯ покажу карточку, ты подтвердишь одной кнопкой.', open: 'Открыть приложение',
        noUser: 'Сначала открой приложение и выбери свою машину — тогда я буду знать, чьи объекты записывать.', noCfg: 'Настройки компании ещё не загружены в базу. Диспетчер: хаб → ⚙ Настройки → «Загрузить данные Hedera».',
        thinking: '🎧 Слушаю…', unknown: 'Не понял, о каком объекте речь. Скажи имя клиента как в маршруте, например: «Кобан готово».', confirm: 'Верно?', ok: '✅ Подтвердить', no: '✏️ Не то',
        saved: '✅ Записано', cancelled: 'Отменил. Скажи ещё раз или напиши текстом.', expired: 'Эта карточка устарела — скажи ещё раз.', error: 'Что-то пошло не так, попробуй ещё раз.',
        done: 'готово', skip: 'пропущен', note: 'заметка', tasks: 'задачи', transfer: 'перенос', free: 'бесплатно на этой неделе', clientNote: 'заметка бригаде', heard: 'Услышал' },
  ro: { start: 'Salut! Sunt asistentul Hedera Garden.\n\n🎤 Ține microfonul și spune ce ai făcut: «Koban gata, totul făcut».\n🚫 Sau ce nu a mers: «La Mîrza nu am cosit — ploaie».\n\nÎți arăt o fișă, confirmi cu un buton.', open: 'Deschide aplicația',
        noUser: 'Deschide întâi aplicația și alege mașina ta — atunci știu ce obiecte să notez.', noCfg: 'Setările companiei nu sunt încărcate în bază. Dispecer: hub → ⚙ Setări → «Încarcă datele Hedera».',
        thinking: '🎧 Ascult…', unknown: 'Nu am înțeles despre ce obiect e vorba. Spune numele clientului ca în traseu, de ex.: «Koban gata».', confirm: 'Corect?', ok: '✅ Confirm', no: '✏️ Nu e asta',
        saved: '✅ Notat', cancelled: 'Anulat. Spune încă o dată sau scrie text.', expired: 'Fișa a expirat — spune încă o dată.', error: 'Ceva n-a mers, mai încearcă.',
        done: 'gata', skip: 'omis', note: 'notă', tasks: 'sarcini', transfer: 'transfer', free: 'gratuit săptămâna aceasta', clientNote: 'notă pentru echipă', heard: 'Am auzit' },
  en: { start: "Hi! I'm the Hedera Garden assistant.\n\n🎤 Hold the mic and say what's done: \"Koban done, all tasks\".\n🚫 Or what didn't work: \"Myrza not mowed — rain\".\n\nI'll show a card, you confirm with one tap.", open: 'Open the app',
        noUser: 'Open the app first and pick your crew — then I know whose jobs to record.', noCfg: 'Company settings are not loaded yet. Dispatcher: hub → ⚙ Settings → “Load Hedera data”.',
        thinking: '🎧 Listening…', unknown: "Couldn't tell which job you mean. Say the client's name as in the route, e.g. \"Koban done\".", confirm: 'Correct?', ok: '✅ Confirm', no: '✏️ Not that',
        saved: '✅ Saved', cancelled: 'Cancelled. Say it again or type it.', expired: 'This card expired — say it again.', error: 'Something went wrong, try again.',
        done: 'done', skip: 'skipped', note: 'note', tasks: 'tasks', transfer: 'transfer', free: 'free this week', clientNote: 'note to crew', heard: 'Heard' },
};
const L = (lang) => T[lang] || T.ru;


// ============================================================
// ПРОВЕРКА ПОДПИСИ TELEGRAM → Firebase custom token с ролью
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// ============================================================
const AUTH_MAX_AGE_SEC = 3 * 24 * 3600;
function verifyInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash'); if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const authDate = +params.get('auth_date') || 0;
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > AUTH_MAX_AGE_SEC) return null;
  try { return JSON.parse(params.get('user') || 'null'); } catch (e) { return null; }
}
async function rolesFor(tgId) {
  const roles = {}; let clientName = '';
  for (const [dir, c] of Object.entries(DIRS)) {
    const s = await db.collection(c.users).doc(String(tgId)).get();
    if (s.exists && s.data().role && s.data().active !== false) { roles[dir] = String(s.data().role); if (s.data().role === 'client') clientName = s.data().clientName || clientName; }
  }
  return { roles, clientName };
}
async function handleAuth(req, res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const { initData } = req.body || {};
    const user = initData ? verifyInitData(initData) : null;
    if (!user || !user.id) { res.status(401).json({ error: 'bad_signature' }); return; }
    const tgId = String(user.id);
    const { roles, clientName } = await rolesFor(tgId);
    const claims = { tg: true, tgId, company: COMPANY_ID, roles };
    if (clientName) claims.clientName = clientName;
    const token = await admin.auth().createCustomToken('tg:' + tgId, claims);
    res.json({ token, claims, name: ((user.first_name || '') + ' ' + (user.last_name || '')).trim() });
  } catch (e) {
    console.error('auth', e);
    res.status(500).json({ error: String(e && e.message || e) });
  }
}


// ============================================================
// САМОНАСТРОЙКА: адрес сервера в настройках компании, вебхук бота, публикация правил
// ============================================================
const STORAGE_BUCKET = process.env.STORAGE_BUCKET || 'hedera-lawn.firebasestorage.app';
const FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // ---------- кто это ----------
    function tg() { return request.auth != null && request.auth.token.tg == true; }          // личность подтверждена сервером
    function roles() { return ('roles' in request.auth.token) ? request.auth.token.roles : {}; }
    function role(d) { return (d in roles()) ? roles()[d] : ''; }
    function isDisp() { return tg() && (role('lawn') == 'disp' || role('topiary') == 'disp'); }
    function isStaff() { return tg() && ((role('lawn') != '' && role('lawn') != 'client') || (role('topiary') != '' && role('topiary') != 'client')); }
    function isClient() { return tg() && !isStaff() && (role('lawn') == 'client' || role('topiary') == 'client'); }
    function myClientName() { return ('clientName' in request.auth.token) ? request.auth.token.clientName : '__none__'; }
    function isSelf(uid) { return tg() && request.auth.token.tgId == uid; }

    // ---------- компания ----------
    // Открытая часть настроек (название, направления, адрес сервера): читает любой вошедший, меняет диспетчер
    match /companies/{cid} {
      allow read: if request.auth != null;
      allow write: if isDisp();
    }
    // График, чек-листы, бригады — сотрудники читают, диспетчер меняет
    match /companies/{cid}/directions/{dir} {
      allow read: if isStaff();
      allow write: if isDisp();
    }
    // Цены — только диспетчер
    match /companies/{cid}/directions/{dir}/private/{doc} {
      allow read, write: if isDisp();
    }
    // Выезды — отдельные документы; клиент видит только свои
    match /companies/{cid}/directions/{dir}/visits/{v} {
      allow read: if isStaff() || (isClient() && resource.data.clientName == myClientName());
      allow write: if isStaff();
    }

    // ---------- роли ----------
    // Сотрудник может создать только свою запись и не может назначить себя диспетчером
    match /users/{uid} {
      allow read: if isStaff() || isSelf(uid);
      allow create: if isDisp() || (isSelf(uid) && request.resource.data.role != 'disp');
      allow update: if isDisp() || (isSelf(uid) && request.resource.data.role == resource.data.role);
      allow delete: if isDisp();
    }
    match /topiary_users/{uid} {
      allow read: if isStaff() || isSelf(uid);
      allow create: if isDisp() || (isSelf(uid) && request.resource.data.role != 'disp');
      allow update: if isDisp() || (isSelf(uid) && request.resource.data.role == resource.data.role);
      allow delete: if isDisp();
    }

    // ---------- общие рабочие документы (переносы, срочные, заправки, заметки) ----------
    match /state/{doc}   { allow read, write: if isStaff(); }
    match /topiary/{doc} { allow read, write: if isStaff(); }

    // ---------- старая история (до перехода на выезды) ----------
    match /history/{h}         { allow read: if isStaff() || (isClient() && resource.data.clientName == myClientName()); allow write: if isStaff(); }
    match /topiary_history/{h} { allow read: if isStaff() || (isClient() && resource.data.clientName == myClientName()); allow write: if isStaff(); }

    // ---------- приглашения клиентов: создаёт диспетчер, читает тот, кто открыл ссылку ----------
    match /invites/{t}         { allow read: if tg(); allow write: if isDisp(); }
    match /topiary_invites/{t} { allow read: if tg(); allow write: if isDisp(); }

    // ---------- сообщения и заявки ----------
    match /client_messages/{m}  { allow create: if tg(); allow read, update: if isStaff(); }
    match /client_requests/{m}  { allow create: if tg(); allow read, update: if isStaff(); }
    match /topiary_messages/{m} { allow create: if tg(); allow read, update: if isStaff(); }
    match /topiary_requests/{m} { allow create: if tg(); allow read, update: if isStaff(); }
    match /office_messages/{m}         { allow create: if isStaff(); allow read, update: if isDisp(); }
    match /topiary_office_messages/{m} { allow create: if isStaff(); allow read, update: if isDisp(); }

    // Только сервер (бот) — приложению сюда доступа нет
    match /voice_pending/{p} { allow read, write: if false; }
  }
}
`;
const STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function tg() { return request.auth != null && request.auth.token.tg == true; }
    function roles() { return ('roles' in request.auth.token) ? request.auth.token.roles : {}; }
    function role(d) { return (d in roles()) ? roles()[d] : ''; }
    function isStaff() { return tg() && ((role('lawn') != '' && role('lawn') != 'client') || (role('topiary') != '' && role('topiary') != 'client')); }
    // Фото и видео выездов: загружают сотрудники, размер до 25 МБ, только изображения и видео
    match /{allPaths=**} {
      allow read: if tg();
      allow write: if isStaff() && request.resource.size < 25 * 1024 * 1024
                   && (request.resource.contentType.matches('image/.*') || request.resource.contentType.matches('video/.*'));
    }
  }
}
`;
let _selfDone = false;
function ownUrl(req) { const host = req.get('x-forwarded-host') || req.get('host'); return host ? `https://${host}` : ''; }
async function selfRegister(req) {
  if (_selfDone) return; _selfDone = true;
  const url = ownUrl(req); if (!url) return;
  try {
    const ref = db.doc(`companies/${COMPANY_ID}`);
    const s = await ref.get();
    if (!s.exists || s.data().authUrl !== url) await ref.set({ authUrl: url }, { merge: true });
  } catch (e) { console.warn('selfRegister company', e.message); }
  try {
    if (BOT_TOKEN) {
      const info = await TG('getWebhookInfo', {});
      if (!info.ok || info.result.url !== url) await TG('setWebhook', { url, secret_token: WEBHOOK_SECRET || undefined, allowed_updates: ['message', 'callback_query'] });
    }
  } catch (e) { console.warn('selfRegister webhook', e.message); }
}
async function publishRules() {
  const sr = admin.securityRules();
  await sr.releaseFirestoreRulesetFromSource(FIRESTORE_RULES);
  await sr.releaseStorageRulesetFromSource(STORAGE_RULES, STORAGE_BUCKET);
}
async function handleAdmin(req, res, action) {
  res.set('Access-Control-Allow-Origin', '*'); res.set('Access-Control-Allow-Headers', 'Content-Type'); res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const user = verifyInitData((req.body || {}).initData || '');
    if (!user) { res.status(401).json({ error: 'bad_signature' }); return; }
    const { roles } = await rolesFor(String(user.id));
    if (!Object.values(roles).includes('disp')) { res.status(403).json({ error: 'not_dispatcher' }); return; }
    if (action === 'rules') { await publishRules(); res.json({ ok: true, published: ['firestore', 'storage'] }); return; }
    if (action === 'status') {
      const info = await TG('getWebhookInfo', {});
      res.json({ ok: true, url: ownUrl(req), webhook: info.ok ? info.result.url : null, model: GEMINI_MODEL, hasGemini: !!GEMINI_KEY });
      return;
    }
    res.status(404).json({ error: 'unknown_action' });
  } catch (e) { console.error('admin', e); res.status(500).json({ error: String(e && e.message || e) }); }
}

// ---------- Telegram ----------
const TG = (method, body) => fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }));

async function downloadTelegramFile(fileId) {
  const f = await TG('getFile', { file_id: fileId });
  if (!f.ok) throw new Error('getFile failed: ' + JSON.stringify(f));
  const r = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${f.result.file_path}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return { base64: buf.toString('base64'), path: f.result.file_path };
}

// ---------- Дата и неделя по Кишинёву (совпадает с логикой приложения) ----------
function localParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
function isoWeek(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 3 - (dt.getUTCDay() + 6) % 7);
  const w1 = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  return dt.getUTCFullYear() + '-W' + String(1 + Math.round(((dt - w1) / 86400000 - 3 + (w1.getUTCDay() + 6) % 7) / 7)).padStart(2, '0');
}
function today() {
  const p = localParts();
  return { ...p, idx: p.wd === 0 ? 0 : p.wd - 1, week: isoWeek(p.y, p.m, p.d), dateStr: `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}` };
}

// ---------- Пользователь и контекст ----------
async function findUser(tgId) {
  for (const [dir, c] of Object.entries(DIRS)) {
    const s = await db.collection(c.users).doc(String(tgId)).get();
    if (s.exists && s.data().role && s.data().role !== 'client') return { dir, id: String(tgId), ...s.data() };
  }
  return null;
}
async function loadContext(dir) {
  const cfgSnap = await db.doc(`companies/${COMPANY_ID}/directions/${dir}`).get();
  const sharedSnap = await db.doc(DIRS[dir].shared).get();
  return { cfg: cfgSnap.exists ? cfgSnap.data() : null, shared: sharedSnap.exists ? sharedSnap.data() : {} };
}
// Объекты слота с учётом переносов и срочных — те же ключи визитов, что в приложении
function slotClients(cfg, shared, week, slotKey) {
  const base = ((cfg.schedule || {})[slotKey] || {}).clients || [];
  const removed = (shared.removed || []).filter(r => r.slot === slotKey && r.week === week).map(r => r.n);
  const list = base.filter(c => !removed.includes(c.n)).map(c => ({ key: slotKey + '_' + c.n, slotKey, n: c.n, name: c.name, address: c.address || '', m2: c.m2 || 0, biweekly: (c.conditions || []).some(x => x.type === 'freq') }));
  (shared.transfers || []).filter(t => t.toSlot === slotKey && t.week === week).forEach(t => {
    const c = (((cfg.schedule || {})[t.fromSlot] || {}).clients || []).find(x => x.n === t.n);
    if (c) list.push({ key: t.fromSlot + '_' + t.n, slotKey, n: c.n, name: c.name, address: c.address || '', m2: c.m2 || 0, transferred: true });
  });
  (shared.extras || []).filter(e => e.slot === slotKey && e.week === week).forEach(e => list.push({ key: 'extra_' + slotKey + '_' + e.n, slotKey, n: e.n, name: e.name, address: e.address || '', m2: e.m2 || 0, extra: true }));
  return list;
}
function crews(cfg) { return Object.keys(cfg.brigades || { '1': 1 }).sort((a, b) => (+a) - (+b)); }
function allowedClients(user, ctx, td) {
  const { cfg, shared } = ctx;
  const isDisp = user.role === 'disp';
  const machines = isDisp ? crews(cfg) : [String(user.role)];
  const out = [];
  DAYS.forEach((day, i) => machines.forEach(m => slotClients(cfg, shared, td.week, day + '-' + m).forEach(c => out.push({ ...c, day, crew: m, isToday: i === td.idx }))));
  return out;
}

// ---------- Gemini: аудио/текст → структурированное действие ----------
async function gemini(parts) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.1, response_mime_type: 'application/json' } }),
  });
  const j = await r.json();
  const text = (j?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  try { return JSON.parse(text); } catch (e) { const m = text.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; }
}
function buildPrompt(user, ctx, clients, td) {
  const isDisp = user.role === 'disp';
  const tasks = ctx.cfg.tasks || [];
  const skips = ctx.cfg.skipReasons || [];
  const todayList = clients.filter(c => c.isToday).map(c => `${c.key} | ${c.name} | ${c.address}`).join('\n') || '(сегодня объектов нет)';
  const weekList = clients.filter(c => !c.isToday).map(c => `${c.key} | ${c.day} М${c.crew} | ${c.name}`).join('\n') || '(нет)';
  return `Ты помощник ${isDisp ? 'диспетчера' : 'бригадира'} садовой компании. Сообщение может быть на русском, румынском или английском, имена клиентов — как в списке (возможны искажения и склонения).
Сегодня: ${DAYS[td.idx]} ${td.dateStr}. Верни СТРОГО один JSON-объект без пояснений.

ОБЪЕКТЫ СЕГОДНЯ (key | имя | адрес):
${todayList}

ДРУГИЕ ДНИ ЭТОЙ НЕДЕЛИ (key | день машина | имя):
${weekList}

ЧЕК-ЛИСТ (индексы 0..${tasks.length - 1}): ${tasks.map((t, i) => i + '=' + t).join('; ')}
ПРИЧИНЫ ПРОПУСКА (id=текст): ${skips.map(s => s.id + '=' + s.label).join('; ')}

СХЕМА ОТВЕТА:
{"transcript": "что услышал дословно",
 "reply_language": "ru|ro|en",
 "action": "complete|skip|note|${isDisp ? 'transfer|free|client_note|' : ''}unknown",
 "client_key": "key из списка или null",
 "tasks_done": [true,...] (длина ${tasks.length}; если сказал «всё сделали» — все true; если назвал, что НЕ сделал — те false),
 "note": "краткая заметка своими словами бригадира, без выдумок, или пустая строка",
 "skip_reason_id": "id из причин или null",
 "skip_comment": "уточнение причины или пустая строка",
 ${isDisp ? '"to_day": "Пн|Вт|Ср|Чт|Пт|Сб или null", "to_crew": "номер машины или null",' : ''}
 "confidence": 0.0-1.0}

ПРАВИЛА: «готово/сделали/закончили/gata/done» → complete. «не сделали/не попали/пропустили/дождь/nu am făcut/skipped» → skip с ближайшей причиной. Только замечание без статуса → note.${isDisp ? ' «Перенеси X на четверг вторую машину» → transfer с to_day/to_crew. «X бесплатно / без оплаты на этой неделе» → free. «Передай бригаде у X …» → client_note.' : ''} Если объект не опознан однозначно — client_key null и action unknown. Предпочитай объекты СЕГОДНЯ.`;
}

// ---------- Карточка подтверждения ----------
function describe(a, client, ctx, lang) {
  const t = L(lang); const tasks = ctx.cfg.tasks || [];
  const name = client ? client.name : '—';
  let line;
  if (a.action === 'complete') { const done = (a.tasks_done || []).filter(Boolean).length || tasks.length; line = `✅ ${t.done} · ${t.tasks} ${done}/${tasks.length}`; }
  else if (a.action === 'skip') { const r = (ctx.cfg.skipReasons || []).find(x => x.id === a.skip_reason_id); line = `🔴 ${t.skip} · ${r ? r.label : (a.skip_reason_id || '')}${a.skip_comment ? ' — ' + a.skip_comment : ''}`; }
  else if (a.action === 'note') line = `📝 ${t.note}`;
  else if (a.action === 'transfer') line = `↪ ${t.transfer} → ${a.to_day} · М${a.to_crew}`;
  else if (a.action === 'free') line = `⊘ ${t.free}`;
  else if (a.action === 'client_note') line = `✏️ ${t.clientNote}`;
  else line = '❔';
  return `<b>${escapeHtml(name)}</b>\n${line}${a.note && a.action !== 'client_note' ? '\n📝 ' + escapeHtml(a.note) : ''}${a.action === 'client_note' && a.note ? '\n«' + escapeHtml(a.note) + '»' : ''}\n<i>${t.heard}: ${escapeHtml(a.transcript || '')}</i>`;
}
function escapeHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ---------- Применение действия в Firestore (структура — как у приложения) ----------
async function applyAction(user, ctx, a, client, td) {
  const dir = user.dir; const sharedRef = db.doc(DIRS[dir].shared);
  const tasks = ctx.cfg.tasks || [];
  const week = td.week;

  if (a.action === 'transfer') {
    const toSlot = a.to_day + '-' + a.to_crew;
    const fromSlot = client.key.startsWith('extra_') ? null : client.key.split('_')[0];
    if (!fromSlot) return; // срочные не переносим голосом
    await sharedRef.update({
      removed: FieldValue.arrayUnion({ slot: fromSlot, n: client.n, week }),
      transfers: FieldValue.arrayUnion({ fromSlot, n: client.n, toSlot, comment: 'голосом · ' + (a.note || ''), by: 'disp', week }),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return;
  }
  if (a.action === 'free') {
    await sharedRef.update(new FieldPath('priceOverrides', `${week}_${client.slotKey}_${client.n}`), { type: 'free', amount: 0 }, 'updatedAt', FieldValue.serverTimestamp());
    return;
  }
  if (a.action === 'client_note') {
    await sharedRef.update(new FieldPath('clientNotes', `${client.slotKey}_${client.n}`), a.note || '', 'updatedAt', FieldValue.serverTimestamp());
    return;
  }

  const vref = visitsCol(dir).doc(visitDocId(week, client.key));
  const vsnap = await vref.get();
  const cur = Object.assign({ status: 'planned', tasksDone: tasks.map(() => false), elapsed: 0, photosBefore: [], photosAfter: [] }, vsnap.exists ? vsnap.data() : {});
  if (a.action === 'complete') {
    cur.status = 'done';
    cur.tasksDone = Array.isArray(a.tasks_done) && a.tasks_done.length === tasks.length ? a.tasks_done.map(Boolean) : tasks.map(() => true);
    if (a.note) cur.note = cur.note ? cur.note + ' · ' + a.note : a.note;
    if (cur.timerStart) { cur.elapsed = (cur.elapsed || 0) + Math.floor((Date.now() - cur.timerStart) / 1000); cur.timerStart = null; }
  } else if (a.action === 'skip') {
    cur.status = 'skip';
    cur.skipReason = a.skip_reason_id || 'other';
    const r = (ctx.cfg.skipReasons || []).find(x => x.id === cur.skipReason);
    cur.skipReasonLabel = r ? r.label : (a.skip_reason_id || 'Другое');
    cur.skipComment = a.skip_comment || a.note || '';
    cur.timerStart = null;
  } else if (a.action === 'note') {
    cur.note = cur.note ? cur.note + ' · ' + a.note : (a.note || '');
  }
  if (a.action === 'complete' || a.action === 'skip') { cur.date = td.dateStr; cur.clientName = client.name; cur.m2 = client.m2 || 0; cur.machine = String(user.role); cur.tasksTotal = tasks.length; }
  Object.assign(cur, { week, visitKey: client.key, slotKey: client.slotKey, source: 'voice', voiceBy: user.id, updatedAt: FieldValue.serverTimestamp(), updatedBy: user.id });
  await vref.set(cur, { merge: true });

  if (a.action === 'complete' && client.biweekly) {
    await sharedRef.update(new FieldPath('biweekly', client.name), { lastDoneWeek: week });
  }
}

// ---------- Обработка сообщения ----------
async function handleMessage(msg) {
  const chatId = msg.chat.id; const from = msg.from || {};
  const langGuess = ['ru', 'ro', 'en'].includes((from.language_code || '').slice(0, 2)) ? from.language_code.slice(0, 2) : 'ru';

  if (msg.text && /^\/start/.test(msg.text)) {
    const t = L(langGuess);
    await TG('sendMessage', { chat_id: chatId, text: t.start, reply_markup: { inline_keyboard: [[{ text: t.open, web_app: { url: HUB_URL } }]] } });
    return;
  }
  const user = await findUser(from.id);
  const lang = (user && user.lang) || langGuess; const t = L(lang);
  if (!user) { await TG('sendMessage', { chat_id: chatId, text: t.noUser, reply_markup: { inline_keyboard: [[{ text: t.open, web_app: { url: HUB_URL } }]] } }); return; }

  const media = msg.voice || msg.audio;
  if (!media && !msg.text) return;

  const ctx = await loadContext(user.dir);
  if (!ctx.cfg || !ctx.cfg.schedule) { await TG('sendMessage', { chat_id: chatId, text: t.noCfg }); return; }
  const td = today();
  const clients = allowedClients(user, ctx, td);

  const waiting = await TG('sendMessage', { chat_id: chatId, text: t.thinking });
  const parts = [];
  if (media) {
    const file = await downloadTelegramFile(media.file_id);
    parts.push({ inline_data: { mime_type: media.mime_type || 'audio/ogg', data: file.base64 } });
  } else {
    parts.push({ text: 'ТЕКСТ СООБЩЕНИЯ: ' + msg.text });
  }
  parts.push({ text: buildPrompt(user, ctx, clients, td) });

  let a = null;
  try { a = await gemini(parts); } catch (e) { console.error('gemini', e); }
  const waitId = waiting.ok ? waiting.result.message_id : null;

  if (!a || a.action === 'unknown' || !a.client_key) {
    const txt = t.unknown + (a && a.transcript ? `\n<i>${t.heard}: ${escapeHtml(a.transcript)}</i>` : '');
    if (waitId) await TG('editMessageText', { chat_id: chatId, message_id: waitId, text: txt, parse_mode: 'HTML' }); else await TG('sendMessage', { chat_id: chatId, text: txt, parse_mode: 'HTML' });
    return;
  }
  const client = clients.find(c => c.key === a.client_key);
  if (!client) { await TG('editMessageText', { chat_id: chatId, message_id: waitId, text: t.unknown }); return; }
  if (['transfer', 'free', 'client_note'].includes(a.action) && user.role !== 'disp') a.action = 'note';

  const pending = await db.collection('voice_pending').add({ userId: user.id, dir: user.dir, action: a, client, week: td.week, dateStr: td.dateStr, createdAt: FieldValue.serverTimestamp() });
  const card = describe(a, client, ctx, lang) + `\n\n${t.confirm}`;
  const kb = { inline_keyboard: [[{ text: t.ok, callback_data: 'vok|' + pending.id }, { text: t.no, callback_data: 'vno|' + pending.id }]] };
  if (waitId) await TG('editMessageText', { chat_id: chatId, message_id: waitId, text: card, parse_mode: 'HTML', reply_markup: kb });
  else await TG('sendMessage', { chat_id: chatId, text: card, parse_mode: 'HTML', reply_markup: kb });
}

async function handleCallback(cb) {
  const [cmd, id] = (cb.data || '').split('|');
  const chatId = cb.message.chat.id; const msgId = cb.message.message_id;
  const user = await findUser(cb.from.id);
  const lang = (user && user.lang) || 'ru'; const t = L(lang);
  await TG('answerCallbackQuery', { callback_query_id: cb.id });
  const ref = db.collection('voice_pending').doc(id); const snap = await ref.get();
  if (!snap.exists) { await TG('editMessageText', { chat_id: chatId, message_id: msgId, text: t.expired }); return; }
  const p = snap.data();
  if (cmd === 'vno') { await ref.delete(); await TG('editMessageText', { chat_id: chatId, message_id: msgId, text: t.cancelled }); return; }
  if (!user || user.id !== p.userId) return;
  try {
    const ctx = await loadContext(p.dir);
    await applyAction(user, ctx, p.action, p.client, { week: p.week, dateStr: p.dateStr });
    await ref.delete();
    const original = (cb.message.text || '').split('\n').slice(0, -2).join('\n');
    await TG('editMessageText', { chat_id: chatId, message_id: msgId, text: `${t.saved}\n${escapeHtml(original)}`, parse_mode: 'HTML' });
  } catch (e) { console.error('apply', e); await TG('sendMessage', { chat_id: chatId, text: t.error }); }
}

// ---------- Точка входа (HTTP) ----------
// POST <url>/auth          → проверка Telegram и выдача токена (вызывает приложение)
// POST <url>/admin/rules   → публикация закрытых правил доступа (только диспетчер)
// POST <url>/admin/status  → состояние сервера (только диспетчер)
// POST <url>               → webhook Telegram-бота
exports.bot = async (req, res) => {
  await selfRegister(req);
  const p = (req.path || '').replace(/\/+$/, '');
  if (p.endsWith('/auth')) { await handleAuth(req, res); return; }
  if (p.endsWith('/admin/rules')) { await handleAdmin(req, res, 'rules'); return; }
  if (p.endsWith('/admin/status')) { await handleAdmin(req, res, 'status'); return; }
  try {
    if (WEBHOOK_SECRET && req.get('X-Telegram-Bot-Api-Secret-Token') !== WEBHOOK_SECRET) { res.status(403).send('forbidden'); return; }
    const u = req.body || {};
    if (u.message) await handleMessage(u.message);
    else if (u.callback_query) await handleCallback(u.callback_query);
  } catch (e) { console.error(e); }
  res.status(200).send('ok');
};
