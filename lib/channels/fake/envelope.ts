/**
 * O contrato de entrada do `fake_channel` — o mínimo que uma prova precisa
 * mandar para uma mensagem "chegar": quem, o quê, um id externo (para o
 * `unique (organization_id, external_id)` fazer o mesmo que faz em produção) e,
 * opcionalmente, quando.
 */
import { z } from "zod";
import { lerEnvelope, type LeituraDeEnvelope } from "@/lib/webhooks/contrato";

export const fakeEnvelopeSchema = z.object({
  from: z.string().min(8),
  text: z.string().min(1),
  external_id: z.string().min(1),
  sent_at: z.string().datetime().optional(),
  profile_name: z.string().optional(),
});

export type FakeEnvelope = z.infer<typeof fakeEnvelopeSchema>;

export function lerEnvelopeFake(rawBody: string): LeituraDeEnvelope<FakeEnvelope> {
  return lerEnvelope(rawBody, fakeEnvelopeSchema);
}
