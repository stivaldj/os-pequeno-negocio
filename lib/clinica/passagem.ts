/**
 * Conteúdo Clínico provoca Passagem (ADR-0004, ADR-0013 — "por assunto, não
 * por horário"). Usa o orquestrador de handoff do CRM, que já avisa o Contato,
 * silencia o Agente e move o lead; nada aqui carrega texto.
 */
import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";

export async function passarPorConteudoClinico(input: {
  organizationId: string;
  conversationId: string;
  contactId: string;
}): Promise<{ triggered: boolean; reason: string }> {
  return triggerHandoff({
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    reason: "clinical_mention",
    metadata: { gatilho: "conteudo_clinico", contact_id: input.contactId },
  });
}
