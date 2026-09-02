/**
 * O Código de Clique (ADR-0016).
 *
 * O WhatsApp não tem, para o Google, o equivalente ao `referral` da Meta: não
 * há como saber de qual anúncio uma conversa nasceu. O que existe é a Página
 * de Captura — ela recebe o clique (com `gclid`), sorteia um código, grava o
 * clique com esse código e abre o WhatsApp da clínica com a frase
 * pré-preenchida carregando o código. A primeira mensagem do Contato traz o
 * código de volta, e é aí que a conversa fica atribuída à campanha.
 *
 * Três funções, uma por ponta desse caminho:
 *
 *   - `gerarCodigoDeClique`   — na Página de Captura, ao gravar o clique;
 *   - `frasePreenchida`       — na Página de Captura, ao montar o `wa.me`;
 *   - `extrairCodigoDeClique` — no preparador de entrada, sobre o texto CRU
 *                               (antes da redação clínica: o código não é
 *                               Conteúdo Clínico, e uma primeira mensagem
 *                               clínica não pode perder a atribuição).
 *
 * O alfabeto exclui 0/O e 1/I: a pessoa pode digitar o código à mão, e o
 * extrator normaliza caixa e acento antes de procurar.
 */
import { randomInt } from "node:crypto";

export const ALFABETO_DO_CODIGO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const TAMANHO_DO_CODIGO = 6;

/** A âncora `ref` é obrigatória: seis letras soltas nunca são um código. */
const CODIGO_NA_FRASE = /\bref[\s:#-]*([A-Z2-9]{6})\b/i;

export function gerarCodigoDeClique(): string {
  let codigo = "";
  for (let i = 0; i < TAMANHO_DO_CODIGO; i++) {
    codigo += ALFABETO_DO_CODIGO[randomInt(ALFABETO_DO_CODIGO.length)];
  }
  return codigo;
}

export function frasePreenchida(mensagem: string, codigo: string): string {
  return `${mensagem} (ref ${codigo})`;
}

/** Sem acento e em maiúsculas: "Réf x7k3mq" tem de ler igual a "REF X7K3MQ". */
function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
}

export function extrairCodigoDeClique(texto: string | null | undefined): string | null {
  if (!texto) return null;
  const m = normalizar(texto).match(CODIGO_NA_FRASE);
  return m?.[1] ?? null;
}
