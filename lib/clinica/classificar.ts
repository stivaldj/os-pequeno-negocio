/**
 * Reconhece Conteúdo Clínico no texto do Contato — sintoma, condição ou
 * medicação — antes de qualquer persistência (ADR-0004). Determinístico e
 * síncrono de propósito: roda no ingest, e um juiz que pode cair não cabe
 * entre a mensagem e o banco.
 *
 * Escolher especialidade, serviço ou profissional NÃO é Conteúdo Clínico
 * (ADR-0012); o léxico não contém esses nomes.
 */
import {
  CONDICOES,
  EXCECOES_DE_SUFIXO,
  FORMAS_DE_DOSE,
  FORMAS_DE_SINTOMA,
  MARCADORES_DE_MEDICACAO,
  MEDICACOES,
  SINTOMAS,
} from "./lexico";

export type MotivoClinico = "sintoma" | "condicao" | "medicacao";

export interface ClassificacaoClinica {
  clinico: boolean;
  motivo: MotivoClinico | null;
  /** Chaves do léxico que casaram. Só para memória e teste — NUNCA persistir. */
  termos: string[];
}

export function normalizarTexto(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function casaTermo(texto: string, termo: string): boolean {
  const escapado = termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${escapado}(?![a-z0-9])`).test(texto);
}

function termosQueCasam(texto: string, lista: readonly string[]): string[] {
  return lista.filter((t) => casaTermo(texto, t));
}

const NAO_CLINICO: ClassificacaoClinica = { clinico: false, motivo: null, termos: [] };

export function classificarConteudoClinico(texto: string | null | undefined): ClassificacaoClinica {
  if (!texto || !texto.trim()) return NAO_CLINICO;
  const t = normalizarTexto(texto);

  const medicacoes = termosQueCasam(t, MEDICACOES);
  const marcadores = termosQueCasam(t, MARCADORES_DE_MEDICACAO);
  const doses = FORMAS_DE_DOSE.some((r) => r.test(t)) ? ["forma:dose"] : [];
  if (medicacoes.length > 0 || (marcadores.length > 0 && doses.length > 0) || (marcadores.length > 0 && /\b(tomo|tomar|tomando|receita|renovar|acabou|controlado)\b/.test(t))) {
    return { clinico: true, motivo: "medicacao", termos: [...medicacoes, ...marcadores, ...doses] };
  }

  const condicoes = termosQueCasam(t, CONDICOES);
  if (condicoes.length > 0) return { clinico: true, motivo: "condicao", termos: condicoes };

  const sintomas = termosQueCasam(t, SINTOMAS);
  const formas = FORMAS_DE_SINTOMA.filter((r) => {
    const m = r.exec(t);
    if (!m) return false;
    // O sufixo -ite/-ose/-algia só vale fora das exceções comuns.
    if (r.source.includes("(ite|ose|algia)")) {
      const palavra = m[0];
      return !EXCECOES_DE_SUFIXO.includes(palavra);
    }
    return true;
  }).length > 0 ? ["forma:sintoma"] : [];
  if (sintomas.length > 0 || formas.length > 0) {
    return { clinico: true, motivo: "sintoma", termos: [...sintomas, ...formas] };
  }
  return NAO_CLINICO;
}
