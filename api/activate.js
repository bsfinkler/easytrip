// Ativação SÍNCRONA do Pro — chamada pelo frontend assim que o usuário volta
// do checkout (back_urls.success traz payment_id/collection_id na query).
//
// Este é o caminho confiável e imediato: verifica o pagamento direto no MP e
// libera o Pro na hora, sem depender do webhook. É seguro porque grantFromPayment
// reconsulta o MP e só promove o user_id que REALMENTE pagou (não dá pra forjar
// passando um payment_id alheio — ele liberaria o dono daquele pagamento, não você).
//
// O webhook continua existindo como rede de segurança redundante.

import { grantFromPayment } from '../lib/grant-pro.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const body = req.body || {};
  const paymentId = String(body.payment_id || body.collection_id || '').trim();

  if (!/^\d+$/.test(paymentId)) {
    return res.status(400).json({ ok: false, error: 'payment_id inválido' });
  }

  try {
    const result = await grantFromPayment(paymentId);
    // { status, userId, plan, expiresAt, granted }
    return res.status(200).json({
      ok: true,
      granted: result.granted,
      status: result.status,
      plan: result.plan,
      expiresAt: result.expiresAt,
    });
  } catch (err) {
    console.error('activate:', err);
    return res.status(500).json({ ok: false, error: err.message || 'erro interno' });
  }
}
