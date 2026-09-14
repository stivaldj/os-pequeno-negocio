import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";

const RAIZ = process.cwd();

// (fork) A criação do canal oficial saiu da rota para `lib/channels/meta/conectar.ts`,
// que o caminho manual e o Embedded Signup (ADR-0015) compartilham — é lá que a
// linha nasce, então é lá que a configuração inicial é medida.
const CAMINHOS_DE_CRIACAO = [
  "lib/channels/meta/conectar.ts",
  "lib/channels/connect.ts",
] as const;

const ROTAS_DO_CANAL_OFICIAL = [
  "app/api/v1/channels/official/route.ts",
  "app/api/v1/channels/official/embedded-signup/route.ts",
] as const;

describe("todo canal criado pela interface nasce em pré-go-live", () => {
  it.each(CAMINHOS_DE_CRIACAO)("%s usa a configuração inicial compartilhada", (arquivo) => {
    const fonte = readFileSync(resolve(RAIZ, arquivo), "utf8");
    expect(fonte).toMatch(/import \{ metadataInicialDoCanal \}/);
    expect(fonte).toMatch(/metadata:\s*metadataInicialDoCanal\(\)/);
  });

  it.each(ROTAS_DO_CANAL_OFICIAL)("%s cria só pelo conector compartilhado", (arquivo) => {
    const fonte = readFileSync(resolve(RAIZ, arquivo), "utf8");
    expect(fonte).toMatch(/import \{ conectarCanalOficial \} from "@\/lib\/channels\/meta\/conectar"/);
    expect(fonte).toMatch(/await conectarCanalOficial\(/);
    expect(fonte).not.toMatch(/from\("channel_sessions"\)\s*\.insert\(/);
  });

  it.each([
    "app/api/v1/channel-sessions/route.ts",
    "app/api/v1/onboarding/whatsapp/session/route.ts",
  ])("%s cria via reserva transacional com pré-go-live no schema", (arquivo) => {
    const fonte = readFileSync(resolve(RAIZ, arquivo), "utf8");
    expect(fonte).toMatch(/await connectWahaChannel\(/);
    expect(fonte).not.toMatch(/\.insert\(/);
    const helper = readFileSync(resolve(RAIZ, "lib/channels/connect-waha.ts"), "utf8");
    expect(helper).toContain('authDb.rpc("fn_reserve_channel_connection"');
    const baseline = readFileSync(resolve(RAIZ, "supabase/baseline.sql"), "utf8");
    const fn = baseline.slice(baseline.lastIndexOf("create or replace function public.fn_reserve_channel_connection(")).split("\n$$;")[0]!;
    const initial = fn.match(/'(\{"ai_gate"[^']+\})'::jsonb/);
    expect(initial).not.toBeNull();
    expect(JSON.parse(initial![1]!)).toEqual(metadataInicialDoCanal());
    expect(fn).toContain("case when p_onboarding then '{\"onboarding\":true}'::jsonb");
  });

  it("reconectar canal parceiro preserva a configuração que já existia", () => {
    const fonte = readFileSync(resolve(RAIZ, "lib/channels/connect.ts"), "utf8");
    const update = fonte.slice(
      fonte.indexOf('? await admin.from("channel_sessions").update(linha)'),
      fonte.indexOf(": await admin", fonte.indexOf('? await admin.from("channel_sessions").update(linha)')),
    );
    expect(update).not.toContain("metadataInicialDoCanal");
  });
});
