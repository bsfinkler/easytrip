// Endpoint ADMIN protegido — reconcilia o Pro de um usuário pelo e-mail.
// Uso: GET /api/admin-reconcile?email=<email>&secret=<token>
//
// Para que serve: se um pagamento aprovado não virou Pro (webhook não disparou,
// retorno não rodou, falha transitória), isto acha o pagamento no Mercado Pago
// (e no nosso histórico) e libera o Pro usando a MESMA função idempotente do
// webhook/activate. Reprocessar é seguro.
//
// Segurança: exige um token cujo SHA-256 bate com SECRET_SHA256 abaixo. Sem o
// token correto → 403. Usa SUPABASE_SERVICE_ROLE_KEY e MP_ACCESS_TOKEN (env).

import crypto from 'node:crypto';
import { grantFromPayment } from '../lib/grant-pro.js';

// SHA-256 do token de uso único (o token em si nunca fica no código).
const SECRET_SHA256 = '9a5ba93422dcf07a8b32aae6be628a79b70777357ab98cb0f316b10cd83c87b3';

async function supaFetch(path) {
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(base + path, {
    headers: { 'apikey': key, 'Authorization': 'Bearer ' + key },
  });
  if (!res.ok) throw new Error('Supabase ' + path + ' (' + res.status + '): ' + (await res.text()));
  return res.json();
}

// Varre pagamentos recentes do MP e devolve os que pertencem ao userId.
async function mpPaymentIdsForUser(userId) {
  const end = new Date();
  const begin = new Date(Date.now() - 30 * 86400000); // últimos 30 dias
  const url = 'https://api.mercadopago.com/v1/payments/search'
    + '?sort=date_created&criteria=desc&range=date_created'
    + '&begin_date=' + encodeURIComponent(begin.toISOString())
    + '&end_date=' + encodeURIComponent(end.toISOString())
    + '&limit=200';
  const res = await fetch(url, {
    headers: { 'Authorization': 'Bearer ' + process.env.MP_ACCESS_TOKEN },
  });
  if (!res.ok) throw new Error('MP search (' + res.status + '): ' + (await res.text()));
  const data = await res.json();
  const ids = [];
  for (const p of (data.results || [])) {
    const md = p.metadata || {};
    const ext = p.external_reference || '';
    const uid = md.user_id || (ext ? ext.split('|')[0] : null);
    if (uid === userId && p.id != null) ids.push(String(p.id));
  }
  return ids;
}

export default async function handler(req, res) {
  const q = req.query || {};
  const provided = String(q.secret || '');
  const hash = crypto.createHash('sha256').update(provided).digest('hex');
  if (!provided || hash !== SECRET_SHA256) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const email = String(q.email || '').trim();
  if (!email) return res.status(400).json({ error: 'email obrigatório' });

  if (!process.env.MP_ACCESS_TOKEN || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'env ausente (MP/Supabase)' });
  }

  try {
    // 1) email → user_id (case-insensitive)
    const profiles = await supaFetch(
      '/rest/v1/profiles?select=id,email&email=ilike.' + encodeURIComponent(email)
    );
    if (!profiles.length) {
      return res.status(404).json({ error: 'usuário não encontrado em profiles', email });
    }
    const userId = profiles[0].id;

    // 2) candidatos: ids já no nosso histórico + varredura recente no MP
    const candidates = new Set();
    const subs = await supaFetch(
      '/rest/v1/subscriptions?select=mp_payment_id,status,plan,created_at&user_id=eq.'
      + userId + '&order=created_at.desc'
    );
    for (const s of subs) if (s.mp_payment_id) candidates.add(String(s.mp_payment_id));

    let mpError = null;
    try {
      for (const id of await mpPaymentIdsForUser(userId)) candidates.add(id);
    } catch (e) { mpError = e.message; }

    // 3) reprocessa cada candidato (idempotente)
    const report = [];
    for (const id of candidates) {
      try { report.push({ id, ...(await grantFromPayment(id)) }); }
      catch (e) { report.push({ id, error: e.message }); }
    }

    const granted = report.some(r => r.granted);
    return res.status(200).json({
      ok: true,
      email,
      userId,
      granted,
      subscriptionsHist: subs.length,
      candidates: [...candidates],
      mpError,
      report,
    });
  } catch (err) {
    console.error('admin-reconcile:', err);
    return res.status(500).json({ error: err.message || 'erro' });
  }
}
