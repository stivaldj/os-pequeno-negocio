-- ---- relatório diário: histórico dos envios ao Dono (migration 0210) ----
--
-- Spec 0003 (Fase 7). `lib/relatorio/` consome agenda, `lib/ads`, `lib/financeiro`
-- e `fn_atrito_metrics`; esta tabela não guarda NADA que esses módulos já não
-- tenham calculado — ela é o registro de que o relatório foi montado e mandado
-- num dia, com o texto final e o que ficou incompleto.
--
-- `unique (organization_id, report_date)` é a idempotência: o cron rodar duas
-- vezes no mesmo dia (retry manual, redeploy) não manda a mensagem duas vezes —
-- a segunda tentativa lê a linha e desiste antes de chamar `enviarAoDono`.
--
-- Por que tabela própria, e não reconstituir da `messages` (o texto do envio já
-- fica lá, via `enviarAoDono` → `sendMessageHandler`): `messages.metadata` não
-- tem índice, e a tela de histórico pede lista rápida e ordenada — o mesmo
-- motivo que já fez `ad_proposals` existir em vez de vasculhar conversa.
create table if not exists public.daily_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  report_date date not null,
  sent_at timestamptz not null default now(),
  incomplete_sections text[] not null default '{}',
  body text not null check (length(body) between 1 and 8000),
  status text not null default 'enviado' check (status in ('enviado','falhou')),
  failure_reason text null,
  created_at timestamptz not null default now(),
  unique (organization_id, report_date)
);
create index if not exists idx_daily_reports_org_date on public.daily_reports (organization_id, report_date desc);

alter table public.daily_reports enable row level security;
drop policy if exists daily_reports_member_select on public.daily_reports;
create policy daily_reports_member_select on public.daily_reports
  for select to authenticated
  using (public.fn_is_platform_admin() or organization_id in (select public.fn_user_org_ids()));
drop policy if exists daily_reports_manager_write on public.daily_reports;
create policy daily_reports_manager_write on public.daily_reports
  for all to authenticated
  using (public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')))
  with check (public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
revoke all on public.daily_reports from anon;

comment on column public.daily_reports.incomplete_sections is
  'Nomes das seções que faltou dado (ex.: {ads,financeiro}) — texto na mensagem, nunca zero escondendo a falta.';
comment on column public.daily_reports.failure_reason is
  'Preenchido só quando status = falhou. Rodada sem Dono configurado, canal fora do ar etc.';

notify pgrst, 'reload schema';
