-- Schema do Viaja+Aí — execute no SQL editor do Supabase.
-- Idempotente: pode rodar de novo sem quebrar nada existente.

-- ──────────────────────────────────────────────────────────────────────
-- 0) PROFILES — nome, CPF hash, IP de cadastro (LGPD-friendly)
-- ──────────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  nome        text not null,
  cpf_hash    text not null unique,
  email       text not null,
  ip_cadastro text,
  created_at  timestamptz not null default now()
);

create index if not exists profiles_cpf_hash_idx on public.profiles (cpf_hash);
create index if not exists profiles_ip_idx       on public.profiles (ip_cadastro, created_at desc);
create index if not exists profiles_email_idx    on public.profiles (email);

alter table public.profiles enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles for select using (auth.uid() = id);
-- INSERT/UPDATE só via service role (api/verify) — sem policy = bloqueado para auth.uid().


-- ──────────────────────────────────────────────────────────────────────
-- 1) ROTEIROS — histórico de roteiros gerados
-- ──────────────────────────────────────────────────────────────────────
create table if not exists public.roteiros (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  destino      text not null,
  datas        text,
  roteiro_json jsonb not null,
  is_public    boolean not null default false,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz
);

create index if not exists roteiros_user_id_idx     on public.roteiros (user_id, created_at desc);
create index if not exists roteiros_expires_at_idx  on public.roteiros (expires_at);
create index if not exists roteiros_is_public_idx   on public.roteiros (is_public) where is_public = true;

alter table public.roteiros enable row level security;

drop policy if exists roteiros_select_own  on public.roteiros;
drop policy if exists roteiros_insert_own  on public.roteiros;
drop policy if exists roteiros_update_own  on public.roteiros;
drop policy if exists roteiros_delete_own  on public.roteiros;
drop policy if exists roteiros_public_read on public.roteiros;

create policy roteiros_select_own  on public.roteiros for select using (auth.uid() = user_id);
create policy roteiros_insert_own  on public.roteiros for insert with check (auth.uid() = user_id);
create policy roteiros_update_own  on public.roteiros for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy roteiros_delete_own  on public.roteiros for delete using (auth.uid() = user_id);
create policy roteiros_public_read on public.roteiros for select using (is_public = true);


-- ──────────────────────────────────────────────────────────────────────
-- 2) USER_USAGE — plano atual e contador de roteiros (trial / pro)
-- ──────────────────────────────────────────────────────────────────────
create table if not exists public.user_usage (
  user_id                 uuid primary key references auth.users(id) on delete cascade,
  roteiros_mes            integer not null default 0,
  mes_referencia          text not null default to_char(now() at time zone 'utc', 'YYYY-MM'),
  plano                   text not null default 'trial',
  plano_expira_em         timestamptz,
  trial_started_at        timestamptz,
  trial_expires_at        timestamptz,
  trial_roteiros_usados   integer not null default 0,
  updated_at              timestamptz not null default now()
);

-- Migração: amplia o check do plano para incluir 'trial' e 'expirado'
do $$
begin
  alter table public.user_usage drop constraint if exists user_usage_plano_check;
exception when others then null;
end $$;

alter table public.user_usage
  add constraint user_usage_plano_check
  check (plano in ('free','trial','expirado','pro_mensal','pro_anual'));

-- Migração: adiciona colunas de trial se ainda não existirem
alter table public.user_usage add column if not exists trial_started_at      timestamptz;
alter table public.user_usage add column if not exists trial_expires_at      timestamptz;
alter table public.user_usage add column if not exists trial_roteiros_usados integer not null default 0;

alter table public.user_usage enable row level security;

drop policy if exists user_usage_select_own on public.user_usage;
drop policy if exists user_usage_insert_own on public.user_usage;
drop policy if exists user_usage_update_own on public.user_usage;

create policy user_usage_select_own on public.user_usage for select using (auth.uid() = user_id);
create policy user_usage_insert_own on public.user_usage for insert with check (auth.uid() = user_id);
create policy user_usage_update_own on public.user_usage for update using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ──────────────────────────────────────────────────────────────────────
-- 3) SUBSCRIPTIONS — histórico de pagamentos do Mercado Pago
-- ──────────────────────────────────────────────────────────────────────
create table if not exists public.subscriptions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  plan          text not null check (plan in ('pro_mensal','pro_anual')),
  status        text not null,
  mp_payment_id text unique,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz
);

create index if not exists subscriptions_user_id_idx on public.subscriptions (user_id, created_at desc);

alter table public.subscriptions enable row level security;

drop policy if exists subscriptions_select_own on public.subscriptions;
create policy subscriptions_select_own on public.subscriptions for select using (auth.uid() = user_id);
-- INSERT/UPDATE/DELETE só via service role (webhook) — sem policy = bloqueado para auth.uid().


-- ──────────────────────────────────────────────────────────────────────
-- 4) FUNÇÃO: cria linha user_usage automaticamente para novos usuários
--    Novos cadastros começam com TRIAL de 7 dias e acesso completo.
-- ──────────────────────────────────────────────────────────────────────
create or replace function public.handle_new_user_usage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_usage (user_id, plano, trial_started_at, trial_expires_at, trial_roteiros_usados)
  values (new.id, 'trial', now(), now() + interval '7 days', 0)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_usage on auth.users;
create trigger on_auth_user_created_usage
  after insert on auth.users
  for each row execute function public.handle_new_user_usage();


-- ──────────────────────────────────────────────────────────────────────
-- 5) FUNÇÃO RPC: incrementa contador de uso e do trial
--    Chamada pelo frontend após salvar um roteiro novo.
-- ──────────────────────────────────────────────────────────────────────
create or replace function public.increment_roteiros_mes()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  mes_atual text := to_char(now() at time zone 'utc', 'YYYY-MM');
begin
  if uid is null then
    raise exception 'auth.uid() retornou null';
  end if;
  insert into public.user_usage (user_id, roteiros_mes, mes_referencia, trial_roteiros_usados)
  values (uid, 1, mes_atual, 1)
  on conflict (user_id) do update
    set roteiros_mes          = case when user_usage.mes_referencia = mes_atual
                                     then user_usage.roteiros_mes + 1
                                     else 1 end,
        mes_referencia        = mes_atual,
        trial_roteiros_usados = user_usage.trial_roteiros_usados + 1,
        updated_at            = now();
end;
$$;

grant execute on function public.increment_roteiros_mes() to authenticated;
