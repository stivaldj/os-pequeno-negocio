// @vitest-environment node
//
// Multipart real (File/FormData) precisa do realm do Node — o jsdom, default do
// projeto, tem o SEU File/FormData, e o `instanceof File` da rota (que é o do
// undici, dentro do `NextRequest.formData()`) nunca casa com ele: todo pedido
// sairia 422 "envie no campo 'file'" e o teste provaria o contrário do que
// afirma. Mesma razão declarada em `app/api/v1/ai/skills/import/route.test.ts`.
/**
 * `POST /api/v1/financeiro/extratos` — a rota de subir o extrato do banco.
 *
 * O que se prova aqui, e por que cada coisa:
 *
 *   • O gate é `requireRole("manager")` — dinheiro não é `agent` —, e a recusa
 *     dele VOLTA como resposta sem que a rota toque o banco.
 *   • O `organization_id` sai de `authz.org.orgId`. O corpo do multipart pode
 *     mandar outro e ele é IGNORADO: o client é service role, bypassa RLS, e
 *     quem filtra é o código.
 *   • As três recusas de borda, cada uma com o seu código: extensão/tipo errados
 *     → 422 `validation_failed` com a instrução de exportar OFX do banco;
 *     arquivo acima de `OFX_MAX_BYTES` → **413** `payload_too_large` (o arquivo
 *     não está errado, está grande); conteúdo que não é OFX → 422.
 *   • O caminho feliz roda com uma fixture REAL de `tests/fixtures/ofx/` e o
 *     `importarExtrato` de verdade — o dublê é do supabase, não da lib. Sem
 *     isso, o teste provaria a fiação e não a importação.
 *   • Audita UMA vez: a trilha `financeiro.extrato_importado` nasce dentro da
 *     lib, e nem a rota nem o handler a repetem.
 *
 * Molde: `tests/unit/ads-api.test.ts` (mock de require-role, audit e admin).
 */
import { readFileSync } from "node:fs";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";
import { OFX_MAX_BYTES } from "@/lib/financeiro/ofx/tipos";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => true),
}));

type Linha = Record<string, unknown>;

/** O que o dublê do supabase viu — lido pelas asserções. */
const entries: Linha[] = [];
const balances: Linha[] = [];
const filtros: { tabela: string; coluna: string; valor: unknown }[] = [];
const unico = new Set<string>();

/**
 * Dublê do admin client com o que `importarExtrato` realmente depende: o
 * `unique (organization_id, external_id)` devolvendo `23505` de verdade e o
 * `upsert` dos saldos.
 */
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(tabela: string) {
      return {
        select(_colunas: string) {
          const q = {
            eq(coluna: string, valor: unknown) {
              filtros.push({ tabela, coluna, valor });
              return q;
            },
            then: (resolve: (r: unknown) => unknown) => resolve({ data: [], error: null }),
          };
          return q;
        },
        insert(row: Linha) {
          return {
            then: (resolve: (r: unknown) => unknown) => {
              const chave = `${String(row.organization_id)}|${String(row.external_id)}`;
              if (unico.has(chave)) {
                return resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
              }
              unico.add(chave);
              entries.push(row);
              return resolve({ data: null, error: null });
            },
          };
        },
        upsert(linhas: Linha[]) {
          return {
            then: (resolve: (r: unknown) => unknown) => {
              balances.push(...linhas);
              return resolve({ data: null, error: null });
            },
          };
        },
      };
    },
  }),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const ANA = "11111111-1111-4111-8111-111111111111";

const usuario: AuthUser = {
  id: ANA,
  email: "ana@clinica.com.br",
  full_name: "Ana",
  avatar_url: null,
  is_platform_admin: false,
  idioma: "pt-BR" as const,
  organizations: [{ organization_id: ORG, organization_name: "Clínica", role: "manager" }],
};
const orgAtiva: ActiveOrg = { orgId: ORG, name: "Clínica", role: "manager" };

function fixture(nome: string): Buffer {
  return readFileSync(`tests/fixtures/ofx/${nome}`);
}

function arquivo(bytes: Uint8Array | string, nome: string, tipo: string): File {
  // A cópia para `Uint8Array` é de tipo, não de comportamento: `Buffer` é
  // `Uint8Array<ArrayBufferLike>` e o `BlobPart` do DOM só aceita `ArrayBuffer`.
  const parte: BlobPart = typeof bytes === "string" ? bytes : new Uint8Array(bytes);
  return new File([parte], nome, { type: tipo });
}

function pedido(campos: Record<string, File | string>): NextRequest {
  const form = new FormData();
  for (const [chave, valor] of Object.entries(campos)) form.set(chave, valor);
  return new NextRequest("https://crm.exemplo/api/v1/financeiro/extratos", {
    method: "POST",
    headers: { "x-request-id": "req-ofx" },
    body: form,
  });
}

async function postar(campos: Record<string, File | string>): Promise<Response> {
  const { POST } = await import("@/app/api/v1/financeiro/extratos/route");
  return POST(pedido(campos));
}

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: usuario, org: orgAtiva });
  vi.mocked(audit).mockClear();
  entries.length = 0;
  balances.length = 0;
  filtros.length = 0;
  unico.clear();
});

describe("o gate é manager, e é dinheiro que está em jogo", () => {
  it("a recusa do requireRole volta como resposta, sem tocar o banco", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "papel insuficiente", 403),
    });

    const res = await postar({
      file: arquivo(fixture("duas-contas.ofx"), "duas-contas.ofx", "application/octet-stream"),
    });

    expect(res.status).toBe(403);
    // `agent` atende no WhatsApp; extrato bancário exige `manager`.
    expect(vi.mocked(requireRole)).toHaveBeenCalledWith(
      "manager",
      expect.objectContaining({ requestId: "req-ofx", resource: "ledger_entries" }),
    );
    expect(entries).toHaveLength(0);
    expect(balances).toHaveLength(0);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});

describe("as recusas de borda", () => {
  it("PDF vira 422 com a instrução de exportar OFX no site do banco", async () => {
    const res = await postar({ file: arquivo("%PDF-1.4", "extrato.pdf", "application/pdf") });

    expect(res.status).toBe(422);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("validation_failed");
    expect(corpo.error.message).toContain(".ofx");
    expect(corpo.error.message).toContain("Exportar extrato");
    expect(entries).toHaveLength(0);
  });

  it("arquivo acima do teto vira 413 payload_too_large, e não 422", async () => {
    // O arquivo não está errado — está grande. Passar 422 aqui mandaria o Dono
    // procurar defeito num extrato que o banco exportou certo.
    const grande = new Uint8Array(OFX_MAX_BYTES + 1);
    const res = await postar({ file: arquivo(grande, "extrato.ofx", "application/octet-stream") });

    expect(res.status).toBe(413);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("payload_too_large");
    expect(corpo.error.message).toContain("um mês por vez");
    expect(entries).toHaveLength(0);
  });

  it("arquivo com extensão certa e conteúdo que não é OFX vira 422", async () => {
    const res = await postar({
      file: arquivo("nome;telefone\nAna;11999", "extrato.ofx", "application/octet-stream"),
    });

    expect(res.status).toBe(422);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("validation_failed");
    // A mensagem do parser ensina o que fazer, em vez de dizer "erro".
    expect(corpo.error.message).toContain("<OFX>");
    expect(entries).toHaveLength(0);
  });

  it("corpo que não é multipart vira 422 dizendo o nome do campo", async () => {
    const { POST } = await import("@/app/api/v1/financeiro/extratos/route");
    const req = new NextRequest("https://crm.exemplo/api/v1/financeiro/extratos", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req-ofx" },
      body: JSON.stringify({ file: "extrato.ofx" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toContain("'file'");
  });
});

describe("o caminho feliz, com uma fixture real", () => {
  it("importa as duas contas do extrato e devolve o resumo", async () => {
    const res = await postar({
      file: arquivo(fixture("duas-contas.ofx"), "duas-contas.ofx", "application/octet-stream"),
    });

    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.total_lancamentos).toBe(3);
    expect(data.importados).toBe(3);
    expect(data.duplicados).toBe(0);
    expect(data.descartados).toEqual([]);
    expect(data.saldos_gravados).toBe(2);
    expect(data.contas.map((c: { account_id: string }) => c.account_id).sort()).toEqual([
      "11111-1",
      "22222-2",
    ]);

    // A trilha nasce DENTRO da lib e ninguém a repete: uma linha, não duas.
    expect(vi.mocked(audit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: "financeiro.extrato_importado",
      organizationId: ORG,
      actorUserId: ANA,
      requestId: "req-ofx",
    });
  });
});

describe("service role: a organização vem do gate", () => {
  it("organization_id mandado no corpo do multipart é ignorado", async () => {
    const res = await postar({
      file: arquivo(fixture("duas-contas.ofx"), "duas-contas.ofx", "application/octet-stream"),
      organization_id: OUTRA_ORG,
    });

    expect(res.status).toBe(200);
    expect(entries).toHaveLength(3);
    for (const linha of entries) expect(linha.organization_id).toBe(ORG);
    for (const linha of balances) expect(linha.organization_id).toBe(ORG);
    // Inclusive a leitura das categorias: o filtro manual é a única defesa que
    // o service role tem, já que ele bypassa a RLS.
    expect(filtros).toContainEqual({
      tabela: "ledger_categories",
      coluna: "organization_id",
      valor: ORG,
    });
    expect(JSON.stringify(entries)).not.toContain(OUTRA_ORG);
  });
});
