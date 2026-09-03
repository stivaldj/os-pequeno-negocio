-- ---- financeiro: livro-caixa por OFX, saldos, categorias e obrigações (migration 0209) ----
--
-- Spec 0003 (Fase 6), ADR-0008 (OFX e não Open Finance), ADR-0017 (o Extrato
-- NÃO é fonte de receita por paciente: essa nasce em `calendar_appointments.
-- paid_cents`; aqui é caixa e contas). Quatro tabelas tenant-aware, todas com
-- RLS: leitura para membro da organização; escrita só para `manager` ou acima
-- (`fn_role_at_least`) — o guarda de RBAC reprova tabela nova com policy ALL
-- só de tenancy. A importação escreve pelo service role, que bypassa RLS e
-- filtra `organization_id` à mão, resolvido do gate e nunca do body.
--
-- Três decisões deste bloco que não são óbvias:
--
--   1. `ledger_entries.amount_cents` é ASSINADO. O sinal de um lançamento vem
--      do `<TRNAMT>` do arquivo, nunca do `<TRNTYPE>` — OFX 2.2 §3.2.9.2 diz
--      isso em texto literal, e uma biblioteca npm que confunde os dois
--      reporta +94,02 de crédito num extrato Santander que soma R$ 0,00.
--      Constraint `>= 0` aqui seria esse bug petrificado no schema.
--
--   2. O caixa sai de `ledger_balances`, não de `sum(ledger_entries)`. O Dono
--      importa uma JANELA (um mês, uma semana); somar os lançamentos dá o
--      movimento daquela janela e chamá-lo de saldo é mentira. O saldo é o
--      `<LEDGERBAL>` que o próprio banco declara, com seu `<DTASOF>`.
--
--   3. Conta a Pagar e Conta a Receber são UMA tabela com `direction`. O
--      `CONTEXT.md` as define numa entrada só de glossário ("Compromisso
--      financeiro com data"), a forma é idêntica, e duas tabelas iguais seriam
--      a duplicação sem fonte declarada que o CLAUDE.md proíbe. O Relatório
--      das 8h (Fase 7) lê "o que vence hoje" numa consulta, não em duas.

create table if not exists public.ledger_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  name text not null check (length(name) between 1 and 120),
  kind text not null check (kind in ('income','expense')),
  -- Termos que classificam um lançamento pela descrição do banco. Comparação
  -- sem acento e sem caixa; empate resolvido pelo `slug` em ordem alfabética,
  -- porque dado que decide dinheiro não pode depender da ordem do `select`.
  match_terms text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, slug)
);

alter table public.ledger_categories enable row level security;
drop policy if exists ledger_categories_member_select on public.ledger_categories;
create policy ledger_categories_member_select on public.ledger_categories
  for select to authenticated
  using (public.fn_is_platform_admin() or organization_id in (select public.fn_user_org_ids()));
drop policy if exists ledger_categories_manager_write on public.ledger_categories;
create policy ledger_categories_manager_write on public.ledger_categories
  for all to authenticated
  using (public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')))
  with check (public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
revoke all on public.ledger_categories from anon;
drop trigger if exists trg_ledger_categories_updated_at on public.ledger_categories;
create trigger trg_ledger_categories_updated_at
  before update on public.ledger_categories
  for each row execute function public.fn_set_updated_at();

create table if not exists public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  external_id text not null,
  bank_id text not null default '',
  account_id text not null,
  account_kind text not null check (account_kind in ('bank','credit_card')),
  posted_on date not null,
  amount_cents bigint not null,
  currency char(3) not null default 'BRL',
  trn_type text not null check (trn_type in ('CREDIT','DEBIT','INT','DIV','FEE','SRVCHG','DEP','ATM','POS','XFER','CHECK','PAYMENT','CASH','DIRECTDEP','DIRECTDEBIT','REPEATPMT','HOLD','OTHER')),
  description text not null default '',
  fitid text null,
  checknum text null,
  key_source text not null check (key_source in ('fitid','conteudo')),
  source text not null check (source in ('ofx','manual')),
  category_id uuid null references public.ledger_categories(id) on delete set null,
  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, external_id)
);

create index if not exists idx_ledger_entries_org_dia on public.ledger_entries (organization_id, posted_on desc);
create index if not exists idx_ledger_entries_org_conta_dia on public.ledger_entries (organization_id, account_kind, account_id, posted_on desc);

alter table public.ledger_entries enable row level security;
drop policy if exists ledger_entries_member_select on public.ledger_entries;
create policy ledger_entries_member_select on public.ledger_entries
  for select to authenticated
  using (public.fn_is_platform_admin() or organization_id in (select public.fn_user_org_ids()));
drop policy if exists ledger_entries_manager_write on public.ledger_entries;
create policy ledger_entries_manager_write on public.ledger_entries
  for all to authenticated
  using (public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')))
  with check (public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
revoke all on public.ledger_entries from anon;
drop trigger if exists trg_ledger_entries_updated_at on public.ledger_entries;
create trigger trg_ledger_entries_updated_at
  before update on public.ledger_entries
  for each row execute function public.fn_set_updated_at();

comment on column public.ledger_entries.amount_cents is
  'Assinado: o sinal vem do <TRNAMT> do OFX, nunca do <TRNTYPE> (OFX 2.2 §3.2.9.2). Débito é negativo.';
comment on column public.ledger_entries.external_id is
  'Idempotência da importação: hash de organização + banco + conta + FITID. Quando o banco repete ou omite o FITID, cai para dia + valor + ordinal — NUNCA a descrição, que o banco reescreve entre um extrato e o seguinte.';
comment on column public.ledger_entries.key_source is
  '`conteudo` marca a conta em modo frágil: sem FITID confiável, dois lançamentos do mesmo dia e valor só se distinguem pela ordem no arquivo.';

create table if not exists public.ledger_balances (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bank_id text not null default '',
  account_id text not null,
  account_kind text not null check (account_kind in ('bank','credit_card')),
  kind text not null check (kind in ('ledger','available')),
  as_of date not null,
  balance_cents bigint not null,
  currency char(3) not null default 'BRL',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Nome explícito: o automático passaria de 63 caracteres e seria truncado
  -- pelo Postgres, e o teste de invariante casa a constraint pelo nome.
  -- `bank_id` é `not null default ''` (e não nulo) porque cartão de crédito
  -- não tem BANKID e `unique` no PG17 é NULLS DISTINCT: com NULL, o mesmo
  -- saldo entraria de novo a cada reimportação.
  constraint ledger_balances_conta_tipo_dia_key unique (organization_id, bank_id, account_id, account_kind, kind, as_of)
);

alter table public.ledger_balances enable row level security;
drop policy if exists ledger_balances_member_select on public.ledger_balances;
create policy ledger_balances_member_select on public.ledger_balances
  for select to authenticated
  using (public.fn_is_platform_admin() or organization_id in (select public.fn_user_org_ids()));
drop policy if exists ledger_balances_manager_write on public.ledger_balances;
create policy ledger_balances_manager_write on public.ledger_balances
  for all to authenticated
  using (public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')))
  with check (public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
revoke all on public.ledger_balances from anon;
drop trigger if exists trg_ledger_balances_updated_at on public.ledger_balances;
create trigger trg_ledger_balances_updated_at
  before update on public.ledger_balances
  for each row execute function public.fn_set_updated_at();

comment on table public.ledger_balances is
  'O caixa vem daqui, não da soma dos lançamentos: o Dono importa uma janela, e somar a janela não é saldo. É o <LEDGERBAL> declarado pelo banco, com seu <DTASOF>.';

create table if not exists public.financial_obligations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  direction text not null check (direction in ('payable','receivable')),
  description text not null check (length(description) between 1 and 200),
  amount_cents bigint not null check (amount_cents > 0),
  currency char(3) not null default 'BRL',
  due_on date not null,
  status text not null default 'open' check (status in ('open','paid','cancelled')),
  paid_on date null,
  paid_cents bigint null check (paid_cents is null or paid_cents >= 0),
  category_id uuid null references public.ledger_categories(id) on delete set null,
  ledger_entry_id uuid null references public.ledger_entries(id) on delete set null,
  reminder_sent_on date null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Regra de negócio em constraint SEPARADA da de vocabulário: duas
  -- constraints `col in (...)` na mesma coluna fazem o extrator do invariante
  -- de vocabulário se recusar a escolher (a lição de `calendar_appointments`).
  constraint financial_obligations_baixa_coerente check (status <> 'paid' or paid_on is not null)
);

create index if not exists idx_financial_obligations_org_status_venc on public.financial_obligations (organization_id, status, due_on);

alter table public.financial_obligations enable row level security;
drop policy if exists financial_obligations_member_select on public.financial_obligations;
create policy financial_obligations_member_select on public.financial_obligations
  for select to authenticated
  using (public.fn_is_platform_admin() or organization_id in (select public.fn_user_org_ids()));
drop policy if exists financial_obligations_manager_write on public.financial_obligations;
create policy financial_obligations_manager_write on public.financial_obligations
  for all to authenticated
  using (public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')))
  with check (public.fn_is_platform_admin() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')));
revoke all on public.financial_obligations from anon;
drop trigger if exists trg_financial_obligations_updated_at on public.financial_obligations;
create trigger trg_financial_obligations_updated_at
  before update on public.financial_obligations
  for each row execute function public.fn_set_updated_at();

comment on column public.financial_obligations.direction is
  'Conta a Pagar e Conta a Receber são uma entrada só no glossário (CONTEXT.md) e uma tabela só aqui. O sinal do compromisso é esta coluna, nunca o valor.';
comment on column public.financial_obligations.reminder_sent_on is
  'Dia do último Lembrete enviado ao Dono. Nasce NULO — quem consultar precisa de `is null or <> hoje`, senão a primeira rodada nunca manda nada e o silêncio parece normalidade.';

notify pgrst, 'reload schema';
