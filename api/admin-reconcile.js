// Endpoint ADMIN protegido — reconcilia o Pro de um usuário e diagnostica pagamentos.
// Modos (todos exigem &secret=<token>):
//   • Listar pagamentos recentes:   GET /api/admin-reconcile?list=1
//   • Liberar por payment_id:        GET /api/admin-reconcile?payment_id=<id>
//   • Reconciliar por user_id:       GET /api/admin-reconcile?user_id=<uuid>
//   • Reconciliar por e-mail (app):  GET /api/admin-reconcile?email=<email>
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

// Pagamentos recentes do MP (resumo enxuto p/ diagnóstico).
async function mpSearchRecent() {
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
  return (data.results || []).map(p => {
    const md = p.metadata || {};
    const ext = p.external_reference || '';
    return {
      id: String(p.id),
      status: p.status,
      status_detail: p.status_detail,
      amount: p.transaction_amount,
      payer_email: (p.payer && p.payer.email) || null,
      user_id: md.user_id || (ext ? ext.split('|')[0] : null),
      plan: md.plan || (ext ? ext.split('|')[1] : null),
      offer: md.offer || null,
      date: p.date_created,
    };
  });
}

// IDs de pagamentos recentes que pertencem ao userId.
async function mpPaymentIdsForUser(userId) {
  return (await mpSearchRecent()).filter(p => p.user_id === userId).map(p => p.id);
}

export default async function handler(req, res) {
  const q = req.query || {};
  const provided = String(q.secret || '');
  const hash = crypto.createHash('sha256').update(provided).digest('hex');
  if (!provided || hash !== SECRET_SHA256) {
    return res.status(403).json({ error: 'forbidden' });
  }

  if (!process.env.MP_ACCESS_TOKEN || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'env ausente (MP/Supabase)' });
  }

  try {
    // MODO 1: listar pagamentos recentes (diagnóstico).
    if (q.list) {
      return res.status(200).json({ ok: true, payments: await mpSearchRecent() });
    }

    // MODO 2: liberar direto por payment_id.
    if (q.payment_id) {
      const id = String(q.payment_id).trim();
      if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'payment_id inválido' });
      return res.status(200).json({ ok: true, report: [{ id, ...(await grantFromPayment(id)) }] });
    }

    // MODO 3/4: descobrir o userId (direto ou via e-mail) e reconciliar.
    let userId = q.user_id ? String(q.user_id).trim() : null;
    const email = String(q.email || '').trim();
    if (!userId) {
      if (!email) return res.status(400).json({ error: 'use list=1, payment_id, user_id ou email' });
      const profiles = await supaFetch(
        '/rest/v1/profiles?select=id,email&email=ilike.' + encodeURIComponent(email)
      );
      if (!profiles.length) {
        return res.status(404).json({ error: 'usuário não encontrado em profiles', email,
          dica: 'esse e-mail pode ser o do Mercado Pago, não o da conta do app. Use ?list=1 pra ver os pagamentos.' });
      }
      userId = profiles[0].id;
    }

    // candidatos: ids no nosso histórico + varredura recente no MP
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

    const report = [];
    for (const id of candidates) {
      try { report.push({ id, ...(await grantFromPayment(id)) }); }
      catch (e) { report.push({ id, error: e.message }); }
    }

    return res.status(200).json({
      ok: true,
      userId,
      granted: report.some(r => r.granted),
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
