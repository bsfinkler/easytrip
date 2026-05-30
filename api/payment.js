// Cria uma preferência de pagamento Mercado Pago.
// Recebe { plan: 'pro_mensal' | 'pro_anual', user_id, user_email } e retorna { init_point, id }.
//
// O frontend redireciona o usuário para init_point. Após pagamento, MP volta para
// back_urls.success com query string contendo payment_id, status, etc.
// E também envia notificação assíncrona para notification_url (webhook).

const PLANS = {
  pro_mensal: {
    title: 'Viaja+Aí Pro Mensal',
    description: 'Assinatura mensal — roteiros ilimitados, todas as 5 abas, PDF, sem marca d\'água',
    unit_price: 29.90,
  },
  pro_anual: {
    title: 'Viaja+Aí Pro Anual',
    description: 'Assinatura anual — tudo do Pro Mensal + badge Viajante Pro + 2 meses grátis',
    unit_price: 239.90,
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

  if (!plan || !PLANS[plan]) {
    return res.status(400).json({ error: 'Plano inválido. Use pro_mensal ou pro_anual.' });
  }
  if (!user_id) {
    return res.status(400).json({ error: 'user_id obrigatório.' });
  }

  if (!process.env.MP_ACCESS_TOKEN) {
    console.error('MP_ACCESS_TOKEN não configurado');
    return res.status(500).json({ error: 'Pagamento não configurado no servidor.' });
  }

  const planData = PLANS[plan];
  const externalReference = `${user_id}|${plan}|${Date.now()}`;

  const preference = {
    items: [{
      id: plan,
      title: planData.title,
      description: planData.description,
      quantity: 1,
      currency_id: 'BRL',
      unit_price: planData.unit_price,
    }],
    payer: user_email ? { email: user_email } : undefined,
    back_urls: {
      success: SUCCESS_URL,
      failure: FAILURE_URL,
      pending: PENDING_URL,
    },
    auto_return: 'approved',
    payment_methods: {
      // Sem restrições: aceita cartão de crédito/débito, boleto e PIX.
      excluded_payment_types: [],
      excluded_payment_methods: [],
      installments: 12,
    },
    notification_url: WEBHOOK_URL,
    external_reference: externalReference,
    metadata: {
      user_id,
      plan,
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
