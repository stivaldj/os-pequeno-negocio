/**
 * O preparador que todo ingestor chama antes de gravar (ADR-0004): em Conta
 * de saúde, texto clínico vira marcador em `body` e no preview, e não segue
 * para os efeitos pós-entrada. Fora disso, passa íntegro.
 */
import { describe, expect, it, vi } from "vitest";
import { MARCADOR_CLINICO, prepararEntradaDoContato } from "@/lib/clinica/redacao";

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

function adminComSettings(settings: unknown, erro: { message: string } | null = null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: erro ? null : { settings }, error: erro }) }),
      }),
    }),
  } as never;
}

const SAUDE = { clinica: { redacao_clinica: true } };

describe("prepararEntradaDoContato", () => {
  it("Conta sem redação: tudo íntegro", async () => {
    const r = await prepararEntradaDoContato(adminComSettings({}), "org-1", "tô com dor no peito");
    expect(r).toEqual({ body: "tô com dor no peito", preview: "tô com dor no peito", textoParaEfeitos: "tô com dor no peito", redigido: null, codigoDeClique: null });
  });

  it("Conta de saúde, texto clínico: marcador em body e preview, nada para os efeitos", async () => {
    const r = await prepararEntradaDoContato(adminComSettings(SAUDE), "org-1", "tomo losartana 50mg e tô com dor no peito");
    expect(r.body).toBe(MARCADOR_CLINICO);
    expect(r.preview).toBe(MARCADOR_CLINICO);
    expect(r.textoParaEfeitos).toBeNull();
    expect(r.redigido).toEqual({ motivo: "medicacao" });
    expect(JSON.stringify(r)).not.toMatch(/losartana|peito/);
  });

  it("Conta de saúde, texto não clínico: íntegro — escolher especialidade não é Conteúdo Clínico", async () => {
    const r = await prepararEntradaDoContato(adminComSettings(SAUDE), "org-1", "quero marcar com a cardiologista");
    expect(r.body).toBe("quero marcar com a cardiologista");
    expect(r.redigido).toBeNull();
  });

  it("preview corta em 120 caracteres como os ingestores fazem", async () => {
    const longo = "a".repeat(200);
    const r = await prepararEntradaDoContato(adminComSettings({}), "org-1", longo);
    expect(r.preview).toHaveLength(120);
  });

  it("texto nulo (mídia sem legenda) passa como nulo", async () => {
    const r = await prepararEntradaDoContato(adminComSettings(SAUDE), "org-1", null);
    expect(r).toEqual({ body: null, preview: "", textoParaEfeitos: null, redigido: null, codigoDeClique: null });
  });

  it("falha ao ler a configuração: redige (fail-closed) e registra", async () => {
    const r = await prepararEntradaDoContato(adminComSettings(null, { message: "boom" }), "org-1", "quero marcar com a cardiologista");
    expect(r.body).toBe(MARCADOR_CLINICO);
    expect(r.redigido).toEqual({ motivo: "configuracao_indisponivel" });
  });
});

describe("Código de Clique na entrada (ADR-0016)", () => {
  it("texto íntegro com o código: o código sai extraído e o texto segue inteiro", async () => {
    const r = await prepararEntradaDoContato(adminComSettings({}), "org-1", "Olá, quero marcar uma consulta (ref X7K3MQ)");
    expect(r.codigoDeClique).toBe("X7K3MQ");
    expect(r.body).toBe("Olá, quero marcar uma consulta (ref X7K3MQ)");
    expect(r.redigido).toBeNull();
  });

  it("texto clínico redigido AINDA entrega o código — ele é lido do texto cru, antes da redação", async () => {
    const r = await prepararEntradaDoContato(adminComSettings(SAUDE), "org-1", "tomo losartana e tô com dor no peito (ref X7K3MQ)");
    expect(r.codigoDeClique).toBe("X7K3MQ");
    expect(r.body).toBe(MARCADOR_CLINICO);
    expect(r.textoParaEfeitos).toBeNull();
    expect(r.redigido).toEqual({ motivo: "medicacao" });
    expect(JSON.stringify(r)).not.toMatch(/losartana|peito/);
  });

  it("fail-closed (configuração indisponível) também entrega o código", async () => {
    const r = await prepararEntradaDoContato(adminComSettings(null, { message: "boom" }), "org-1", "oi (ref X7K3MQ)");
    expect(r.codigoDeClique).toBe("X7K3MQ");
    expect(r.redigido).toEqual({ motivo: "configuracao_indisponivel" });
  });

  it("sem código no texto: null", async () => {
    const r = await prepararEntradaDoContato(adminComSettings({}), "org-1", "quero marcar com a cardiologista");
    expect(r.codigoDeClique).toBeNull();
  });
});
