export default async function handler(req, res) {
  // Libera CORS para o frontend
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const { messages, system } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Parâmetros inválidos' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: system || '',
        messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Erro na API' });
    }

    const text = data.content.map(b => b.text || '').join('');
    return res.status(200).json({ reply: text });

  } catch (err) {
    console.error('Erro no backend:', err);
    return res.status(500).json({ error: 'Erro interno do servidor' });
  }
}
