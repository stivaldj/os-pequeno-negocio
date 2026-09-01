import { describe, expect, it, vi } from "vitest";

import { disclosureGate, type GateContext } from "@/lib/agent-engine/guardrails/before-send";

import { TEXTO_DO_AVISO_CFM, instalarAvisoDeIa } from "./aviso-de-ia";

/**
 * O aviso de IA cobre o PRIMEIRO CONTATO (CFM 2.454/2026) — e não só o handoff.
 *
 * O mecanismo é herdado: `disclosureGate` na cadeia `before_send`, template
 * versionado por Conta. Esta fase não escreve gate novo; prova que o herdado,
 * carregado com o texto da clínica, abre a primeira mensagem de saída de toda
 * conversa e fica quieto nas seguintes.
 */

/** Só `body` e `disclosure` são lidos pelo gate; o resto do contexto não entra. */
function ctx(body: string, isFirstOutbound: boolean): GateContext {
  return {
    now: new Date("2026-09-01T12:00:00Z"),
    body,
    disclosure: { template: TEXTO_DO_AVISO_CFM, isFirstOutbound, mode: "inject" },
  } as unknown as GateContext;
}

describe("TEXTO_DO_AVISO_CFM", () => {
  it("diz que é assistente virtual com inteligência artificial", () => {
    expect(TEXTO_DO_AVISO_CFM).toContain("assistente virtual");
    expect(TEXTO_DO_AVISO_CFM).toContain("inteligência artificial");
  });

  it("cabe em 160 caracteres — abre a mensagem sem virar a mensagem", () => {
    expect(TEXTO_DO_AVISO_CFM.length).toBeLessThanOrEqual(160);
    expect(TEXTO_DO_AVISO_CFM.trim()).toBe(TEXTO_DO_AVISO_CFM);
  });
});

describe("disclosureGate com o texto da clínica", () => {
  it("primeira mensagem de saída: emenda o corpo começando pelo aviso", () => {
    const v = disclosureGate.evaluate(ctx("Olá! Como posso ajudar?", true));
    expect(v.pass).toBe(true);
    if (!v.pass) return;
    expect(v.amendBody).toBeDefined();
    expect(v.amendBody!.startsWith(TEXTO_DO_AVISO_CFM)).toBe(true);
    expect(v.amendBody).toContain("Olá! Como posso ajudar?");
  });

  it("mensagem seguinte: passa sem emendar", () => {
    const v = disclosureGate.evaluate(ctx("Sua consulta está confirmada.", false));
    expect(v).toEqual({ pass: true });
  });

  it("corpo que já traz o aviso: passa sem duplicar", () => {
    const corpo = `${TEXTO_DO_AVISO_CFM}\n\nOlá! Como posso ajudar?`;
    const v = disclosureGate.evaluate(ctx(corpo, true));
    expect(v).toEqual({ pass: true });
  });
});

describe("instalarAvisoDeIa", () => {
  it("publica uma versão com o texto e move o ponteiro da Conta para ela", async () => {
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const versionId = "22222222-2222-4222-8222-222222222222";
    const query = vi
      .fn()
      // insert em disclosure_template_versions → id da versão
      .mockResolvedValueOnce({ rows: [{ id: versionId }], rowCount: 1 })
      // upsert do ponteiro → uma linha
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const r = await instalarAvisoDeIa({ query } as never, tenantId);

    expect(r).toEqual({ versionId });
    expect(query).toHaveBeenCalledTimes(2);
    const [sqlVersao, paramsVersao] = query.mock.calls[0]!;
    expect(sqlVersao).toMatch(/insert into disclosure_template_versions/);
    expect(paramsVersao).toEqual([tenantId, TEXTO_DO_AVISO_CFM]);
    const [sqlPonteiro, paramsPonteiro] = query.mock.calls[1]!;
    expect(sqlPonteiro).toMatch(/disclosure_template_pointers/);
    expect(paramsPonteiro).toEqual([versionId, tenantId]);
  });
});
