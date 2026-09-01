/**
 * "Não é ato médico" (ADR-0012): o Agente marca consulta, não prescreve, não
 * diagnostica e não orienta tratamento. Esta função reconhece, na RESPOSTA do
 * Agente, os três gestos que o CFM reserva ao médico:
 *
 *   - prescrição: verbo de uso + evidência de medicação (nome, marcador ou dose);
 *   - diagnóstico: "parece" / "pode ser" / "você tem" + condição do léxico;
 *   - orientação terapêutica: "suspenda" / "aumente" / "pare de tomar" + medicação.
 *
 * Determinística e sem contexto, como `classificar.ts`; reusa o mesmo léxico.
 * Roda em observação (`vigia.ts`): um acerto vira aviso para uma pessoa, não
 * bloqueio. Por isso o desenho erra para o lado do falso positivo — mas não
 * tanto que ecoar o Contato ("pode tomar água antes do exame") vire alarme:
 * verbo sozinho não basta, precisa da medicação ou da dose junto.
 *
 * Devolve só o motivo. Nunca os termos: a resposta que parece ato médico
 * provavelmente cita Conteúdo Clínico, e nada dela sai daqui (ADR-0004).
 */
import { normalizarTexto } from "./classificar";
import {
  CONDICOES,
  EXCECOES_DE_SUFIXO,
  MARCADORES_DE_MEDICACAO,
  MEDICACOES,
} from "./lexico";

export type MotivoDeAtoMedico = "prescricao" | "diagnostico" | "orientacao";

export interface SuspeitaDeAtoMedico {
  parece: boolean;
  motivo: MotivoDeAtoMedico | null;
}

const NAO_PARECE: SuspeitaDeAtoMedico = { parece: false, motivo: null };

/** "tome", "use", "aplique", "deve tomar" — o verbo que dá a ordem. */
const VERBOS_DE_PRESCRICAO =
  /\b(tome|tomar|toma|tomando|use|usar|usa|usando|aplique|aplicar|ingira|ingerir|prescrevo|receito|recomendo)\b/;

/** "50mg", "2 comprimidos", "de 8 em 8 horas", "a cada 6 horas", "3 vezes ao dia". */
const FORMAS_DE_POSOLOGIA: readonly RegExp[] = [
  /\b\d+\s?(mg|ml|mcg|g|ui)\b/,
  /\b\d+\s+(comprimidos?|gotas|capsulas?|ampolas?)\b/,
  /\bde\s+\d+\s+em\s+\d+\s+horas?\b/,
  /\ba\s+cada\s+\d+\s+horas?\b/,
  /\b\d+\s+vez(es)?\s+(ao|por)\s+dia\b/,
];

/** "parece", "pode ser", "você tem", "deve ser" — a frase que fecha um quadro. */
const FORMAS_DE_DIAGNOSTICO =
  /\b(parece|pode ser|deve ser|provavelmente e|voce tem|voce esta com|isso e|e um caso de|e sinal de|e sintoma de|quadro de)\b/;

/** Sufixo clínico (-ite, -ose, -algia) em palavra longa, fora das exceções. */
const SUFIXO_CLINICO = /\b\w{6,}(ite|ose|algia)\b/g;

/** "suspenda", "aumente a dose", "pare de tomar" — mexer no tratamento. */
const VERBOS_DE_ORIENTACAO =
  /\b(suspenda|suspender|suspende|interrompa|interromper|pare de tomar|parar de tomar|nao tome|continue tomando|aumente|aumenta|aumentar|diminua|diminui|diminuir|reduza|reduz|reduzir|dobre|dobrar|troque|trocar)\b/;

function casaTermo(texto: string, termo: string): boolean {
  const escapado = termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${escapado}(?![a-z0-9])`).test(texto);
}

function citaMedicacao(t: string): boolean {
  return MEDICACOES.some((m) => casaTermo(t, m)) || MARCADORES_DE_MEDICACAO.some((m) => casaTermo(t, m));
}

function citaPosologia(t: string): boolean {
  return FORMAS_DE_POSOLOGIA.some((r) => r.test(t));
}

function citaCondicao(t: string): boolean {
  if (CONDICOES.some((c) => casaTermo(t, c))) return true;
  for (const m of t.matchAll(SUFIXO_CLINICO)) {
    if (!EXCECOES_DE_SUFIXO.includes(m[0])) return true;
  }
  return false;
}

export function pareceAtoMedico(texto: string | null): SuspeitaDeAtoMedico {
  if (!texto || !texto.trim()) return NAO_PARECE;
  const t = normalizarTexto(texto);

  // Orientação antes da prescrição: "pare de tomar o antibiótico" carrega o
  // verbo de uso, e o gesto mais específico (mexer num tratamento que já
  // existe) é o que nomeia o motivo.
  if (VERBOS_DE_ORIENTACAO.test(t) && citaMedicacao(t)) {
    return { parece: true, motivo: "orientacao" };
  }
  if (VERBOS_DE_PRESCRICAO.test(t) && (citaMedicacao(t) || citaPosologia(t))) {
    return { parece: true, motivo: "prescricao" };
  }
  if (FORMAS_DE_DIAGNOSTICO.test(t) && citaCondicao(t)) {
    return { parece: true, motivo: "diagnostico" };
  }
  return NAO_PARECE;
}
