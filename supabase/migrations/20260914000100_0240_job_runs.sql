-- ---- toda rotina deixa rastro (migration 0240) ----
--
-- Vinte rotinas rodam pelo scheduler e nenhuma delas dizia se rodou. O modo de
-- falha é o pior que existe: o crond cai, o curl bate 401, o handler lança — e
-- nada muda de cor. "Nada esfriou" fica indistinguível de "o vigia de
-- esfriamento morreu há três semanas". Esta tabela é a memória que faltava:
-- uma linha por execução, aberta como `running` antes do handler e fechada
-- como `ok`/`failed` depois; e `missing`, escrita pelo vigia
-- (`lib/rotinas/vigia.ts`) quando o intervalo esperado passou sem linha nova.
--
-- NÃO É TENANT-AWARE, de propósito. Uma rotina roda para a instalação inteira
-- — varre todas as orgs numa rodada só —, então `organization_id` é NULO na
-- quase totalidade das linhas e fica reservado para rotina que um dia rode
-- por org. É o mesmo desenho de `agent_inbox_items` (organization_id nullable
-- = plataforma). Por isso a policy não é `tenant_isolation_*` via
-- `fn_user_org_ids()`: o histórico de rotinas é operação da instalação, e só
-- o platform admin o lê pelo PostgREST. O service role (quem escreve) bypassa
-- a RLS. `tests/invariants/job-runs-rls.test.ts` prova as quatro personas.

create table if not exists public.job_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid null references public.organizations(id) on delete cascade,
  job_name text not null,
  status text not null check (status in ('running', 'ok', 'failed', 'missing')),
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  duration_ms integer null,
  stats jsonb not null default '{}'::jsonb,
  error text null
);

comment on table public.job_runs is
  'Uma linha por execução de rotina do scheduler (running→ok|failed) e uma por ausência detectada pelo vigia (missing). Tabela de plataforma: organization_id nulo = instalação inteira.';

-- O vigia pergunta "qual a última linha desta rotina?" — índice pelo par que
-- essa pergunta lê, em ordem decrescente para o `limit 1` parar no primeiro.
create index if not exists idx_job_runs_job_name_started_at
  on public.job_runs (job_name, started_at desc);

alter table public.job_runs enable row level security;

-- Só LEITURA, e só para admin de plataforma. Quem escreve é o service role
-- (o helper de `lib/rotinas/registrar.ts`), que bypassa RLS — nenhum usuário
-- autenticado grava execução de rotina. Não é policy `ALL` de propósito:
-- `tests/invariants/rbac-config-ia-canais.test.ts` reprova tabela nova com
-- `ALL` sem `fn_role_at_least`, e aqui a resposta certa é não haver escrita.
drop policy if exists job_runs_platform_admin_all on public.job_runs;
drop policy if exists job_runs_platform_admin_select on public.job_runs;
create policy job_runs_platform_admin_select on public.job_runs
  for select to authenticated
  using (public.fn_is_platform_admin());

-- O ALTER DEFAULT PRIVILEGES do corpo do baseline dá CRUD a `anon` em toda
-- tabela nova. A anon key vai para o browser.
revoke all on public.job_runs from anon;

-- Sem isto o PostgREST segue servindo o schema velho e o primeiro insert do
-- helper de rotinas volta 404 até alguém reiniciar o serviço à mão.
notify pgrst, 'reload schema';
