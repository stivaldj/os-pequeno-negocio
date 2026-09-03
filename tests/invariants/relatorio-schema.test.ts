/**
 * Migration 0210 (Fase 7): `daily_reports` existe, isola por organização e só
 * deixa `manager` ou acima escrever. Um `viewer` da própria org lê e não
 * escreve; a org B não vê nada da A. `unique (organization_id, report_date)`
 * é a idempotência do cron — molde de `tests/invariants/ads-schema.test.ts`.
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

const ORG_A = "de100000-0000-4000-8000-00000000000a";
const ORG_B = "de100000-0000-4000-8000-00000000000b";
const VIEWER_A = "de100000-1111-4000-8000-00000000000a";
const MANAGER_A = "de100000-2222-4000-8000-00000000000a";
const AGENT_B = "de100000-1111-4000-8000-00000000000b";

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values ('${ORG_A}','relatorio-inv-a','A','A'), ('${ORG_B}','relatorio-inv-b','B','B') on conflict (id) do nothing;
    insert into auth.users (id, email) values ('${VIEWER_A}','relatorio-viewer-a@invariant.test'), ('${MANAGER_A}','relatorio-manager-a@invariant.test'), ('${AGENT_B}','relatorio-agent-b@invariant.test') on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${VIEWER_A}','${ORG_A}','viewer',now()), ('${MANAGER_A}','${ORG_A}','manager',now()), ('${AGENT_B}','${ORG_B}','agent',now()) on conflict do nothing;
    insert into public.daily_reports (organization_id, report_date, body) values ('${ORG_A}','2026-09-03','Relatório de teste') on conflict do nothing;
  `);
});

describe("relatório das 8h — daily_reports (0210)", () => {
  it("a tabela existe com RLS ligada", () => {
    const out = sql(`select relrowsecurity from pg_class where relname = 'daily_reports' and relnamespace = 'public'::regnamespace;`);
    expect(out).toBe("t");
  });

  it("a org B não vê o relatório da org A", () => {
    expect(como(AGENT_B, `select count(*) from public.daily_reports where organization_id = '${ORG_A}';`).split("\n").pop()).toBe("0");
  });

  it("viewer da org A lê e não escreve; manager escreve", () => {
    expect(como(VIEWER_A, `select count(*) from public.daily_reports where organization_id = '${ORG_A}';`).split("\n").pop()).toBe("1");
    const erro = sqlFalha(`set role authenticated; select set_config('request.jwt.claims', '{"sub":"${VIEWER_A}"}', false);
      insert into public.daily_reports (organization_id, report_date, body) values ('${ORG_A}','2026-09-04','viewer tenta');`);
    expect(erro).toMatch(/row-level security/);
    const ok = como(MANAGER_A, `insert into public.daily_reports (organization_id, report_date, body) values ('${ORG_A}','2026-09-04','manager cria') returning report_date;`);
    expect(ok).toContain("2026-09-04");
  });

  it("unique (organization_id, report_date): a idempotência do cron é do banco, não da aplicação", () => {
    expect(sqlFalha(`insert into public.daily_reports (organization_id, report_date, body) values ('${ORG_A}','2026-09-03','segunda tentativa no mesmo dia');`)).toMatch(
      /daily_reports_organization_id_report_date_key/,
    );
    // A org B pode ter um relatório NO MESMO DIA — a chave é por organização.
    const ok = sql(`insert into public.daily_reports (organization_id, report_date, body) values ('${ORG_B}','2026-09-03','org B, mesmo dia') returning report_date;`);
    expect(ok).toContain("2026-09-03");
  });

  it("status só aceita enviado/falhou, e anon não tem grant nenhum", () => {
    expect(sqlFalha(`insert into public.daily_reports (organization_id, report_date, body, status) values ('${ORG_A}','2026-09-05','x','pendente');`)).toMatch(
      /daily_reports_status_check/,
    );
    expect(sql(`select has_table_privilege('anon', 'public.daily_reports', 'SELECT');`)).toBe("f");
  });
});
