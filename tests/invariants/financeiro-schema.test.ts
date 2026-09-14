/**
 * Migration 0244 (Fase 6): as quatro tabelas do financeiro existem, isolam por
 * organização e só deixam `manager` ou acima escrever. Um `viewer` da própria
 * org lê e não escreve; a org B não vê nada da A.
 *
 * Molde: `tests/invariants/ads-schema.test.ts` (0243).
 *
 * O que este arquivo prova além da RLS, e por quê:
 *
 *   • `unique (organization_id, external_id)` — é a idempotência da importação.
 *     Importar o mesmo extrato duas vezes tem de bater no 23505, não criar
 *     linha. É a asserção que a issue #24 nomeia.
 *   • `ledger_entries.amount_cents` aceita NEGATIVO. O sinal vem do `TRNAMT`
 *     (OFX 2.2 §3.2.9.2), nunca do `TRNTYPE`; uma constraint `>= 0` aqui seria
 *     o bug de sinal que derrubou a biblioteca que não usamos.
 *   • `financial_obligations.amount_cents` recusa zero e negativo — ali o
 *     sinal é a `direction`, não o valor.
 *   • A baixa é coerente: `status = 'paid'` sem `paid_on` não entra. É regra de
 *     negócio, e por isso vive em constraint SEPARADA da de vocabulário — duas
 *     constraints `col in (...)` na mesma coluna quebram o extrator do
 *     invariante de vocabulário (a lição de `calendar_appointments`).
 */
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — run this suite via `pnpm test:db` (scripts/test-db.sh)");
const c: string = container;
function sql(script: string): string {
  return execFileSync("docker", ["exec", "-i", c, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], { input: script, encoding: "utf8" }).trim();
}
function sqlFalha(script: string): string {
  try {
    execFileSync("docker", ["exec", "-i", c, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], { input: script, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return "";
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
}
function como(userId: string, script: string): string {
  return sql(`set role authenticated; select set_config('request.jwt.claims', '{"sub":"${userId}"}', false); ${script}`);
}

const ORG_A = "fc600000-0000-4000-8000-00000000000a";
const ORG_B = "fc600000-0000-4000-8000-00000000000b";
const VIEWER_A = "fc600000-1111-4000-8000-00000000000a";
const MANAGER_A = "fc600000-2222-4000-8000-00000000000a";
const AGENT_B = "fc600000-1111-4000-8000-00000000000b";
const TABELAS = ["financial_obligations", "ledger_balances", "ledger_categories", "ledger_entries"];

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values ('${ORG_A}','fin-inv-a','A','A'), ('${ORG_B}','fin-inv-b','B','B') on conflict (id) do nothing;
    insert into auth.users (id, email) values ('${VIEWER_A}','fin-viewer-a@invariant.test'), ('${MANAGER_A}','fin-manager-a@invariant.test'), ('${AGENT_B}','fin-agent-b@invariant.test') on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${VIEWER_A}','${ORG_A}','viewer',now()), ('${MANAGER_A}','${ORG_A}','manager',now()), ('${AGENT_B}','${ORG_B}','agent',now()) on conflict do nothing;
    insert into public.ledger_categories (organization_id, slug, name, kind, match_terms)
      values ('${ORG_A}','aluguel','Aluguel','expense','{ALUGUEL}') on conflict do nothing;
    insert into public.ledger_entries (organization_id, external_id, account_id, account_kind, posted_on, amount_cents, trn_type, description, key_source, source)
      values ('${ORG_A}','ext-inv-1','00012345','bank','2026-01-05',-123456,'DEBIT','PAGTO ALUGUEL','fitid','ofx') on conflict do nothing;
    insert into public.ledger_balances (organization_id, account_id, account_kind, kind, as_of, balance_cents)
      values ('${ORG_A}','00012345','bank','ledger','2026-01-31', 361254) on conflict do nothing;
    insert into public.financial_obligations (organization_id, direction, description, amount_cents, due_on)
      values ('${ORG_A}','payable','Aluguel de janeiro', 123456, '2026-01-10') on conflict do nothing;
  `);
});

describe("financeiro (0244)", () => {
  it("as quatro tabelas existem com RLS ligada", () => {
    const out = sql(`select string_agg(relname || ':' || relrowsecurity, ',' order by relname) from pg_class where relname in (${TABELAS.map((t) => `'${t}'`).join(",")}) and relnamespace = 'public'::regnamespace;`);
    expect(out).toBe(TABELAS.slice().sort().map((t) => `${t}:true`).join(","));
  });

  it("a org B não vê nada da org A em nenhuma das tabelas", () => {
    for (const t of TABELAS) {
      expect(como(AGENT_B, `select count(*) from public.${t} where organization_id = '${ORG_A}';`).split("\n").pop(), t).toBe("0");
    }
  });

  it("viewer da org A lê e não escreve; manager escreve", () => {
    expect(como(VIEWER_A, `select count(*) from public.financial_obligations where organization_id = '${ORG_A}';`).split("\n").pop()).toBe("1");
    const erro = sqlFalha(`set role authenticated; select set_config('request.jwt.claims', '{"sub":"${VIEWER_A}"}', false);
      insert into public.financial_obligations (organization_id, direction, description, amount_cents, due_on) values ('${ORG_A}','payable','viewer tenta', 100, '2026-02-01');`);
    expect(erro).toMatch(/row-level security/);
    const ok = como(MANAGER_A, `insert into public.financial_obligations (organization_id, direction, description, amount_cents, due_on) values ('${ORG_A}','receivable','manager cria', 100, '2026-02-01') returning description;`);
    expect(ok).toContain("manager cria");
  });

  it("o mesmo external_id não entra duas vezes na mesma Conta — e entra em outra", () => {
    expect(sqlFalha(`insert into public.ledger_entries (organization_id, external_id, account_id, account_kind, posted_on, amount_cents, trn_type, key_source, source)
      values ('${ORG_A}','ext-inv-1','00012345','bank','2026-01-05',-123456,'DEBIT','fitid','ofx');`)).toMatch(/ledger_entries_organization_id_external_id_key/);
    expect(sql(`insert into public.ledger_entries (organization_id, external_id, account_id, account_kind, posted_on, amount_cents, trn_type, key_source, source)
      values ('${ORG_B}','ext-inv-1','99999999','bank','2026-01-05',-1,'DEBIT','fitid','ofx') returning external_id;`)).toContain("ext-inv-1");
  });

  it("o lançamento é ASSINADO e a obrigação não", () => {
    expect(sql(`select amount_cents from public.ledger_entries where organization_id = '${ORG_A}' and external_id = 'ext-inv-1';`)).toBe("-123456");
    expect(sqlFalha(`insert into public.financial_obligations (organization_id, direction, description, amount_cents, due_on) values ('${ORG_A}','payable','zero', 0, '2026-02-01');`)).toMatch(/financial_obligations_amount_cents_check/);
  });

  it("baixa sem data de pagamento não entra", () => {
    expect(sqlFalha(`insert into public.financial_obligations (organization_id, direction, description, amount_cents, due_on, status) values ('${ORG_A}','payable','paga sem data', 100, '2026-02-01','paid');`)).toMatch(/financial_obligations_baixa_coerente/);
    expect(sql(`insert into public.financial_obligations (organization_id, direction, description, amount_cents, due_on, status, paid_on, paid_cents) values ('${ORG_A}','payable','paga com data', 100, '2026-02-01','paid','2026-02-01',100) returning status;`).split("\n")[0]).toBe("paid");
  });

  it("os vocabulários recusam valor de fora da lista", () => {
    expect(sqlFalha(`insert into public.ledger_entries (organization_id, external_id, account_id, account_kind, posted_on, amount_cents, trn_type, key_source, source) values ('${ORG_A}','v1','1','bank','2026-01-05',1,'PIX','fitid','ofx');`)).toMatch(/ledger_entries_trn_type_check/);
    expect(sqlFalha(`insert into public.ledger_entries (organization_id, external_id, account_id, account_kind, posted_on, amount_cents, trn_type, key_source, source) values ('${ORG_A}','v2','1','poupanca','2026-01-05',1,'DEBIT','fitid','ofx');`)).toMatch(/ledger_entries_account_kind_check/);
    expect(sqlFalha(`insert into public.ledger_entries (organization_id, external_id, account_id, account_kind, posted_on, amount_cents, trn_type, key_source, source) values ('${ORG_A}','v3','1','bank','2026-01-05',1,'DEBIT','memo','ofx');`)).toMatch(/ledger_entries_key_source_check/);
    expect(sqlFalha(`insert into public.ledger_categories (organization_id, slug, name, kind) values ('${ORG_A}','x','X','despesa');`)).toMatch(/ledger_categories_kind_check/);
    expect(sqlFalha(`insert into public.financial_obligations (organization_id, direction, description, amount_cents, due_on) values ('${ORG_A}','saida','x', 1, '2026-02-01');`)).toMatch(/financial_obligations_direction_check/);
    expect(sqlFalha(`insert into public.ledger_balances (organization_id, account_id, account_kind, kind, as_of, balance_cents) values ('${ORG_A}','1','bank','contabil','2026-01-31',1);`)).toMatch(/ledger_balances_kind_check/);
  });

  it("o saldo é único por conta, tipo e dia — reimportar o mesmo extrato não empilha saldo", () => {
    expect(sqlFalha(`insert into public.ledger_balances (organization_id, account_id, account_kind, kind, as_of, balance_cents) values ('${ORG_A}','00012345','bank','ledger','2026-01-31', 999);`))
      .toMatch(/ledger_balances_conta_tipo_dia_key/);
  });

  it("anon não tem grant em nenhuma das quatro", () => {
    const out = sql(`select coalesce(string_agg(distinct table_name, ','), '') from information_schema.role_table_grants
      where grantee = 'anon' and table_schema = 'public' and table_name in (${TABELAS.map((t) => `'${t}'`).join(",")});`);
    expect(out).toBe("");
  });

  it("updated_at anda sozinho nas quatro", () => {
    for (const t of TABELAS) {
      const out = sql(`update public.${t} set updated_at = '2000-01-01' where organization_id = '${ORG_A}';
        update public.${t} set organization_id = organization_id where organization_id = '${ORG_A}';
        select count(*) from public.${t} where organization_id = '${ORG_A}' and updated_at > '2020-01-01';`);
      expect(Number(out.split("\n").pop()), t).toBeGreaterThan(0);
    }
  });
});
