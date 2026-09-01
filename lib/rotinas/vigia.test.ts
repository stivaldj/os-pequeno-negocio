import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ROTINAS_ESPERADAS } from "./esperadas";

/**
 * O vigia — transforma uma rotina que NÃO rodou em barulho.
 *
 * Três saídas para a mesma ausência, cada uma para um leitor: linha `missing`
 * em `job_runs` (histórico), item `job_dead` em `agent_inbox_items` com
 * `organization_id` nulo (a Central de avisos da instalação) e `audit`
 * `rotinas.nao_rodou` (a trilha). A tolerância é `2 × período + 5 min`: um
 * tick atrasado não é ausência; dois seguidos, é.
 */

const AGORA = new Date("2026-09-01T12:07:00.000Z");
const min = (n: number): string => new Date(AGORA.getTime() - n * 60_000).toISOString();

type Linha = { id: string; status: string; started_at: string };
let ultimas: Record<string, Linha | null>;
let primeiraLinha: string | null;
const inserts: { tabela: string; payload: Record<string, unknown> }[] = [];
const auditados: Record<string, unknown>[] = [];

vi.mock("@/lib/audit", () => ({
  audit: async (entrada: Record<string, unknown>) => {
    auditados.push(entrada);
  },
}));

/** Dublê do PostgREST: só o que o vigia usa, com os filtros mordendo. */
function adminFalso(): SupabaseClient {
  return {
    from(tabela: string) {
      const cadeia = {
        _jobName: null as string | null,
        _asc: false,
        select() {
          return cadeia;
        },
        eq(coluna: string, valor: string) {
          if (coluna === "job_name") cadeia._jobName = valor;
          return cadeia;
        },
        order(_c: string, opts?: { ascending?: boolean }) {
          cadeia._asc = opts?.ascending === true;
          return cadeia;
        },
        limit() {
          return cadeia;
        },
        async maybeSingle() {
          if (tabela !== "job_runs") return { data: null, error: null };
          if (cadeia._jobName !== null) {
            const nome = cadeia._jobName;
            const linha =
              nome in ultimas
                ? ultimas[nome]
                : { id: `run-${nome}`, status: "ok", started_at: min(1) };
            return { data: linha, error: null };
          }
          // Sem filtro por rotina + ordem ascendente = "quando o histórico começou".
          if (cadeia._asc) {
            return { data: primeiraLinha ? { started_at: primeiraLinha } : null, error: null };
          }
          return { data: null, error: null };
        },
        insert(payload: Record<string, unknown>) {
          inserts.push({ tabela, payload });
          const resposta = { data: { id: `${tabela}-${inserts.length}` }, error: null };
          return {
            select: () => ({ single: async () => resposta }),
            then: (resolve: (v: unknown) => unknown) => resolve(resposta),
          };
        },
      };
      return cadeia;
    },
  } as unknown as SupabaseClient;
}

const { vigiar, toleranciaMinutos } = await import("./vigia");

function insertsEm(tabela: string): Record<string, unknown>[] {
  return inserts.filter((i) => i.tabela === tabela).map((i) => i.payload);
}

beforeEach(() => {
  ultimas = {};
  primeiraLinha = min(60 * 24 * 3);
  inserts.length = 0;
  auditados.length = 0;
});

describe("tolerância", () => {
  it("é 2 × período + 5 min", () => {
    expect(toleranciaMinutos(1)).toBe(7);
    expect(toleranciaMinutos(5)).toBe(15);
    expect(toleranciaMinutos(60)).toBe(125);
    expect(toleranciaMinutos(1440)).toBe(2885);
  });
});

describe("vigiar", () => {
  it("rotina em dia não gera nada — e o vigia olhou todas", async () => {
    const r = await vigiar(adminFalso(), AGORA);
    expect(r.verificadas).toBe(ROTINAS_ESPERADAS.length);
    expect(r.ausentes).toEqual([]);
    expect(inserts).toEqual([]);
    expect(auditados).toEqual([]);
  });

  it("última linha `ok` de channel-health (5 min) há 16 min → missing, job_dead e audit", async () => {
    ultimas["channel-health"] = { id: "run-ch", status: "ok", started_at: min(16) };

    const r = await vigiar(adminFalso(), AGORA);

    expect(r.ausentes).toEqual(["channel-health"]);

    const [linha] = insertsEm("job_runs");
    expect(linha).toMatchObject({ job_name: "channel-health", status: "missing" });
    expect(linha?.started_at).toBe(AGORA.toISOString());

    const [aviso] = insertsEm("agent_inbox_items");
    expect(aviso).toMatchObject({ organization_id: null, kind: "job_dead", severity: "critical" });
    expect(String(aviso?.title)).toContain("channel-health");
    expect(aviso?.ref_kind).toBe("job_run");
    expect(aviso?.ref_id).toBe("job_runs-1");

    expect(auditados).toHaveLength(1);
    expect(auditados[0]).toMatchObject({
      action: "rotinas.nao_rodou",
      organizationId: null,
      resourceType: "job_run",
      resourceId: "job_runs-1",
    });
    expect((auditados[0]?.metadata as Record<string, unknown>).job_name).toBe("channel-health");
  });

  it("silêncio de EXATAMENTE a tolerância ainda não é ausência (o limite é inclusivo)", async () => {
    ultimas["channel-health"] = { id: "run-ch", status: "ok", started_at: min(15) };
    const r = await vigiar(adminFalso(), AGORA);
    expect(r.ausentes).toEqual([]);
    expect(inserts).toEqual([]);
  });

  it("linha `running` velha conta como ausência — o que importa é quando COMEÇOU", async () => {
    // Processo que morreu no meio: a linha nunca fecha. Olhar `finished_at`
    // esconderia isso para sempre.
    ultimas["event-log-drain"] = { id: "run-eld", status: "running", started_at: min(30) };
    const r = await vigiar(adminFalso(), AGORA);
    expect(r.ausentes).toEqual(["event-log-drain"]);
  });

  it("última linha já é `missing` dentro da tolerância → não gera segunda", async () => {
    ultimas["channel-health"] = { id: "run-ch", status: "missing", started_at: min(10) };
    const r = await vigiar(adminFalso(), AGORA);
    expect(r.ausentes).toEqual([]);
    expect(inserts).toEqual([]);
    expect(auditados).toEqual([]);
  });

  it("`missing` mais velho que a tolerância → volta a gritar", async () => {
    ultimas["channel-health"] = { id: "run-ch", status: "missing", started_at: min(60) };
    const r = await vigiar(adminFalso(), AGORA);
    expect(r.ausentes).toEqual(["channel-health"]);
    expect(insertsEm("job_runs")).toHaveLength(1);
  });

  it("rotina SEM linha nenhuma, com histórico começado há 3 dias → ausente (nunca rodou)", async () => {
    ultimas["lgpd-sla-watcher"] = null;
    const r = await vigiar(adminFalso(), AGORA);
    expect(r.ausentes).toEqual(["lgpd-sla-watcher"]);
  });

  it("rotina SEM linha nenhuma, com histórico recém-nascido → ainda não é ausência", async () => {
    // Instalação que acabou de subir: a diária só roda amanhã.
    ultimas["lgpd-sla-watcher"] = null;
    primeiraLinha = min(1);
    const r = await vigiar(adminFalso(), AGORA);
    expect(r.ausentes).toEqual([]);
  });

  it("tabela vazia (nada rodou ainda em lugar nenhum) → nada a comparar, nada a gritar", async () => {
    for (const rotina of ROTINAS_ESPERADAS) ultimas[rotina.nome] = null;
    primeiraLinha = null;
    const r = await vigiar(adminFalso(), AGORA);
    expect(r.ausentes).toEqual([]);
    expect(inserts).toEqual([]);
  });

  it("duas ausentes geram dois de cada — uma por rotina, na ordem da lista", async () => {
    ultimas["channel-health"] = { id: "a", status: "ok", started_at: min(16) };
    ultimas["routing-worker"] = { id: "b", status: "failed", started_at: min(8) };
    const r = await vigiar(adminFalso(), AGORA);
    expect(r.ausentes.sort()).toEqual(["channel-health", "routing-worker"]);
    expect(insertsEm("job_runs")).toHaveLength(2);
    expect(insertsEm("agent_inbox_items")).toHaveLength(2);
    expect(auditados).toHaveLength(2);
  });
});
