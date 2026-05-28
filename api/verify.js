// Verifica e registra um novo usuário com proteções anti-abuso.
//
// Recebe { nome, cpf, email, password } e:
//   1. Valida nome (mínimo 2 palavras)
//   2. Valida CPF (formato + dois dígitos verificadores)
//   3. Bloqueia e-mails de domínios descartáveis
//   4. Verifica se hash do CPF já existe em profiles → "CPF já cadastrado"
//   5. Verifica IP — se criou >2 contas em 7 dias → bloqueia
//   6. Cria o usuário via Admin API do Supabase (email_confirm=true → auto-confirma)
//   7. Insere linha em profiles
//   8. Retorna { ok: true } — frontend faz signInWithPassword na sequência
//
// Variáveis necessárias:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import crypto from 'node:crypto';

// ───────── Lista de domínios de e-mail descartáveis (>50 entradas)
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com','mailinator.net','mailinator.org','tempmail.com','temp-mail.org','temp-mail.io',
  'guerrillamail.com','guerrillamail.net','guerrillamail.org','guerrillamail.biz','guerrillamail.de',
  'guerrillamailblock.com','sharklasers.com','grr.la','pokemail.net','spam4.me',
  'yopmail.com','yopmail.fr','yopmail.net','throwam.com','throwawaymail.com','trashmail.com',
  'trashmail.net','trashmail.io','trashmail.de','trashmail.ws','trashmail.me',
  'fakeinbox.com','maildrop.cc','dispostable.com','getairmail.com','filzmail.com',
  'spamgourmet.com','spamspot.com','spamthis.co.uk','tempr.email','tmail.com','tmail.io','tmail.ws',
  'yevme.com','zippymail.in','10minutemail.com','10minutemail.net','20minutemail.com',
  '33mail.com','anonbox.net','byom.de','dropmail.me','emailondeck.com','fakemail.net',
  'fakemailgenerator.com','getnada.com','inboxbear.com','mailcatch.com','mailnesia.com',
  'mintemail.com','mohmal.com','mytemp.email','nada.email','nwldx.com','rcpt.at',
  'sneakemail.com','spambox.us','thrott.com','wegwerfmail.de','wegwerfemail.de',
  'mt2014.com','tempemail.com','tempinbox.com','jetable.org','spam.la','trbvm.com',
  'spambog.com','spambog.de','mailmoat.com','noclickemail.com','noclickmail.com'
]);

function isDisposableEmail(email) {
  const domain = (email.split('@')[1] || '').toLowerCase().trim();
  if (!domain) return true;
  if (DISPOSABLE_DOMAINS.has(domain)) return true;
  // Bloqueia também subdomínios óbvios (ex: foo.mailinator.com)
  for (const d of DISPOSABLE_DOMAINS) {
    if (domain.endsWith('.' + d)) return true;
  }
  return false;
}

function validateCPF(cpfRaw) {
  const cpf = String(cpfRaw || '').replace(/\D/g, '');
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false; // 11111..., 22222..., etc.
  // 1º dígito verificador
  let soma = 0;
  for (let i = 0; i < 9; i++) soma += parseInt(cpf[i], 10) * (10 - i);
  let resto = (soma * 10) % 11;
  if (resto === 10) resto = 0;
  if (resto !== parseInt(cpf[9], 10)) return false;
  // 2º dígito verificador
  soma = 0;
  for (let i = 0; i < 10; i++) soma += parseInt(cpf[i], 10) * (11 - i);
  resto = (soma * 10) % 11;
  if (resto === 10) resto = 0;
  if (resto !== parseInt(cpf[10], 10)) return false;
  return true;
}

function hashCPF(cpfRaw) {
  const cpf = String(cpfRaw || '').replace(/\D/g, '');
  return crypto.createHash('sha256').update('viajamaisai:' + cpf).digest('hex');
}

function getClientIP(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || '';
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
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { ok: res.ok, status: res.status, data };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('verify: SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurado');
    return res.status(500).json({ error: 'Cadastro não está disponível no momento.' });
  }

  const { nome, cpf, email, password } = req.body || {};

  // ── 1. Validações de formato ──
  const nomeTrim = String(nome || '').trim();
  if (!nomeTrim || nomeTrim.split(/\s+/).length < 2) {
    return res.status(400).json({ error: 'Informe seu nome completo (mínimo 2 palavras).' });
  }
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'E-mail inválido.' });
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'A senha precisa ter no mínimo 6 caracteres.' });
  }
  if (!validateCPF(cpf)) {
    return res.status(400).json({ error: 'CPF inválido. Verifique os números e tente novamente.' });
  }
  if (isDisposableEmail(email)) {
    return res.status(400).json({ error: 'Use um e-mail permanente para se cadastrar.' });
  }

  const cpfHash = hashCPF(cpf);
  const ip = getClientIP(req);
  const emailNorm = email.trim().toLowerCase();

  try {
    // ── 2. CPF já cadastrado? ──
    const cpfCheck = await supaFetch(
      '/rest/v1/profiles?cpf_hash=eq.' + encodeURIComponent(cpfHash) + '&select=id&limit=1'
    );
    if (cpfCheck.ok && Array.isArray(cpfCheck.data) && cpfCheck.data.length > 0) {
      return res.status(409).json({ error: 'CPF já cadastrado. Faça login ou recupere sua senha.' });
    }

    // ── 3. Rate limit por IP (max 2 contas em 7 dias) ──
    if (ip) {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const ipCheck = await supaFetch(
        '/rest/v1/profiles?ip_cadastro=eq.' + encodeURIComponent(ip)
        + '&created_at=gte.' + encodeURIComponent(sevenDaysAgo)
        + '&select=id'
      );
      if (ipCheck.ok && Array.isArray(ipCheck.data) && ipCheck.data.length >= 2) {
        return res.status(429).json({
          error: 'Detectamos várias contas criadas recentemente da sua conexão. Aguarde alguns dias ou entre em contato com o suporte.',
        });
      }
    }

    // ── 4. Cria usuário no Supabase Auth via Admin API (email_confirm=true → autoconfirma) ──
    const createUser = await supaFetch('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email: emailNorm,
        password,
        email_confirm: true,
        user_metadata: { nome: nomeTrim },
      }),
    });

    if (!createUser.ok) {
      const msg = (createUser.data && (createUser.data.msg || createUser.data.error_description || createUser.data.error || createUser.data.message)) || '';
      const m = msg.toLowerCase();
      if (m.includes('already') || m.includes('registered') || m.includes('exists')) {
        return res.status(409).json({ error: 'Já existe uma conta com esse e-mail. Tente entrar.' });
      }
      if (m.includes('weak') || m.includes('password')) {
        return res.status(400).json({ error: 'A senha precisa ter no mínimo 6 caracteres.' });
      }
      console.error('verify: erro createUser', createUser.status, createUser.data);
      return res.status(500).json({ error: 'Não foi possível criar a conta. Tente novamente.' });
    }

    const userId = createUser.data?.id || createUser.data?.user?.id;
    if (!userId) {
      console.error('verify: admin createUser sem id', createUser.data);
      return res.status(500).json({ error: 'Erro inesperado ao criar conta.' });
    }

    // ── 5. Insere profile (CPF apenas como hash, nunca em texto puro) ──
    const profileIns = await supaFetch('/rest/v1/profiles', {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        id: userId,
        nome: nomeTrim,
        cpf_hash: cpfHash,
        email: emailNorm,
        ip_cadastro: ip || null,
      }),
    });
    if (!profileIns.ok) {
      // Tenta limpar o usuário recém-criado para não deixar órfão
      console.error('verify: erro insert profile, fazendo rollback do auth user', profileIns.status, profileIns.data);
      try {
        await supaFetch('/auth/v1/admin/users/' + userId, { method: 'DELETE' });
      } catch (e) { console.error('verify: rollback falhou', e); }
      // Pode ter sido violação de unique (cpf_hash) por race condition
      const msg = JSON.stringify(profileIns.data || '');
      if (/cpf_hash/i.test(msg) || /duplicate/i.test(msg)) {
        return res.status(409).json({ error: 'CPF já cadastrado. Faça login ou recupere sua senha.' });
      }
      return res.status(500).json({ error: 'Erro ao concluir cadastro. Tente novamente.' });
    }

    // ── 6. OK — frontend faz signInWithPassword pra obter sessão ──
    return res.status(200).json({
      ok: true,
      user_id: userId,
      nome: nomeTrim,
      email: emailNorm,
    });
  } catch (err) {
    console.error('verify: erro inesperado', err);
    return res.status(500).json({ error: 'Erro interno: ' + (err.message || 'desconhecido') });
  }
}
