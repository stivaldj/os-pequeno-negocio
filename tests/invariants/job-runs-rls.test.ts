import { beforeAll, describe, expect, it } from "vitest";

import { countAs, lastLine, sql } from "./gov-helpers";

/**
 * `job_runs` — toda rotina do scheduler deixa rastro (migration 0240).
 *
 * A tabela é de PLATAFORMA, não de tenant: uma rotina de cron roda para a
 * instalação inteira, e `organization_id` é nulo na quase totalidade das linhas
 * (o mesmo desenho de `agent_inbox_items`). Por isso ela NÃO entra em
 * `rls-isolation.test.ts` — aquele teste é sobre duas orgs não se verem, e aqui
 * não há org para ver. O que se prova é outra coisa:
 *
 *   - o service role escreve (é quem grava cada execução);
 *   - `anon` não lê nada (a anon key vai para o browser);
 *   - usuário autenticado COMUM não lê nada, mesmo sendo admin da sua org —
 *     o histórico de rotinas é operação da instalação, não do tenant;
 *   - platform admin lê — é a única persona a quem a policy abre.
 */

const ORG = "dddddddd-0000-4000-8000-000000000001";
const USER_COMUM = "dddddddd-1111-4000-8000-000000000001";
const USER_PLATFORM = "dddddddd-1111-4000-8000-000000000002";

const CONTAGEM = "select count(*) from public.job_runs where job_name = 'x';";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${USER_COMUM}', 'job-runs-comum@invariant.test'),
      ('${USER_PLATFORM}', 'job-runs-platform@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'job-runs-inv', 'Job Runs Invariant', 'Job Runs')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${USER_COMUM}', '${ORG}', 'admin', now())
      on conflict do nothing;
    insert into public.platform_admins (user_id, granted_by, reason)
      values ('${USER_PLATFORM}', '${USER_COMUM}', 'invariante de job_runs')
      on conflict do nothing;
  `);
});

describe("job_runs — quem escreve e quem lê", () => {
  it("o service role insere a linha mínima { job_name, status }", () => {
    // Superusuário do container = o que o service role é para a RLS (bypassa).
    sql(`insert into public.job_runs (job_name, status) values ('x', 'ok');`);
    expect(lastLine(sql(CONTAGEM))).toBe("1");
  });

  it("o CHECK de status recusa vocabulário inventado", () => {
    expect(() =>
      sql(`insert into public.job_runs (job_name, status) values ('x', 'bogus');`),
    ).toThrow(/job_runs_status_check|check constraint/);
  });

  it("`anon` não lê: zero linhas ou permissão negada", () => {
    let saida: string;
    try {
      saida = sql(`set role anon; ${CONTAGEM}`);
    } catch (err) {
      const texto = err instanceof Error ? `${err.message} ${String((err as { stderr?: string }).stderr ?? "")}` : String(err);
      expect(texto).toMatch(/permission denied/);
      return;
    }
    expect(lastLine(saida)).toBe("0");
  });

  it("usuário autenticado comum (admin da própria org) não lê nada", () => {
    expect(countAs(USER_COMUM, CONTAGEM)).toBe(0);
  });

  it("platform admin lê — controle positivo da policy", () => {
    expect(countAs(USER_PLATFORM, CONTAGEM)).toBeGreaterThanOrEqual(1);
  });
});
