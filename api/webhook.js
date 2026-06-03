// Webhook do Mercado Pago — rede de segurança REDUNDANTE da ativação do Pro.
// (O caminho principal e imediato é api/activate.js, chamado no retorno do checkout.)
//
// MP envia POST em vários formatos. Cobrimos os principais:
//   • body: { action: 'payment.created'|'payment.updated', data: { id: '123' } }
//   • body: { type: 'payment', data: { id: '123' } }
//   • body: { resource: '.../payments/123', topic: 'payment' }
//   • query: ?topic=payment&id=123  (legado)
//
// CONFIABILIDADE: processamos ANTES de responder e, em caso de falha de rede,
// devolvemos 500 — assim o MP REENFILEIRA e tenta de novo (em vez de perder o
// evento). O grant é idempotente (ver lib/grant-pro.js), então reprocessar é seguro.
//
// Variáveis necessárias: MP_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { grantFromPayment } from '../lib/grant-pro.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Extrai paymentId de qualquer formato conhecido.
  let paymentId = null;
  const body = req.body || {};
  const query = req.query || {};
  if (body.data && body.data.id) paymentId = String(body.data.id);
  else if (body.resource && typeof body.resource === 'string') {
    const m = body.resource.match(/\/payments\/(\d+)/);
    if (m) paymentId = m[1];
  }
  if (!paymentId && query.id) paymentId = String(query.id);
  if (!paymentId && query['data.id']) paymentId = String(query['data.id']);

  const topic = body.type || body.topic || query.type || query.topic || '';
  const isPaymentEvent = !topic || /payment/i.test(topic);

  // Evento sem paymentId ou que não é de pagamento: 200 (não reenfileirar lixo).
  if (!paymentId || !isPaymentEvent) {
    console.log('webhook: ignorado', { topic, paymentId });
    return res.status(200).json({ received: true, ignored: true });
  }

  try {
    const result = await grantFromPayment(paymentId);
    console.log('webhook: processado', { paymentId, ...result });
    return res.status(200).json({ received: true, ...result });
  } catch (err) {
    // Falha transitória (MP/Supabase fora do ar etc.): 500 → MP tenta de novo.
    console.error('webhook: erro processando, MP vai reenfileirar', paymentId, err);
    return res.status(500).json({ received: false, error: err.message || 'erro' });
  }
}
