/**
 * Níveis de Autonomia do Agente de Anúncios (ADR-0018). O Dono liga; começa
 * no primeiro. Toda ferramenta de escrita pergunta aqui antes de agir e audita
 * a recusa com o nível em vigor.
 *
 *   1 — observar e propor: nunca escreve no Google.
 *   2 — ajustar dentro de limites: orçamento entre piso e teto; pausar campanha
 *       que estoura o custo por conversa.
 *   3 — criar e editar anúncios e palavras-chave.
 */
export type AcaoDeEscrita = "orcamento" | "pausar" | "anuncio" | "palavra_chave";
export type NivelDeAutonomia = 1 | 2 | 3;

const PERMITIDO: Record<NivelDeAutonomia, readonly AcaoDeEscrita[]> = {
  1: [],
  2: ["orcamento", "pausar"],
  3: ["orcamento", "pausar", "anuncio", "palavra_chave"],
};

export function nivelValido(n: unknown): NivelDeAutonomia {
  return n === 2 || n === 3 ? n : 1;
}

export function podeEscrever(conta: { autonomy_level: unknown }, acao: AcaoDeEscrita): boolean {
  return PERMITIDO[nivelValido(conta.autonomy_level)].includes(acao);
}

export const MOTIVO_NIVEL_INSUFICIENTE = "nivel_insuficiente";
