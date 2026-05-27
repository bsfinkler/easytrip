-- Schema do Viaja+Aí — execute no SQL editor do Supabase.
-- Idempotente: pode rodar de novo sem quebrar nada existente.

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
-- 2) USER_USAGE — plano atual e contador de roteiros do mês
-- ──────────────────────────────────────────────────────────────────────
create table if not exists public.user_usage (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  roteiros_mes       integer not null default 0,
  mes_referencia     text not null default to_char(now() at time zone 'utc', 'YYYY-MM'),
  plano              text not null default 'free' check (plano in ('free','pro_mensal','pro_anual')),
  plano_expira_em    timestamptz,
  updated_at         timestamptz not null default now()
);

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
-- ──────────────────────────────────────────────────────────────────────
create or replace function public.handle_new_user_usage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_usage (user_id, plano)
  values (new.id, 'free')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_usage on auth.users;
create trigger on_auth_user_created_usage
  after insert on auth.users
  for each row execute function public.handle_new_user_usage();


-- ──────────────────────────────────────────────────────────────────────
-- 5) FUNÇÃO RPC: incrementa contador, reseta se virou o mês
-- Chamada pelo frontend após salvar um roteiro novo.
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
  insert into public.user_usage (user_id, roteiros_mes, mes_referencia)
  values (uid, 1, mes_atual)
  on conflict (user_id) do update
    set roteiros_mes   = case when user_usage.mes_referencia = mes_atual
                              then user_usage.roteiros_mes + 1
                              else 1 end,
        mes_referencia = mes_atual,
        updated_at     = now();
end;
$$;

grant execute on function public.increment_roteiros_mes() to authenticated;
