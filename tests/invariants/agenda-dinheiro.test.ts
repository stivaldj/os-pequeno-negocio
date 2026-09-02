/**
 * Migration 0207 (ADR-0017): preço e Margem Declarada no serviço, valor pago
 * no Agendamento. Dinheiro em centavos, margem em pontos-base, nada negativo;
 * valor pago nulo é dado FALTANTE (a recepção não digitou), nunca zero.
 */
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — run this suite via `pnpm test:db` (scripts/test-db.sh)");
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}
function sqlFalha(script: string): string {
  try {
    execFileSync(
      "docker",
      ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
      { input: script, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return "";
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
}

const ORG_A = "d1a70000-0000-4000-8000-00000000000a";
const ORG_B = "d1a70000-0000-4000-8000-00000000000b";
const USER_B = "d1a70000-1111-4000-8000-00000000000b";
const TIPO_A = "d1a70000-5555-4000-8000-00000000000a";

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_A}', 'dinheiro-a', 'A', 'A'), ('${ORG_B}', 'dinheiro-b', 'B', 'B') on conflict (id) do nothing;
    insert into auth.users (id, email) values ('${USER_B}', 'dinheiro-b@invariant.test') on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${USER_B}', '${ORG_B}', 'agent', now()) on conflict do nothing;
    insert into public.calendar_event_types (id, organization_id, name, slug, category, duration_minutes, location_kind, price_cents, margin_bps)
      values ('${TIPO_A}', '${ORG_A}', 'Consulta', 'consulta', 'consulta', 30, 'in_person', 20000, 6000)
      on conflict (organization_id, slug) do nothing;
  `);
});

describe("dinheiro na agenda (0207)", () => {
  it("as colunas existem com os tipos certos", () => {
    const out = sql(`
      select column_name || ':' || data_type || ':' || is_nullable from information_schema.columns
       where table_schema = 'public' and (
         (table_name = 'calendar_event_types' and column_name in ('price_cents','margin_bps')) or
         (table_name = 'calendar_appointments' and column_name in ('paid_cents','paid_currency')))
       order by 1;
    `);
    expect(out.split("\n")).toEqual([
      "margin_bps:integer:YES",
      "paid_cents:bigint:YES",
      "paid_currency:character:NO",
      "price_cents:bigint:YES",
    ]);
  });

  it("o seed existe e os CHECKs estão no catálogo (controle positivo)", () => {
    expect(sql(`select count(*) from public.calendar_event_types where id = '${TIPO_A}';`)).toBe("1");
    const cons = sql(`select string_agg(conname, ',' order by conname) from pg_constraint
      where conname in ('calendar_event_types_price_cents_check','calendar_event_types_margin_bps_check','calendar_appointments_paid_cents_check');`);
    expect(cons).toBe("calendar_appointments_paid_cents_check,calendar_event_types_margin_bps_check,calendar_event_types_price_cents_check");
  });

  it("margem fora de 0..10000 pontos-base é recusada", () => {
    expect(sqlFalha(`update public.calendar_event_types set margin_bps = 10001 where id = '${TIPO_A}';`)).toMatch(/margin_bps/);
    expect(sqlFalha(`update public.calendar_event_types set margin_bps = -1 where id = '${TIPO_A}';`)).toMatch(/margin_bps/);
  });

  it("preço e valor pago negativos são recusados", () => {
    expect(sqlFalha(`update public.calendar_event_types set price_cents = -1 where id = '${TIPO_A}';`)).toMatch(/price_cents/);
    expect(
      sqlFalha(`
        insert into public.calendar_appointments (organization_id, event_type_id, title, starts_at, ends_at, time_zone, status, paid_cents)
          values ('${ORG_A}', '${TIPO_A}', 'x', now(), now() + interval '30 min', 'America/Cuiaba', 'completed', -1);
      `),
    ).toMatch(/paid_cents/);
  });

  it("a organização B não vê o serviço com preço da A", () => {
    const out = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${USER_B}"}', false);
      select count(*) from public.calendar_event_types where organization_id = '${ORG_A}';
    `);
    expect(out.split("\n").pop()).toBe("0");
  });
});
