// Переносит встроенный набор данных из admin/index.html в Firestore (один раз) и задаёт адрес сервера
const admin = require('firebase-admin');
const fs = require('fs');
admin.initializeApp();
const db = admin.firestore();
(async () => {
  const html = fs.readFileSync('admin/index.html', 'utf8');
  const m = html.match(/const SEED = (\{[\s\S]*?\n\});\n/);
  if (!m) throw new Error('SEED не найден в admin/index.html');
  const SEED = new Function('return ' + m[1])();
  const authUrl = process.env.AUTH_URL || '';
  const companyRef = db.doc('companies/hedera');
  const cs = await companyRef.get();
  const company = Object.assign({}, SEED.company, cs.exists ? cs.data() : {}, authUrl ? { authUrl } : {}, { updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  await companyRef.set(company, { merge: true });
  for (const dir of ['lawn', 'topiary']) {
    const ref = db.doc(`companies/hedera/directions/${dir}`);
    const ex = await ref.get();
    if (ex.exists && ex.data().schedule && Object.values(ex.data().schedule).some(s => (s.clients || []).length)) { console.log(dir, 'уже заполнен — не трогаю'); }
    else {
      const d = JSON.parse(JSON.stringify(SEED[dir])); const prices = d.prices || {}; delete d.prices;
      await ref.set(Object.assign(d, { updatedAt: admin.firestore.FieldValue.serverTimestamp() }), { merge: true });
      await db.doc(`companies/hedera/directions/${dir}/private/prices`).set({ prices, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      console.log(dir, 'загружен');
    }
  }
  console.log('готово; authUrl =', authUrl || '(не задан)');
})().catch(e => { console.error(e); process.exit(1); });
