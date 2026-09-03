/**
 * A chave de idempotência da importação de Extrato.
 *
 * O parser (`lib/financeiro/ofx/`) devolve `chaveBruta` determinística e SEM
 * `organization_id` de propósito: quem conhece tenancy é quem persiste. Aqui a
 * organização entra e vira o `external_id` de `ledger_entries`, cujo
 * `unique (organization_id, external_id)` é o que faz a segunda importação do
 * mesmo arquivo não criar um lançamento a mais.
 *
 * O hash existe por dois motivos, nesta ordem: o `external_id` fica de tamanho
 * fixo (a `chaveBruta` carrega conta e FITID de banco, que não têm teto), e a
 * chave deixa de expor número de conta em claro numa coluna que a tela lê.
 * Não é segredo — é identificador; a defesa contra vazamento entre organizações
 * é a RLS, não o hash.
 */
import { createHash } from "node:crypto";

/**
 * `external_id` de um lançamento: sha256 de `orgId + "|" + chaveBruta`.
 *
 * O separador `|` não é decorativo: sem ele, `("org1", "2abc")` e
 * `("org12", "abc")` produziriam o mesmo texto e o mesmo hash — duas
 * organizações compartilhando idempotência é vazamento silencioso.
 */
export function externalIdDe(orgId: string, chaveBruta: string): string {
  return createHash("sha256").update(`${orgId}|${chaveBruta}`).digest("hex");
}
