/**
 * O banco aceita `fake_channel` como provider de sessão (migration 0239) sem
 * afrouxar nada: o `provider_ref_check` continua exigindo a ref, e o isolamento
 * entre organizações continua valendo para a sessão fake como para qualquer
 * outra.
 */
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — run this suite via `pnpm test:db` (scripts/test-db.sh)");
}
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

const ORG_A = "fa0eaaaa-0000-4000-8000-000000000001";
const ORG_B = "fa0ebbbb-0000-4000-8000-000000000002";
const USER_B = "fa0ebbbb-1111-4000-8000-000000000002";

function countAs(userId: string, countQuery: string): number {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${countQuery}
  `);
  const last = out.split("\n").pop() ?? "";
  if (!/^\d+$/.test(last)) throw new Error(`unexpected psql output: ${out}`);
  return Number(last);
}

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_A}', 'fake-inv-a', 'Fake A', 'Fake A'), ('${ORG_B}', 'fake-inv-b', 'Fake B', 'Fake B')
      on conflict (id) do nothing;
    insert into auth.users (id, email) values ('${USER_B}', 'fake-b@invariant.test') on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${USER_B}', '${ORG_B}', 'agent', now()) on conflict do nothing;
  `);
});

describe("fake_channel no banco", () => {
  it("o CHECK de provider aceita fake_channel com waha_session_name como ref", () => {
    const out = sql(`
      insert into public.channel_sessions (organization_id, provider, waha_session_name, webhook_secret_encrypted, webhook_path_token)
        values ('${ORG_A}', 'fake_channel', 'fake-fa0eaaaa', '\\x00'::bytea, 'tok-fake-a')
        on conflict do nothing;
      select count(*) from public.channel_sessions where organization_id = '${ORG_A}' and provider = 'fake_channel';
    `);
    expect(out.split("\n").pop()).toBe("1");
  });

  it("sem a ref, o provider_ref_check recusa", () => {
    const erro = sqlFalha(`
      insert into public.channel_sessions (organization_id, provider, webhook_secret_encrypted, webhook_path_token)
        values ('${ORG_A}', 'fake_channel', '\\x00'::bytea, 'tok-fake-a2');
    `);
    expect(erro).toMatch(/channel_sessions_provider_ref_check/);
  });

  it("a organização B não vê a sessão fake da A", () => {
    expect(
      countAs(USER_B, `select count(*) from public.channel_sessions where organization_id = '${ORG_A}';`),
    ).toBe(0);
  });
});
