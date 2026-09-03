/**
 * Agenda do dia — lê `listaAgendamentos` (`lib/agenda/consulta.ts`).
 *
 * Usa `de`/`ate` (instantes), NUNCA o parâmetro `dia`: `dia` corta em UTC e
 * "para fuso negativo isso NÃO é o dia do usuário" (aviso do próprio arquivo)
 * — um compromisso das 22h sumiria da lista do próprio dia. A janela [hoje,
 * amanhã) já vem calculada no fuso da Conta por `janela.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { listaAgendamentos } from "@/lib/agenda/consulta";

import type { JanelaDoRelatorio } from "./janela";
import type { ItemDeAgenda, SecaoAgenda } from "./tipos";

/** Teto de leitura — mesma disciplina de `TETO_DE_LANCAMENTOS` na rota de caixa. */
const TETO_DE_AGENDAMENTOS = 200;

function horarioCurto(iniciaEm: string, fuso: string): string {
  return new Date(iniciaEm).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: fuso });
}

export async function agendaDeHoje(admin: SupabaseClient, janela: JanelaDoRelatorio): Promise<SecaoAgenda> {
  const resultado = await listaAgendamentos(admin, janela.organizationId, {
    de: janela.hojeInicioISO,
    ate: janela.hojeFimISO,
    limite: TETO_DE_AGENDAMENTOS,
  });
  if (!resultado.ok) {
    return { itens: [], incompleto: true };
  }

  const itens: ItemDeAgenda[] = resultado.agendamentos
    .filter((a) => a.situacao !== "cancelled")
    .map((a) => ({
      titulo: a.titulo,
      horario: horarioCurto(a.iniciaEm, janela.fuso),
      contatoNome: a.contatoNome,
      situacao: a.situacao,
      pagoCents: a.pagoCents,
    }));

  return { itens, incompleto: false };
}
