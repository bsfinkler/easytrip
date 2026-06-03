// Cria uma preferência de pagamento Mercado Pago.
// Recebe { plan, user_id, user_email } onde `plan` é o OFFER ID:
//   • 'pro_anual_parcelado' → anual em até 12x, SÓ cartão de crédito
//   • 'pro_anual_avista'    → anual à vista (com desconto), cartão em 1x + Pix
//
// Internamente as duas ofertas viram o mesmo plano normalizado 'pro_anual'
// (365 dias) — é isso que gravamos em metadata/external_reference, então o
// webhook e o frontend (isPro, badge, expiração) não precisam mudar.
//
// Fluxo: o frontend redireciona para init_point. Após pagar, o MP volta para
// back_urls.success com payment_id/collection_id na query (ativação síncrona)
// e também notifica a notification_url (webhook).

const OFFERS = {
  pro_anual_parcelado: {
    plan: 'pro_anual',
    title: 'Viaja+Aí Pro Anual — 12x',
    description: 'Assinatura anual: roteiros ilimitados, todas as abas, PDF, sem marca d\'água. Em até 12x no cartão.',
    unit_price: 239.90,
    payment_methods: {
      // Só cartão de crédito, parcelado em até 12x (juros por conta do cliente).
      excluded_payment_types: [
        { id: 'ticket' },        // boleto
        { id: 'bank_transfer' }, // Pix
        { id: 'atm' },
        { id: 'debit_card' },
        { id: 'prepaid_card' },
        { id: 'account_money' }, // saldo MP
      ],
      excluded_payment_methods: [],
      installments: 12,
    },
  },
  pro_anual_avista: {
    plan: 'pro_anual',
    title: 'Viaja+Aí Pro Anual — à vista',
    description: 'Assinatura anual com desconto: roteiros ilimitados e todos os recursos. Pague no Pix ou cartão em 1x.',
    unit_price: 199.90,
    payment_methods: {
      // Cartão em 1x + Pix. Sem boleto, débito ou parcelamento.
      excluded_payment_types: [
        { id: 'ticket' },        // boleto
        { id: 'atm' },
        { id: 'debit_card' },
        { id: 'prepaid_card' },
        { id: 'account_money' }, // saldo MP
      ],
      excluded_payment_methods: [],
      installments: 1,
    },
  },
};

const SUCCESS_URL = 'https://www.viajamaisai.net.br?payment=success';
const FAILURE_URL = 'https://www.viajamaisai.net.br?payment=failure';
const PENDING_URL = 'https://www.viajamaisai.net.br?payment=pending';
const WEBHOOK_URL = 'https://www.viajamaisai.net.br/api/webhook';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const { plan, user_id, user_email } = req.body || {};

  if (!plan || !OFFERS[plan]) {
    return res.status(400).json({ error: 'Oferta inválida. Use pro_anual_parcelado ou pro_anual_avista.' });
  }
  if (!user_id) {
    return res.status(400).json({ error: 'user_id obrigatório.' });
  }

  if (!process.env.MP_ACCESS_TOKEN) {
    console.error('MP_ACCESS_TOKEN não configurado');
    return res.status(500).json({ error: 'Pagamento não configurado no servidor.' });
  }

  const offer = OFFERS[plan];
  const normalizedPlan = offer.plan; // sempre 'pro_anual' — é o que vai p/ o banco
  const externalReference = `${user_id}|${normalizedPlan}|${Date.now()}`;

  const preference = {
    items: [{
      id: plan, // offer id (analytics)
      title: offer.title,
      description: offer.description,
      quantity: 1,
      currency_id: 'BRL',
      unit_price: offer.unit_price,
    }],
    payer: user_email ? { email: user_email } : undefined,
    back_urls: {
      success: SUCCESS_URL,
      failure: FAILURE_URL,
      pending: PENDING_URL,
    },
    auto_return: 'approved',
    payment_methods: offer.payment_methods,
    notification_url: WEBHOOK_URL,
    external_reference: externalReference,
    metadata: {
      user_id,
      plan: normalizedPlan, // normalizado p/ o webhook/grant
      offer: plan,          // oferta escolhida (12x vs à vista) p/ analytics
    },
    statement_descriptor: 'VIAJAMAISAI',
  };

  try {
    const upstream = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.MP_ACCESS_TOKEN,
      },
      body: JSON.stringify(preference),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      console.error('MP preference error:', data);
      return res.status(upstream.status).json({
        error: data.message || 'Erro ao criar preferência no Mercado Pago',
        detail: data,
      });
    }

    return res.status(200).json({
      id: data.id,
      init_point: data.init_point,
      public_key: process.env.MP_PUBLIC_KEY || '',
    });
  } catch (err) {
    console.error('Erro payment.js:', err);
    return res.status(500).json({ error: 'Erro interno: ' + (err.message || 'desconhecido') });
  }
}
