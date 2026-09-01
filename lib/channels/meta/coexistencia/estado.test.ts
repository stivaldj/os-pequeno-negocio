import { describe, expect, it } from "vitest";
import { sincronizarContatosDoApp } from "@/lib/channels/meta/coexistencia/estado";
import { novoDuble } from "@/lib/channels/meta/coexistencia/duble-de-admin";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";

describe("sincronizarContatosDoApp", () => {
  it("cada contato do app vira fn_upsert_wa_contact com nome, só quando ainda não existe", async () => {
    const d = novoDuble();
    const r = await sincronizarContatosDoApp(
      d.admin,
      { kind: "app_state_sync", wabaId: "w", phoneNumberId: "pn", contacts: [{ phone: "553198966398", name: "Contato Teste" }] },
      { organizationId: "org-1" },
    );
    expect(r).toEqual({ criados: 1, existentes: 0 });
    const contato = d.ops.find((o) => o.op === "fn_upsert_wa_contact")?.payload as Record<string, unknown>;
    expect(contato).toMatchObject({ p_org: "org-1", p_phone: canonicalPhoneBR("+553198966398"), p_notify: "Contato Teste" });
  });

  it("contato que já existe não é tocado — o nome editado à mão vale mais que o do app", async () => {
    const d = novoDuble();
    d.setSelect({ id: "c-existe", phone_number: "+553198966398" });
    const r = await sincronizarContatosDoApp(
      d.admin,
      { kind: "app_state_sync", wabaId: "w", phoneNumberId: "pn", contacts: [{ phone: "553198966398", name: "Outro" }] },
      { organizationId: "org-1" },
    );
    expect(r).toEqual({ criados: 0, existentes: 1 });
    expect(d.ops.find((o) => o.op === "fn_upsert_wa_contact")).toBeUndefined();
  });
});
