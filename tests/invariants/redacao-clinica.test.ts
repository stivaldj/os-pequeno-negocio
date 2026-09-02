/**
 * A PROVA da Fase 3 (issue #21, ADR-0004, ADR-0019): em Conta de saúde, o
 * texto clínico do Contato não está em lugar NENHUM do banco depois de
 * processado — nem em `messages.body`, nem no preview da conversa, nem no
 * `event_log` que o trigger emite, nem no que o RAG lê. E o não clínico fica
 * íntegro na mesma Conta (ADR-0012).
 *
 * O Postgres efêmero não tem PostgREST, então o preparador TS roda com um
 * admin mínimo e o resultado é gravado por psql — o mesmo `body` e o mesmo
 * `preview` que os cinco ingestores gravariam (`tests/unit/ingestores-passam-pela-redacao`).
 */
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { MARCADOR_CLINICO, prepararEntradaDoContato } from "@/lib/clinica/redacao";
import { TEXTO_DO_AVISO_CFM, instalarAvisoDeIa } from "@/lib/clinica/aviso-de-ia";
import { loadDisclosureTemplate } from "@/lib/agent-engine/guardrails/disclosure/template";
import { disclosureGate } from "@/lib/agent-engine/guardrails/before-send";

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

const ORG = "c11c0000-0000-4000-8000-000000000001";
const SESS = "c11c0000-2222-4000-8000-000000000001";
const CONTATO = "c11c0000-3333-4000-8000-000000000001";
const CONV = "c11c0000-4444-4000-8000-000000000001";

const CLINICO = "tô com dor no peito e tomo losartana 50mg";
const ESCOLHA = "quero marcar com a cardiologista";
const TERMOS = ["losartana", "dor no peito"];

/** Admin mínimo: o preparador só lê `organizations.settings`, e o valor vem do próprio banco. */
function adminQueLeSettingsDoBanco() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            const bruto = sql(`select settings::text from public.organizations where id = '${ORG}';`);
            return { data: { settings: JSON.parse(bruto) }, error: null };
          },
        }),
      }),
    }),
  } as never;
}

function varreduraPorTermo(termo: string): number {
  const out = sql(`
    select
      (select count(*) from public.messages where organization_id = '${ORG}' and (body ilike '%${termo}%' or metadata::text ilike '%${termo}%'))
    + (select count(*) from public.conversations where organization_id = '${ORG}' and coalesce(last_message_preview, '') ilike '%${termo}%')
    + (select count(*) from public.event_log where payload::text ilike '%${termo}%')
    + (select count(*) from public.followup_enrollments where organization_id = '${ORG}' and followup_enrollments::text ilike '%${termo}%')
    + (select count(*) from public.agent_inbox_items where organization_id = '${ORG}' and coalesce(body, '') ilike '%${termo}%')
    + (select count(*) from public.api_audit_log where organization_id = '${ORG}' and coalesce(metadata::text, '') ilike '%${termo}%');
  `);
  return Number(out.split("\n").pop());
}

async function gravar(texto: string, externalId: string): Promise<{ body: string | null; preview: string }> {
  const preparada = await prepararEntradaDoContato(adminQueLeSettingsDoBanco(), ORG, texto);
  const body = preparada.body === null ? "null" : `'${preparada.body.replace(/'/g, "''")}'`;
  const preview = preparada.preview.replace(/'/g, "''");
  sql(`
    insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, direction, status, type, body, external_id, sent_at)
      values ('${ORG}', '${CONV}', '${SESS}', '${CONTATO}', 'inbound', 'delivered', 'text', ${body}, '${externalId}', now());
    select public.fn_mark_conversation_message('${CONV}'::uuid, 'inbound', '${preview}', now());
  `);
  return { body: preparada.body, preview: preparada.preview };
}

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name, settings)
      values ('${ORG}', 'clinica-inv', 'Clínica Invariante', 'Clínica', '{"clinica":{"redacao_clinica":true}}'::jsonb)
      on conflict (id) do nothing;
    insert into public.channel_sessions (id, organization_id, provider, waha_session_name, webhook_secret_encrypted, webhook_path_token)
      values ('${SESS}', '${ORG}', 'fake_channel', 'fake-clinica', '\\x00'::bytea, 'tok-clinica-inv')
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, display_name, phone_number)
      values ('${CONTATO}', '${ORG}', 'Paciente Invariante', '+5565999990001')
      on conflict (id) do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONV}', '${ORG}', '${CONTATO}', '${SESS}', 'open')
      on conflict (id) do nothing;
  `);
});

describe("redação clínica — o texto não está em lugar nenhum", () => {
  it("texto clínico vira marcador em body, no preview da conversa e no event_log", async () => {
    const r = await gravar(CLINICO, "inv-clinico-1");
    expect(r.body).toBe(MARCADOR_CLINICO);
    const linha = sql(`
      select m.body || '|' || coalesce(c.last_message_preview, '') || '|' || coalesce((
        select e.payload->>'body_preview' from public.event_log e
         where e.payload->>'message_id' = m.id::text order by e.created_at desc limit 1
      ), '(sem evento)')
      from public.messages m join public.conversations c on c.id = m.conversation_id
      where m.organization_id = '${ORG}' and m.external_id = 'inv-clinico-1';
    `);
    const [body, preview, evento] = linha.split("|");
    expect(body).toBe(MARCADOR_CLINICO);
    expect(preview).toBe(MARCADOR_CLINICO);
    expect([MARCADOR_CLINICO, "(sem evento)"]).toContain(evento);
  });

  it("varredura: nenhum termo do texto original em nenhuma coluna de texto", () => {
    for (const termo of TERMOS) expect(varreduraPorTermo(termo), termo).toBe(0);
  });

  it("controle: a mensagem não clínica fica íntegra na mesma Conta (ADR-0012)", async () => {
    const r = await gravar(ESCOLHA, "inv-escolha-1");
    expect(r.body).toBe(ESCOLHA);
    const body = sql(`select body from public.messages where organization_id = '${ORG}' and external_id = 'inv-escolha-1';`);
    expect(body).toBe(ESCOLHA);
    expect(sql(`select last_message_preview from public.conversations where id = '${CONV}';`)).toBe(ESCOLHA);
  });

  it("o RAG não tem nada desta Conta", () => {
    expect(sql(`select count(*) from public.ai_chunks where organization_id = '${ORG}';`)).toBe("0");
  });
});

describe("aviso de IA — a primeira mensagem de saída se apresenta (CFM 2.454/2026)", () => {
  it("o template instalado é carregado e o gate injeta o aviso no primeiro envio", async () => {
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
    });
    try {
      await instalarAvisoDeIa(pool, ORG);
      const carregado = await loadDisclosureTemplate(pool, ORG);
      expect(carregado?.body ?? "").toContain("inteligência artificial");

      const template = TEXTO_DO_AVISO_CFM;
      const primeiro = disclosureGate.evaluate({
        body: "Claro! Tenho horário na quinta às 9h.",
        disclosure: { template, isFirstOutbound: true, mode: "inject" },
      } as never);
      expect(primeiro.pass).toBe(true);
      expect((primeiro as { amendBody?: string }).amendBody?.startsWith(template)).toBe(true);

      const segundo = disclosureGate.evaluate({
        body: "Confirmado para quinta às 9h.",
        disclosure: { template, isFirstOutbound: false, mode: "inject" },
      } as never);
      expect((segundo as { amendBody?: string }).amendBody).toBeUndefined();
    } finally {
      await pool.end();
    }
  });
});
