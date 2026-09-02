-- ---- ads no Google: contas, links de captura, cliques, gasto, propostas e conversões (migration 0208) ----
--
-- Spec 0003 (Fase 5), ADR-0016 (Página de Captura e Código de Clique), ADR-0018
-- (Níveis de Autonomia). Seis tabelas tenant-aware, todas com RLS:
--   leitura para membro da organização; escrita só para `manager` ou acima
--   (`fn_role_at_least`) — o guarda de RBAC reprova tabela nova com policy ALL
--   só de tenancy. O produto escreve pelo service role (crons e a Página de
--   Captura pública), que bypassa RLS e filtra `organization_id` à mão.
-- Credenciais do Google Ads ficam POR INSTALAÇÃO (env), como o app da Meta:
-- a LAVRA opera um MCC só. Por Conta fica o `customer_id` e a conversion action.
-- Dinheiro em centavos; `cost_micros` é o que a API devolve (1e6 por unidade).
create table if not exists public.ad_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'google_ads' check (provider = 'google_ads'),
  customer_id text not null check (customer_id ~ '^[0-9]{10}$'),
  conversion_customer_id text null check (conversion_customer_id is null or conversion_customer_id ~ '^[0-9]{10}$'),
  conversion_action text null,
  currency char(3) not null default 'BRL',
  autonomy_level smallint not null default 1 check (autonomy_level between 1 and 3),
  budget_floor_cents bigint null check (budget_floor_cents is null or budget_floor_cents >= 0),
  budget_ceiling_cents bigint null check (budget_ceiling_cents is null or budget_ceiling_cents >= 0),
  max_cost_per_conversation_cents bigint null check (max_cost_per_conversation_cents is null or max_cost_per_conversation_cents >= 0),
  status text not null default 'active' check (status in ('active','paused','error')),
  last_sync_at timestamptz null,
  last_error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider)
);

alter table public.ad_accounts enable row level security;
drop policy if exists ad_accounts_member_select on public.ad_accounts;
create policy ad_accounts_member_select on public.ad_accounts
  for select to authenticated
  using (public.fn_is_platform_admin() or organization_id in (select public.fn_user_org_ids()));
drop policy if exists ad_accounts_manager_write on public.ad_accounts;
create policy ad_accounts_manager_write on public.ad_accounts
  for all to authenticated
  using (public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')))
  with check (public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
revoke all on public.ad_accounts from anon;

create table if not exists public.ad_capture_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,60}$'),
  campaign_id text not null,
  campaign_name text null,
  whatsapp_e164 text not null check (whatsapp_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  mensagem text not null check (length(mensagem) between 1 and 300),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, campaign_id)
);

alter table public.ad_capture_links enable row level security;
drop policy if exists ad_capture_links_member_select on public.ad_capture_links;
create policy ad_capture_links_member_select on public.ad_capture_links
  for select to authenticated
  using (public.fn_is_platform_admin() or organization_id in (select public.fn_user_org_ids()));
drop policy if exists ad_capture_links_manager_write on public.ad_capture_links;
create policy ad_capture_links_manager_write on public.ad_capture_links
  for all to authenticated
  using (public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')))
  with check (public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
revoke all on public.ad_capture_links from anon;

create table if not exists public.ad_clicks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  code text not null check (code ~ '^[A-Z2-9]{6}$'),
  link_id uuid null references public.ad_capture_links(id) on delete set null,
  campaign_id text not null,
  gclid text null,
  gbraid text null,
  wbraid text null,
  user_agent text null,
  consumed_at timestamptz null,
  contact_id uuid null references public.contacts(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, code)
);
create index if not exists idx_ad_clicks_org_consumed on public.ad_clicks (organization_id, consumed_at);

alter table public.ad_clicks enable row level security;
drop policy if exists ad_clicks_member_select on public.ad_clicks;
create policy ad_clicks_member_select on public.ad_clicks
  for select to authenticated
  using (public.fn_is_platform_admin() or organization_id in (select public.fn_user_org_ids()));
drop policy if exists ad_clicks_manager_write on public.ad_clicks;
create policy ad_clicks_manager_write on public.ad_clicks
  for all to authenticated
  using (public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')))
  with check (public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
revoke all on public.ad_clicks from anon;

create table if not exists public.ad_spend (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id text not null,
  campaign_name text null,
  date date not null,
  cost_micros bigint not null default 0 check (cost_micros >= 0),
  clicks integer null,
  impressions integer null,
  conversions numeric null,
  conversions_value numeric null,
  synced_at timestamptz not null default now(),
  unique (organization_id, campaign_id, date)
);

alter table public.ad_spend enable row level security;
drop policy if exists ad_spend_member_select on public.ad_spend;
create policy ad_spend_member_select on public.ad_spend
  for select to authenticated
  using (public.fn_is_platform_admin() or organization_id in (select public.fn_user_org_ids()));
drop policy if exists ad_spend_manager_write on public.ad_spend;
create policy ad_spend_manager_write on public.ad_spend
  for all to authenticated
  using (public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')))
  with check (public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
revoke all on public.ad_spend from anon;

create table if not exists public.ad_proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id text null,
  kind text not null check (kind in ('orcamento','pausar','palavra_chave','anuncio','observacao')),
  level smallint not null check (level between 1 and 3),
  title text not null check (length(title) between 1 and 200),
  body text not null check (length(body) between 1 and 4000),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pendente' check (status in ('pendente','aprovada','recusada','aplicada')),
  decided_by uuid null references auth.users(id) on delete set null,
  decided_at timestamptz null,
  llm_call_id uuid null references public.llm_calls(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_ad_proposals_org_status on public.ad_proposals (organization_id, status, created_at desc);

alter table public.ad_proposals enable row level security;
drop policy if exists ad_proposals_member_select on public.ad_proposals;
create policy ad_proposals_member_select on public.ad_proposals
  for select to authenticated
  using (public.fn_is_platform_admin() or organization_id in (select public.fn_user_org_ids()));
drop policy if exists ad_proposals_manager_write on public.ad_proposals;
create policy ad_proposals_manager_write on public.ad_proposals
  for all to authenticated
  using (public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')))
  with check (public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
revoke all on public.ad_proposals from anon;

create table if not exists public.ad_conversion_uploads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  appointment_id uuid not null unique references public.calendar_appointments(id) on delete cascade,
  gclid text null,
  gbraid text null,
  wbraid text null,
  conversion_value_cents bigint null check (conversion_value_cents is null or conversion_value_cents >= 0),
  uploaded_at timestamptz null,
  status text not null check (status in ('enviada','falhou','ignorada')),
  error text null,
  created_at timestamptz not null default now()
);

alter table public.ad_conversion_uploads enable row level security;
drop policy if exists ad_conversion_uploads_member_select on public.ad_conversion_uploads;
create policy ad_conversion_uploads_member_select on public.ad_conversion_uploads
  for select to authenticated
  using (public.fn_is_platform_admin() or organization_id in (select public.fn_user_org_ids()));
drop policy if exists ad_conversion_uploads_manager_write on public.ad_conversion_uploads;
create policy ad_conversion_uploads_manager_write on public.ad_conversion_uploads
  for all to authenticated
  using (public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')))
  with check (public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
revoke all on public.ad_conversion_uploads from anon;

notify pgrst, 'reload schema';
