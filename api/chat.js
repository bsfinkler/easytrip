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

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
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
        stream: true,
      }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      let errMsg;
      try { errMsg = JSON.parse(errText).error?.message; } catch {}
      return res.status(upstream.status).json({
        error: errMsg || 'Erro na API Anthropic (status ' + upstream.status + ')',
      });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const sseWrite = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const dataStr = line.slice(6);
          if (dataStr === '[DONE]') continue;
          try {
            const data = JSON.parse(dataStr);
            if (
              data.type === 'content_block_delta' &&
              data.delta?.type === 'text_delta' &&
              data.delta.text
            ) {
              sseWrite({ t: data.delta.text });
            } else if (data.type === 'error') {
              sseWrite({ err: data.error?.message || 'erro desconhecido' });
            }
          } catch { /* ignora linhas que não são JSON válido */ }
        }
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('Erro no backend:', err);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Erro interno: ' + (err.message || 'desconhecido') });
    }
    try { res.end(); } catch {}
  }
}
