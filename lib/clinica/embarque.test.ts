import fs from "node:fs";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { TEXTO_DO_AVISO_CFM } from "@/lib/clinica/aviso-de-ia";
import { TETO_TOOLS_POR_AGENTE } from "@/lib/mcp/tools/selecao-por-pacote";

import {
  capacidadesDaClinica,
  embarqueSchema,
  executarEmbarque,
  memoriaDaClinica,
  type Embarque,
} from "./embarque";
import { PLAYBOOK_DA_CLINICA } from "./playbook";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

// ─── dublês ─────────────────────────────────────────────────────────────────

interface Chamada {
  m: string;
  args: unknown[];
}
interface Op {
  table: string;
  chain: Chamada[];
}
type Resolver = (op: Op) => unknown;

/**
 * Um `SupabaseClient` de mentira: grava cada cadeia `from(...).x().y()` em
 * `ops` e, no `await`, devolve `{ data: resolver(op), error: null }`. O teste
 * afirma sobre as operações registradas, não sobre um banco.
 */
function adminFalso(resolver: Resolver): { admin: SupabaseClient; ops: Op[] } {
  const ops: Op[] = [];
  const admin = {
    from(table: string) {
      const op: Op = { table, chain: [] };
      ops.push(op);
      const builder: unknown = new Proxy(
        {},
        {
          get(_alvo, prop) {
            if (prop === "then") {
              return (res: (v: unknown) => void, rej: (e: unknown) => void) => {
                try {
                  res({ data: resolver(op), error: null });
                } catch (e) {
                  rej(e);
                }
              };
            }
            return (...args: unknown[]) => {
              op.chain.push({ m: String(prop), args });
              return builder;
            };
          },
        },
      );
      return builder;
    },
  };
  return { admin: admin as unknown as SupabaseClient, ops };
}

const tem = (op: Op, m: string): boolean => op.chain.some((c) => c.m === m);
const carga = (op: Op): Record<string, unknown> =>
  (op.chain.find((c) => c.m === "insert" || c.m === "update" || c.m === "upsert")?.args[0] ??
    {}) as Record<string, unknown>;
const opsDe = (ops: Op[], table: string, m: string): Op[] =>
  ops.filter((o) => o.table === table && tem(o, m));

function poolFalso(opts: {
  usuarios: Array<{ id: string; email: string }>;
  playbookJaPublicado?: boolean;
}): { pool: pg.Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/from auth\.users/.test(sql)) {
      const pedidos = params[1] as string[];
      const rows = opts.usuarios.filter((u) => pedidos.includes(u.email));
      return { rows, rowCount: rows.length };
    }
    if (/insert into playbook_pointers/.test(sql)) return { rows: [], rowCount: 1 };
    if (/insert into playbook_versions/.test(sql)) {
      return {
        rows: [{ id: PB_NOVO, organization_id: params[0], layer: params[1], content: params[2] }],
        rowCount: 1,
      };
    }
    if (/from playbook_versions/.test(sql)) {
      const rows = opts.playbookJaPublicado ? [{ id: PB_EXISTENTE }] : [];
      return { rows, rowCount: rows.length };
    }
    if (/insert into disclosure_template_versions/.test(sql)) {
      return { rows: [{ id: DISC }], rowCount: 1 };
    }
    if (/disclosure_template_pointers/.test(sql)) return { rows: [], rowCount: 1 };
    throw new Error(`SQL inesperado no pool falso: ${sql}`);
  });
  return { pool: { query } as unknown as pg.Pool, query };
}

// ─── dados ──────────────────────────────────────────────────────────────────

const ORG = "11111111-1111-4111-8111-111111111111";
const PIPE = "22222222-2222-4222-8222-222222222222";
const AGENTE = "33333333-3333-4333-8333-333333333333";
const V1 = "44444444-4444-4444-8444-444444444444";
const V2 = "55555555-5555-4555-8555-555555555555";
const USER_DRA = "66666666-6666-4666-8666-666666666666";
const PB_NOVO = "77777777-7777-4777-8777-777777777777";
const PB_EXISTENTE = "88888888-8888-4888-8888-888888888888";
const DISC = "99999999-9999-4999-8999-999999999999";
const CANAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const EXPEDIENTE = {
  timezone: "America/Cuiaba",
  windows: [1, 2, 3, 4, 5].map((dow) => ({ dow, start: "07:00", end: "19:30" })),
};

const DADOS: Embarque = embarqueSchema.parse({
  organization_id: ORG,
  dono: { nome: "Dona Exemplo", whatsapp: "+5565999990000" },
  endereco: "Av. Brigadeiro Eduardo Gomes, 508 — Centro-Sul, Várzea Grande-MT",
  convenios: ["Unimed"],
  expediente_da_clinica: EXPEDIENTE,
  profissionais: [
    { email: "Dra@clinica.invalid", nome: "Dra. A" },
    {
      email: "ninguem@clinica.invalid",
      nome: "Dr. B",
      expediente: { timezone: "America/Cuiaba", windows: [{ dow: 2, start: "08:00", end: "12:00" }] },
    },
  ],
  servicos: [
    {
      slug: "consulta-clinica-geral",
      nome: "Clínica geral",
      duracao_minutos: 30,
      price_cents: 20000,
      margin_bps: 6000,
      profissional_email: "dra@clinica.invalid",
      lembrete_minutos_antes: 1440,
    },
    { slug: "pilates", nome: "Pilates", duracao_minutos: 60, categoria: "procedimento" },
  ],
});

const VERSAO_PUBLICADA = {
  id: V1,
  organization_id: ORG,
  agent_id: AGENTE,
  version_number: 1,
  system_prompt: "Você atende os pacientes da Clínica Humana.",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  credential_id: null,
  tool_ids: ["crm_search_contacts"],
  channel_session_id: CANAL,
  pipeline_ids: [PIPE],
  status: "published",
  published_at: "2026-09-01T00:00:00Z",
  superseded_at: null,
  created_at: "2026-09-01T00:00:00Z",
  created_by: USER_DRA,
  handoff_tool_enabled: false,
};

function resolverPadrao(sobrescritas: Partial<Record<string, Resolver>> = {}): Resolver {
  return (op) => {
    const proprio = sobrescritas[op.table];
    if (proprio) return proprio(op);
    switch (op.table) {
      case "organizations":
        return tem(op, "update") ? null : { id: ORG, settings: { branding: { nome: "Humana" } } };
      case "crm_pipelines":
        return tem(op, "update")
          ? null
          : { id: PIPE, vocabulary: { lead: "Cliente", lost: "Cancelado" } };
      case "crm_stages":
        return tem(op, "insert")
          ? null
          : [
              { slug: "novo", position: 1000 },
              { slug: "agendado", position: 2000 },
            ];
      case "org_memory_versions":
        return tem(op, "insert") ? { id: "mem", version_number: 1 } : null;
      case "org_memory_pointers":
        return null;
      case "ai_agents":
        return tem(op, "update") ? null : { id: AGENTE, published_version_id: V1 };
      case "ai_agent_versions":
        if (tem(op, "insert")) return { id: V2 };
        if (tem(op, "update")) return null;
        return VERSAO_PUBLICADA;
      default:
        return null;
    }
  };
}

beforeEach(() => {
  vi.mocked(audit).mockClear();
});

// ─── schema ─────────────────────────────────────────────────────────────────

describe("embarqueSchema", () => {
  it("recusa arquivo sem serviço", () => {
    const r = embarqueSchema.safeParse({ ...DADOS, servicos: [] });
    expect(r.success).toBe(false);
  });

  it("recusa margem fora de 0..10000 bps e preço negativo", () => {
    const base = DADOS.servicos[0]!;
    expect(
      embarqueSchema.safeParse({ ...DADOS, servicos: [{ ...base, margin_bps: 10001 }] }).success,
    ).toBe(false);
    expect(
      embarqueSchema.safeParse({ ...DADOS, servicos: [{ ...base, price_cents: -1 }] }).success,
    ).toBe(false);
  });

  it("recusa slug fora do formato e serviço apontando para profissional que não está na lista", () => {
    const base = DADOS.servicos[0]!;
    expect(
      embarqueSchema.safeParse({ ...DADOS, servicos: [{ ...base, slug: "Clínica Geral" }] }).success,
    ).toBe(false);
    expect(
      embarqueSchema.safeParse({
        ...DADOS,
        servicos: [{ ...base, profissional_email: "outro@clinica.invalid" }],
      }).success,
    ).toBe(false);
  });

  it("normaliza e-mails para minúsculas e preenche o expediente do profissional com o da clínica", () => {
    expect(DADOS.profissionais[0]!.email).toBe("dra@clinica.invalid");
    expect(DADOS.profissionais[0]!.expediente).toEqual(EXPEDIENTE);
    expect(DADOS.profissionais[1]!.expediente.windows).toHaveLength(1);
  });

  it("aceita o arquivo de exemplo da Clínica Humana (14 serviços, seg–sex 07:00–19:30)", () => {
    const arquivo = path.resolve(process.cwd(), "scripts/clinica/embarque.exemplo.json");
    const r = embarqueSchema.safeParse(JSON.parse(fs.readFileSync(arquivo, "utf8")));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.servicos).toHaveLength(14);
    expect(new Set(r.data.servicos.map((s) => s.slug)).size).toBe(14);
    expect(r.data.servicos.every((s) => s.price_cents === undefined)).toBe(true);
    expect(r.data.expediente_da_clinica.timezone).toBe("America/Cuiaba");
    expect(r.data.expediente_da_clinica.windows.map((w) => w.dow)).toEqual([1, 2, 3, 4, 5]);
    expect(r.data.convenios).toEqual([]);
    expect(r.data.endereco).toContain("Várzea Grande");
  });
});

// ─── capacidades ────────────────────────────────────────────────────────────

describe("capacidadesDaClinica", () => {
  it("vem dos pacotes (agenda + conhecimento), cabe no teto e preserva o que já estava ligado", () => {
    const lista = capacidadesDaClinica(["crm_search_contacts"]);
    expect(lista.length).toBeLessThanOrEqual(TETO_TOOLS_POR_AGENTE);
    for (const tool of [
      "crm_list_event_types",
      "crm_find_free_slots",
      "crm_book_appointment",
      "crm_confirm_appointment",
      "crm_search_knowledge",
      "crm_search_contacts",
    ]) {
      expect(lista).toContain(tool);
    }
    // crítica nunca entra por pacote
    expect(lista).not.toContain("crm_cancel_appointment");
  });
});

// ─── memória ────────────────────────────────────────────────────────────────

describe("memoriaDaClinica", () => {
  it("leva endereço, expediente legível e convênios; nunca o WhatsApp do Dono", () => {
    const texto = memoriaDaClinica(DADOS);
    expect(texto).toContain("Várzea Grande");
    expect(texto).toMatch(/segunda a sexta/i);
    expect(texto).toContain("07:00");
    expect(texto).toContain("19:30");
    expect(texto).toContain("Unimed");
    expect(texto).not.toContain("+5565999990000");
  });

  it("sem convênio cadastrado, manda confirmar com a equipe em vez de inventar", () => {
    const texto = memoriaDaClinica({ ...DADOS, convenios: [] });
    expect(texto).toMatch(/convênio/i);
    expect(texto).toMatch(/equipe/i);
  });
});

// ─── executarEmbarque ───────────────────────────────────────────────────────

describe("executarEmbarque", () => {
  it("coloca a clínica no ar e devolve o relatório completo", async () => {
    const { admin, ops } = adminFalso(resolverPadrao());
    const { pool, query } = poolFalso({ usuarios: [{ id: USER_DRA, email: "dra@clinica.invalid" }] });

    const r = await executarEmbarque(admin, pool, DADOS);

    // redação clínica ligada, sem perder o resto do settings
    const [org] = opsDe(ops, "organizations", "update");
    expect(org).toBeDefined();
    expect(carga(org!).settings).toEqual({
      branding: { nome: "Humana" },
      clinica: { redacao_clinica: true },
    });
    expect(org!.chain.find((c) => c.m === "eq")?.args).toEqual(["id", ORG]);

    // vocabulário do funil: merge não destrutivo, mesmo jeito da server action
    const [funil] = opsDe(ops, "crm_pipelines", "update");
    expect(carga(funil!).vocabulary).toEqual({
      lead: "Paciente",
      lost: "Cancelado",
      won: "Agendado",
    });

    // só a etapa que falta nasce, depois da última
    const etapas = opsDe(ops, "crm_stages", "insert");
    expect(etapas).toHaveLength(1);
    expect(carga(etapas[0]!)).toMatchObject({
      organization_id: ORG,
      pipeline_id: PIPE,
      slug: "agendamento-solicitado",
      position: 3000,
    });

    // expediente: só quem existe na org
    const jornadas = opsDe(ops, "attendant_availability", "upsert");
    expect(jornadas).toHaveLength(1);
    expect(carga(jornadas[0]!)).toEqual({
      organization_id: ORG,
      user_id: USER_DRA,
      is_available: true,
      schedule: EXPEDIENTE,
    });
    expect(jornadas[0]!.chain.find((c) => c.m === "upsert")?.args[1]).toEqual({
      onConflict: "organization_id,user_id",
    });
    expect(r.pulado).toContainEqual({
      item: "profissional:ninguem@clinica.invalid",
      motivo: "usuario_inexistente",
    });

    // tipos por slug, com preço, margem, lembrete e dono
    const tipos = opsDe(ops, "calendar_event_types", "upsert");
    expect(tipos).toHaveLength(2);
    expect(carga(tipos[0]!)).toEqual({
      organization_id: ORG,
      slug: "consulta-clinica-geral",
      name: "Clínica geral",
      category: "consulta",
      duration_minutes: 30,
      is_active: true,
      price_cents: 20000,
      margin_bps: 6000,
      reminder_enabled: true,
      reminder_minutes_before: 1440,
      default_owner_user_id: USER_DRA,
    });
    expect(tipos[0]!.chain.find((c) => c.m === "upsert")?.args[1]).toEqual({
      onConflict: "organization_id,slug",
    });
    // sem lembrete no arquivo, o tipo não é tocado nisso; sem preço, preço não é sobrescrito
    expect(carga(tipos[1]!)).toEqual({
      organization_id: ORG,
      slug: "pilates",
      name: "Pilates",
      category: "procedimento",
      duration_minutes: 60,
      is_active: true,
    });

    // playbook tenant: versão nova (não havia por md5) e ponteiro movido
    const sqlPlaybook = query.mock.calls.map(([sql]) => String(sql));
    expect(sqlPlaybook.some((s) => /insert into playbook_versions/.test(s))).toBe(true);
    const inserida = query.mock.calls.find(([sql]) => /insert into playbook_versions/.test(String(sql)));
    expect(inserida?.[1]).toEqual([ORG, "tenant", PLAYBOOK_DA_CLINICA]);
    const ponteiro = query.mock.calls.find(([sql]) => /insert into playbook_pointers/.test(String(sql)));
    expect(ponteiro?.[1]).toEqual([PB_NOVO, "tenant", ORG]);

    // aviso de IA
    const aviso = query.mock.calls.find(([sql]) =>
      /insert into disclosure_template_versions/.test(String(sql)),
    );
    expect(aviso?.[1]).toEqual([ORG, TEXTO_DO_AVISO_CFM]);

    // memória da org: endereço e convênios, publicada em nome de um Profissional da org
    const [memoria] = opsDe(ops, "org_memory_versions", "insert");
    expect(carga(memoria!)).toMatchObject({ organization_id: ORG, created_by: USER_DRA });
    expect(String(carga(memoria!).content)).toContain("Unimed");

    // agente: versão 2 publicada com as capacidades e o playbook, a 1 superada, ponteiro movido
    const [novaVersao] = opsDe(ops, "ai_agent_versions", "insert");
    const cargaVersao = carga(novaVersao!);
    expect(cargaVersao).toMatchObject({
      organization_id: ORG,
      agent_id: AGENTE,
      version_number: 2,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      channel_session_id: CANAL,
      pipeline_ids: [PIPE],
      status: "published",
      handoff_tool_enabled: true,
      created_by: null,
      superseded_at: null,
    });
    expect(cargaVersao.id).toBeUndefined();
    expect(cargaVersao.created_at).toBeUndefined();
    expect(String(cargaVersao.system_prompt)).toContain("Você atende os pacientes da Clínica Humana.");
    expect(String(cargaVersao.system_prompt)).toContain(PLAYBOOK_DA_CLINICA);
    expect(cargaVersao.tool_ids).toEqual(capacidadesDaClinica(["crm_search_contacts"]));

    const [superada] = opsDe(ops, "ai_agent_versions", "update");
    expect(carga(superada!)).toMatchObject({ status: "superseded" });
    expect(superada!.chain.filter((c) => c.m === "eq").map((c) => c.args)).toEqual(
      expect.arrayContaining([
        ["id", V1],
        ["organization_id", ORG],
      ]),
    );
    const [reapontado] = opsDe(ops, "ai_agents", "update");
    expect(carga(reapontado!)).toEqual({ published_version_id: V2 });

    // relatório
    expect(r.feito).toEqual(
      expect.arrayContaining([
        "redacao_clinica",
        "vocabulario:Paciente/Agendado",
        "etapa:agendamento-solicitado",
        "profissional:dra@clinica.invalid",
        "servico:consulta-clinica-geral",
        "servico:pilates",
        "playbook:tenant",
        "aviso_de_ia",
        "memoria_da_org",
        "agente:v2",
      ]),
    );
    expect(r.pulado).toHaveLength(1);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "clinica.embarque_executado",
        organizationId: ORG,
        resourceType: "organization",
        resourceId: ORG,
      }),
    );
  });

  it("é idempotente: playbook já publicado e agente já no ar não geram versão nova", async () => {
    const jaAtualizada = {
      ...VERSAO_PUBLICADA,
      system_prompt: `Você atende.\n\n${PLAYBOOK_DA_CLINICA}`,
      tool_ids: capacidadesDaClinica(["crm_search_contacts"]),
      handoff_tool_enabled: true,
    };
    const { admin, ops } = adminFalso(
      resolverPadrao({
        ai_agent_versions: (op) => (tem(op, "select") ? jaAtualizada : null),
        crm_stages: () => [
          { slug: "agendamento-solicitado", position: 1000 },
          { slug: "agendado", position: 2000 },
        ],
      }),
    );
    const { pool, query } = poolFalso({
      usuarios: [{ id: USER_DRA, email: "dra@clinica.invalid" }],
      playbookJaPublicado: true,
    });

    const r = await executarEmbarque(admin, pool, DADOS);

    expect(query.mock.calls.some(([sql]) => /insert into playbook_versions/.test(String(sql)))).toBe(false);
    const ponteiro = query.mock.calls.find(([sql]) => /insert into playbook_pointers/.test(String(sql)));
    expect(ponteiro?.[1]).toEqual([PB_EXISTENTE, "tenant", ORG]);
    expect(opsDe(ops, "crm_stages", "insert")).toHaveLength(0);
    expect(opsDe(ops, "ai_agent_versions", "insert")).toHaveLength(0);
    expect(opsDe(ops, "ai_agents", "update")).toHaveLength(0);
    expect(r.feito).toContain("agente:ja_no_ar");
    expect(r.feito).toContain("playbook:tenant");
  });

  it("sem versão publicada do agente, não inventa canal nem modelo: reporta e pula", async () => {
    const { admin, ops } = adminFalso(
      resolverPadrao({
        ai_agents: (op) => (tem(op, "update") ? null : { id: AGENTE, published_version_id: null }),
      }),
    );
    const { pool } = poolFalso({ usuarios: [{ id: USER_DRA, email: "dra@clinica.invalid" }] });

    const r = await executarEmbarque(admin, pool, DADOS);

    expect(opsDe(ops, "ai_agent_versions", "insert")).toHaveLength(0);
    expect(r.pulado).toContainEqual({ item: "agente", motivo: "sem_versao_publicada" });
  });

  it("sem funil padrão, pula vocabulário e etapas com motivo", async () => {
    const { admin, ops } = adminFalso(resolverPadrao({ crm_pipelines: () => null }));
    const { pool } = poolFalso({ usuarios: [{ id: USER_DRA, email: "dra@clinica.invalid" }] });

    const r = await executarEmbarque(admin, pool, DADOS);

    expect(opsDe(ops, "crm_stages", "insert")).toHaveLength(0);
    expect(r.pulado).toContainEqual({ item: "funil", motivo: "sem_funil_padrao" });
  });

  it("sem nenhum Profissional com usuário, a memória da org fica para depois", async () => {
    const { admin, ops } = adminFalso(resolverPadrao());
    const { pool } = poolFalso({ usuarios: [] });

    const r = await executarEmbarque(admin, pool, DADOS);

    expect(opsDe(ops, "org_memory_versions", "insert")).toHaveLength(0);
    expect(r.pulado).toContainEqual({ item: "memoria_da_org", motivo: "usuario_inexistente" });
    // o serviço continua nascendo, só sem dono
    const [tipo] = opsDe(ops, "calendar_event_types", "upsert");
    expect(carga(tipo!).default_owner_user_id).toBeUndefined();
    expect(r.pulado).toContainEqual({
      item: "servico:consulta-clinica-geral:profissional",
      motivo: "usuario_inexistente",
    });
  });

  it("organização inexistente é erro, não relatório", async () => {
    const { admin } = adminFalso(resolverPadrao({ organizations: () => null }));
    const { pool } = poolFalso({ usuarios: [] });
    await expect(executarEmbarque(admin, pool, DADOS)).rejects.toThrow(/organiza/i);
  });
});
