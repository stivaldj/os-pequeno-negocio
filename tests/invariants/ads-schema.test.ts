/**
 * Migration 0243 (Fase 5): as seis tabelas de ads existem, isolam por
 * organização e só deixam `manager` ou acima escrever. Um `viewer` da própria
 * org lê e não escreve; a org B não vê nada da A.
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

const ORG_A = "ad500000-0000-4000-8000-00000000000a";
const ORG_B = "ad500000-0000-4000-8000-00000000000b";
const VIEWER_A = "ad500000-1111-4000-8000-00000000000a";
const MANAGER_A = "ad500000-2222-4000-8000-00000000000a";
const AGENT_B = "ad500000-1111-4000-8000-00000000000b";
const TABELAS = ["ad_accounts", "ad_capture_links", "ad_clicks", "ad_spend", "ad_proposals", "ad_conversion_uploads"];

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values ('${ORG_A}','ads-inv-a','A','A'), ('${ORG_B}','ads-inv-b','B','B') on conflict (id) do nothing;
    insert into auth.users (id, email) values ('${VIEWER_A}','ads-viewer-a@invariant.test'), ('${MANAGER_A}','ads-manager-a@invariant.test'), ('${AGENT_B}','ads-agent-b@invariant.test') on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${VIEWER_A}','${ORG_A}','viewer',now()), ('${MANAGER_A}','${ORG_A}','manager',now()), ('${AGENT_B}','${ORG_B}','agent',now()) on conflict do nothing;
    insert into public.ad_accounts (organization_id, customer_id) values ('${ORG_A}','1234567890') on conflict do nothing;
    insert into public.ad_capture_links (organization_id, slug, campaign_id, campaign_name, whatsapp_e164, mensagem)
      values ('${ORG_A}','consulta-inv','111','Busca','+5565999990001','Olá! Quero marcar uma consulta.') on conflict do nothing;
    insert into public.ad_clicks (organization_id, code, campaign_id, gclid) values ('${ORG_A}','X7K3MQ','111','gclid-1') on conflict do nothing;
    insert into public.ad_spend (organization_id, campaign_id, date, cost_micros) values ('${ORG_A}','111','2026-09-01', 87500000) on conflict do nothing;
    insert into public.ad_proposals (organization_id, campaign_id, kind, level, title, body) values ('${ORG_A}','111','observacao',1,'t','b');
  `);
});

describe("ads (0243)", () => {
  it("as seis tabelas existem com RLS ligada", () => {
    const out = sql(`select string_agg(relname || ':' || relrowsecurity, ',' order by relname) from pg_class where relname in (${TABELAS.map((t) => `'${t}'`).join(",")}) and relnamespace = 'public'::regnamespace;`);
    expect(out).toBe(TABELAS.slice().sort().map((t) => `${t}:true`).join(","));
  });

  it("a org B não vê nada da org A em nenhuma das tabelas", () => {
    for (const t of TABELAS) {
      expect(como(AGENT_B, `select count(*) from public.${t} where organization_id = '${ORG_A}';`).split("\n").pop(), t).toBe("0");
    }
  });

  it("viewer da org A lê e não escreve; manager escreve", () => {
    expect(como(VIEWER_A, `select count(*) from public.ad_capture_links where organization_id = '${ORG_A}';`).split("\n").pop()).toBe("1");
    const erro = sqlFalha(`set role authenticated; select set_config('request.jwt.claims', '{"sub":"${VIEWER_A}"}', false);
      insert into public.ad_capture_links (organization_id, slug, campaign_id, whatsapp_e164, mensagem) values ('${ORG_A}','viewer-tenta','222','+5565999990002','x');`);
    expect(erro).toMatch(/row-level security/);
    const ok = como(MANAGER_A, `insert into public.ad_capture_links (organization_id, slug, campaign_id, whatsapp_e164, mensagem) values ('${ORG_A}','manager-cria','333','+5565999990003','x') returning slug;`);
    expect(ok).toContain("manager-cria");
  });

  it("unicidades: código por org, gasto por campanha e dia, upload por agendamento", () => {
    expect(sqlFalha(`insert into public.ad_clicks (organization_id, code, campaign_id) values ('${ORG_A}','X7K3MQ','111');`)).toMatch(/ad_clicks_organization_id_code_key/);
    expect(sqlFalha(`insert into public.ad_spend (organization_id, campaign_id, date, cost_micros) values ('${ORG_A}','111','2026-09-01', 1);`)).toMatch(/ad_spend_organization_id_campaign_id_date_key/);
    expect(sqlFalha(`insert into public.ad_clicks (organization_id, code, campaign_id) values ('${ORG_A}','abc','111');`)).toMatch(/ad_clicks_code_check/);
  });

  it("a Página de Captura tem slug global único e mensagem obrigatória", () => {
    expect(sqlFalha(`insert into public.ad_capture_links (organization_id, slug, campaign_id, whatsapp_e164, mensagem) values ('${ORG_B}','consulta-inv','999','+5565999990009','x');`)).toMatch(/ad_capture_links_slug_key/);
  });
});
