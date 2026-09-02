/**
 * O aviso de IA da clínica (CFM 2.454/2026): a primeira coisa que o Agente diz.
 *
 * Não há gate novo aqui. O mecanismo é o herdado — `disclosureGate` na cadeia
 * `before_send` (`lib/agent-engine/guardrails/before-send.ts`), alimentado por
 * um template versionado por Conta (`disclosure_template_versions` +
 * `disclosure_template_pointers`, `guardrails/disclosure/template.ts`). O gate
 * dispara quando `send_ledger` não tem envio `accepted` prévio ao contato, o
 * que é exatamente "primeiro contato" — e não só o handoff. `aviso-de-ia.test.ts`
 * é a prova disso com este texto.
 *
 * Este módulo entrega duas coisas: o TEXTO, e a instalação dele numa Conta
 * (versão nova + ponteiro), que o Embarque da Fase 4 chama por
 * `scripts/clinica/instalar-aviso-de-ia.ts`.
 */
import type pg from "pg";

import {
  insertDisclosureTemplateVersion,
  setDisclosureTemplatePointer,
} from "@/lib/agent-engine/guardrails/disclosure/template";

/**
 * ≤ 160 caracteres: abre a mensagem sem virar a mensagem. Diz o que a
 * resolução pede (é assistente virtual; há inteligência artificial) e o que a
 * ADR-0012 exige (não avalia — a equipe humana assume). "Clínica" genérico de
 * propósito: o texto é um só para toda Conta de saúde; o nome vem do agente.
 */
export const TEXTO_DO_AVISO_CFM =
  "Olá! Sou o assistente virtual da clínica e uso inteligência artificial. " +
  "Não faço avaliação clínica: para isso, a equipe humana assume.";

/**
 * Publica o texto como versão nova da Conta e move o ponteiro para ela. Duas
 * escritas, na ordem do módulo herdado (versão imutável, depois ponteiro): a
 * partir da segunda, a próxima tentativa de envio já vê o aviso — sem restart.
 * Idempotente no efeito (uma versão a mais por chamada; o ponteiro aponta para
 * a última).
 *
 * `db` é `pg.Pool` porque é o que as funções herdadas pedem; qualquer coisa que
 * responda a `query(text, values)` serve em runtime.
 */
export async function instalarAvisoDeIa(
  db: pg.Pool,
  tenantId: string,
): Promise<{ versionId: string }> {
  const { id: versionId } = await insertDisclosureTemplateVersion(db, {
    tenantId,
    body: TEXTO_DO_AVISO_CFM,
  });
  await setDisclosureTemplatePointer(db, { tenantId, versionId });
  return { versionId };
}
