/**
 * Monta o texto do Relatório das 8h a partir das 4 seções — puro depois que
 * os leitores trouxerem os dados; nenhuma conta de dinheiro nasce aqui.
 *
 * Seção incompleta entra no texto EM PALAVRAS ("dado incompleto"), nunca como
 * zero — a mesma regra que `lib/ads/sobra.ts` e `lib/financeiro/caixa.ts` já
 * seguem para os números que consomem.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { formatCentsBRL } from "@/lib/money";

import { adsDeOntem } from "./ads";
import { agendaDeHoje } from "./agenda";
import { atendimentosDaNoite } from "./atendimentos";
import { financeiroDeHoje } from "./financeiro";
import { janelaDoRelatorio, type JanelaDoRelatorio } from "./janela";
import type { ItemDeVencimento, RelatorioDiario, SecaoAds, SecaoAgenda, SecaoAtendimentos, SecaoFinanceiro } from "./tipos";

function linhaDeAtendimentos(s: SecaoAtendimentos): string {
  if (s.incompleto) return "Atendimentos: dado incompleto (não consegui ler o índice de atrito).";
  return `Atendimentos: ${s.atendidos} atendido(s), ${s.passadosParaHumano} passado(s) para humano.`;
}

function linhasDeAgenda(janela: JanelaDoRelatorio, s: SecaoAgenda): string[] {
  if (s.incompleto) return ["Agenda de hoje: dado incompleto (não consegui ler a agenda)."];
  if (s.itens.length === 0) return ["Agenda de hoje: nada marcado."];
  const linhas = [`Agenda de hoje (${s.itens.length}):`];
  for (const item of s.itens.slice(0, 8)) {
    const pago = item.pagoCents === null ? "" : ` — pago ${formatCentsBRL(item.pagoCents)}`;
    linhas.push(`- ${item.horario} ${item.titulo}${item.contatoNome ? ` (${item.contatoNome})` : ""}${pago}`);
  }
  const resto = s.itens.length - 8;
  if (resto > 0) linhas.push(`E mais ${resto}.`);
  return linhas;
}

function linhasDeAds(s: SecaoAds): string[] {
  const linhas: string[] = [];
  if (s.campanhas.length === 0 && s.propostasPendentes.length === 0) {
    linhas.push("Anúncios: sem campanha nem proposta pendente.");
    return linhas;
  }
  if (s.campanhas.length > 0) {
    const total = s.incompleto
      ? "dado incompleto (gasto não lido em algum dia)"
      : `gasto ${formatCentsBRL(s.gastoTotalCents)}, Sobra por Real ${s.sobraPorRealTotal === null ? "—" : s.sobraPorRealTotal.toFixed(2)}`;
    linhas.push(`Anúncios de ontem: ${total}.`);
    for (const c of s.campanhas.slice(0, 5)) {
      const valor = c.incompleto
        ? "dado incompleto"
        : `${formatCentsBRL(c.gastoCents)}, Sobra por Real ${c.sobraPorReal === null ? "—" : c.sobraPorReal.toFixed(2)}`;
      linhas.push(`- ${c.campaignName ?? c.campaignId}: ${valor}`);
    }
  }
  if (s.propostasPendentes.length > 0) {
    linhas.push(`Propostas do Agente de Anúncios pendentes: ${s.propostasPendentes.length}.`);
    for (const p of s.propostasPendentes.slice(0, 5)) linhas.push(`- ${p.title}`);
  }
  return linhas;
}

function linhasDeFinanceiro(s: SecaoFinanceiro): string[] {
  const linhas: string[] = [];
  linhas.push(`Caixa: ${s.caixaTotalCents === null ? "dado incompleto (falta saldo de alguma conta)" : formatCentsBRL(s.caixaTotalCents)}.`);

  const grupo = (titulo: string, itens: ItemDeVencimento[], totalCents: { payable: number; receivable: number }) => {
    if (itens.length === 0) return;
    linhas.push(`${titulo}: ${itens.length} conta(s) — ${formatCentsBRL(totalCents.payable)} a pagar e ${formatCentsBRL(totalCents.receivable)} a receber.`);
    for (const item of itens.slice(0, 5)) {
      const sinal = item.direction === "payable" ? "a pagar" : "a receber";
      linhas.push(`- ${item.description}: ${formatCentsBRL(item.amountCents)} ${sinal}`);
    }
    const resto = itens.length - 5;
    if (resto > 0) linhas.push(`E mais ${resto}.`);
  };
  grupo("Vence hoje", s.vencemHojeItens, s.vencemHojeCents);
  grupo("Já venceu", s.vencidasItens, s.vencidasCents);
  if (s.vencemHojeItens.length === 0 && s.vencidasItens.length === 0) linhas.push("Nada vence hoje nem está vencido.");
  return linhas;
}

function secoesIncompletasDe(partes: {
  atendimentos: SecaoAtendimentos;
  agenda: SecaoAgenda;
  ads: SecaoAds;
  financeiro: SecaoFinanceiro;
}): string[] {
  const nomes: string[] = [];
  if (partes.atendimentos.incompleto) nomes.push("atendimentos");
  if (partes.agenda.incompleto) nomes.push("agenda");
  if (partes.ads.incompleto) nomes.push("ads");
  if (partes.financeiro.incompleto) nomes.push("financeiro");
  return nomes;
}

export async function montarRelatorio(admin: SupabaseClient, organizationId: string, agora: Date): Promise<RelatorioDiario> {
  const janela = await janelaDoRelatorio(admin, organizationId, agora);

  const [atendimentos, agenda, ads, financeiro] = await Promise.all([
    atendimentosDaNoite(admin, janela),
    agendaDeHoje(admin, janela),
    adsDeOntem(admin, janela),
    financeiroDeHoje(admin, janela),
  ]);

  const texto = [
    `Relatório de ${janela.hoje}`,
    "",
    linhaDeAtendimentos(atendimentos),
    "",
    ...linhasDeAgenda(janela, agenda),
    "",
    ...linhasDeAds(ads),
    "",
    ...linhasDeFinanceiro(financeiro),
  ].join("\n");

  return {
    organizationId,
    hoje: janela.hoje,
    atendimentos,
    agenda,
    ads,
    financeiro,
    texto,
    secoesIncompletas: secoesIncompletasDe({ atendimentos, agenda, ads, financeiro }),
  };
}
