export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const { messages, system } = req.body || {};

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Parâmetros inválidos' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY não configurada');
    return res.status(500).json({ error: 'Chave da API não configurada no servidor' });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 55000);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 4000,
        system: system || '',
        messages,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (parseErr) {
      console.error('Resposta não-JSON da Anthropic:', response.status, raw.slice(0, 500));
      return res.status(502).json({ error: 'Resposta inválida da API (status ' + response.status + ')' });
    }

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Erro na API Anthropic' });
    }

    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('');

    return res.status(200).json({ reply: text });

  } catch (err) {
    clearTimeout(timeoutId);
    console.error('Erro no backend:', err);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Tempo limite excedido. Tente uma solicitação mais curta.' });
    }
    return res.status(500).json({ error: 'Erro interno: ' + (err.message || 'desconhecido') });
  }
}
