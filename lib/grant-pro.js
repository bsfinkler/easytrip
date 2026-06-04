// Lógica compartilhada e IDEMPOTENTE de concessão do Pro.
// Usada por:
//   • api/webhook.js  → notificação assíncrona do Mercado Pago
//   • api/activate.js → confirmação síncrona no retorno do checkout
//
// Por que compartilhada: garante que os dois caminhos liberem o Pro
// EXATAMENTE do mesmo jeito. Idempotente porque:
//   • subscriptions usa on_conflict=mp_payment_id (mesmo pagamento não duplica)
//   • user_usage   usa on_conflict=user_id      (re-aplicar é inofensivo)
//
// Variáveis necessárias: MP_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

export const PLAN_DURATION_DAYS = {
  pro_mensal: 30,   // legado (não vendemos mais, mas mantemos p/ assinantes antigos)
  pro_anual: 365,
};

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

// Reconsulta o pagamento direto na API do MP (anti-spoof: nunca confiamos
// no que chega no corpo da requisição; o paymentId é só uma "pista").
export async function fetchPayment(paymentId) {
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
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(base + path, {
    ...options,
    headers: {
      'apikey': key,
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error('Supabase ' + path + ' falhou (' + res.status + '): ' + text);
  }
  // Upserts usam Prefer: return=minimal → 201/204 com corpo VAZIO.
  // Parse só se houver corpo (evita "Unexpected end of JSON input").
  return text ? JSON.parse(text) : null;
}

// user_id e plano são plantados em payment.js, tanto em metadata quanto
// no external_reference ("userId|plan|timestamp"). Lemos dos dois.
// IMPORTANTE: aqui "plan" é o plano NORMALIZADO (pro_anual / pro_mensal),
// nunca o offer id — payment.js já normaliza antes de criar a preferência.
function extractUserPlan(payment) {
  const metadata = payment.metadata || {};
  const externalRef = payment.external_reference || '';
  let userId = metadata.user_id || null;
  let plan = metadata.plan || null;
  if ((!userId || !plan) && externalRef) {
    const parts = externalRef.split('|');
    if (!userId) userId = parts[0] || null;
    if (!plan) plan = parts[1] || null;
  }
  return { userId, plan };
}

// Concede (ou apenas registra) o Pro a partir de um paymentId.
// Retorna { status, userId, plan, expiresAt, granted }.
// Lança erro em falha de rede/validação — o chamador decide o que fazer
// (webhook devolve 500 p/ MP reenfileirar; activate devolve 500 p/ o front).
export async function grantFromPayment(paymentId) {
  if (!process.env.MP_ACCESS_TOKEN) throw new Error('MP_ACCESS_TOKEN ausente');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes');
  }

  const payment = await fetchPayment(paymentId);
  const status = payment.status; // approved | pending | rejected | refunded | ...
  const { userId, plan } = extractUserPlan(payment);

  if (!userId || !plan) throw new Error('pagamento sem user_id/plan: ' + paymentId);
  if (!PLAN_DURATION_DAYS[plan]) throw new Error('plano desconhecido: ' + plan);

  const expiresAt = status === 'approved'
    ? addDays(new Date(), PLAN_DURATION_DAYS[plan])
    : null;

  // Registra a tentativa (qualquer status). Idempotente por mp_payment_id.
  await supaFetch('/rest/v1/subscriptions?on_conflict=mp_payment_id', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      user_id: userId,
      plan,
      status,
      mp_payment_id: String(paymentId),
      expires_at: expiresAt,
    }),
  });

  // Só promove a Pro se o pagamento foi aprovado.
  let granted = false;
  if (status === 'approved') {
    await supaFetch('/rest/v1/user_usage?on_conflict=user_id', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        user_id: userId,
        plano: plan,
        plano_expira_em: expiresAt,
      }),
    });
    granted = true;
  }

  return { status, userId, plan, expiresAt, granted };
}
