// Webhook do Mercado Pago — recebe notificação de pagamento, valida e atualiza
// as tabelas subscriptions / user_usage no Supabase usando a service role key.
//
// MP envia POST em vários formatos. Cobrimos os principais:
//   • body: { action: 'payment.created'|'payment.updated', data: { id: '123' } }
//   • body: { type: 'payment', data: { id: '123' } }
//   • query: ?topic=payment&id=123  (legado)
//
// Para responder rápido (MP exige <22s), validamos e retornamos 200 mesmo
// quando não conseguimos processar — assim o MP não reenfileira sem parar.
//
// Variáveis necessárias:
//   MP_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const PLAN_DURATION_DAYS = {
  pro_mensal: 30,
  pro_anual: 365,
};

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

async function fetchPayment(paymentId) {
  const res = await fetch('https://api.mercadopago.com/v1/payments/' + paymentId, {
    headers: { 'Authorization': 'Bearer ' + process.env.MP_ACCESS_TOKEN },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('MP payment fetch falhou (' + res.status + '): ' + text);
  }
  return res.json();
}

async function supaFetch(path, options = {}) {
  const url = process.env.SUPABASE_URL.replace(/\/$/, '') + path;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = {
    'apikey': key,
    'Authorization': 'Bearer ' + key,
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Supabase ' + path + ' falhou (' + res.status + '): ' + text);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function upsertSubscription(row) {
  return supaFetch('/rest/v1/subscriptions?on_conflict=mp_payment_id', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
}

async function upsertUserUsage(userId, plan, expiresAt) {
  return supaFetch('/rest/v1/user_usage?on_conflict=user_id', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      user_id: userId,
      plano: plan,
      plano_expira_em: expiresAt,
    }),
  });
}

export default async function handler(req, res) {
  // MP usa POST em produção; aceitamos GET também (alguns testes manuais).
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

  // Responde rápido — MP exige <22s. O processamento pode continuar depois.
  res.status(200).json({ received: true });

  if (!paymentId || !isPaymentEvent) {
    console.log('webhook: ignorado (sem paymentId ou tipo != payment)', { topic, paymentId });
    return;
  }
  if (!process.env.MP_ACCESS_TOKEN) {
    console.error('webhook: MP_ACCESS_TOKEN não configurado');
    return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('webhook: SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurado');
    return;
  }

  try {
    const payment = await fetchPayment(paymentId);
    const status = payment.status; // approved, pending, rejected, refunded, ...
    const metadata = payment.metadata || {};
    const externalRef = payment.external_reference || '';

    // Metadata + external_reference são onde plantamos user_id/plan em payment.js.
    let userId = metadata.user_id || null;
    let plan = metadata.plan || null;
    if ((!userId || !plan) && externalRef) {
      const parts = externalRef.split('|');
      if (!userId) userId = parts[0] || null;
      if (!plan)  plan   = parts[1] || null;
    }

    if (!userId || !plan) {
      console.error('webhook: payment sem user_id/plan', { paymentId, metadata, externalRef });
      return;
    }
    if (!PLAN_DURATION_DAYS[plan]) {
      console.error('webhook: plano desconhecido', plan);
      return;
    }

    const now = new Date();
    const expiresAt = status === 'approved'
      ? addDays(now, PLAN_DURATION_DAYS[plan])
      : null;

    await upsertSubscription({
      user_id: userId,
      plan,
      status,
      mp_payment_id: String(paymentId),
      expires_at: expiresAt,
    });

    // Só promove o usuário a Pro se o pagamento foi aprovado.
    if (status === 'approved') {
      await upsertUserUsage(userId, plan, expiresAt);
      console.log('webhook: usuário promovido', { userId, plan, expiresAt });
    } else {
      console.log('webhook: pagamento não aprovado', { paymentId, status });
    }
  } catch (err) {
    console.error('webhook: erro processando pagamento', paymentId, err);
  }
}
