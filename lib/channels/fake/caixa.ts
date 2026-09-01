/**
 * A caixa de saída do `fake_channel`: só memória, por organização.
 *
 * É o que uma prova local lê para afirmar "o Agente respondeu X" sem HTTP e
 * sem provider. Determinística de propósito: a numeração por org recomeça a
 * cada `limparCaixaFake()`, então um teste que roda duas vezes vê os mesmos
 * `externalId`s.
 */
import type { OutboundEnvelope } from "../types";

export type EnvioFake =
  | { kind: "message"; externalId: string; envelope: OutboundEnvelope; at: Date }
  | {
      kind: "template";
      externalId: string;
      envelope: null;
      at: Date;
      template: { organizationId: string; sessionRef: string; to: string; name: string; language: string; values: Record<string, string> };
    };

const enviados = new Map<string, EnvioFake[]>();
const contadores = new Map<string, number>();

function proximoId(organizationId: string): string {
  const n = (contadores.get(organizationId) ?? 0) + 1;
  contadores.set(organizationId, n);
  return `fake:${organizationId}:${n}`;
}

export function registrarEnvio(organizationId: string, envelope: OutboundEnvelope): string {
  const externalId = proximoId(organizationId);
  const lista = enviados.get(organizationId) ?? [];
  lista.push({ kind: "message", externalId, envelope, at: new Date() });
  enviados.set(organizationId, lista);
  return externalId;
}

export function registrarTemplate(
  template: Extract<EnvioFake, { kind: "template" }>["template"],
): string {
  const externalId = proximoId(template.organizationId);
  const lista = enviados.get(template.organizationId) ?? [];
  lista.push({ kind: "template", externalId, envelope: null, at: new Date(), template });
  enviados.set(template.organizationId, lista);
  return externalId;
}

export function lerEnviados(organizationId: string): readonly EnvioFake[] {
  return enviados.get(organizationId) ?? [];
}

export function limparCaixaFake(): void {
  enviados.clear();
  contadores.clear();
}
