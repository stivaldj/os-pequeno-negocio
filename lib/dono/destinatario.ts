/**
 * O destinatário "dono" — um contato e uma conversa nos quais o produto escreve.
 *
 * ─── Por que existe ─────────────────────────────────────────────────────────
 *
 * Vigias, o Agente de Anúncios e o relatório das 8h precisam FALAR com o Dono
 * pelo WhatsApp — e o único caminho de saída do sistema é uma conversa numa
 * sessão de canal, enviada por `sendMessageHandler`. Este módulo garante que
 * essa conversa exista: o Dono vira um contato (`source: 'dono'`) da própria
 * Conta, com o número de `settings.dono.whatsapp`, e ganha uma conversa na
 * sessão de canal ativa. Quem quer avisar chama `enviarAoDono` e pronto.
 *
 * ─── O que reusa, de propósito ──────────────────────────────────────────────
 *
 * - `encontrarContatoPorTelefone`: as duas grafias do mesmo número (nono dígito)
 *   já são UM contato para o resto do produto; aqui também, senão o Dono que
 *   um dia mandou mensagem para a clínica viraria dois cadastros.
 * - `fn_upsert_wa_conversation`: a MESMA RPC dos ingestores — a conversa do
 *   Dono é uma conversa como qualquer outra (índice único por org/contato/
 *   sessão), e a RPC já resolve "acha ou cria".
 * - `sendMessageHandler` com ator `ai_agent`/`manager`, como
 *   `lib/ai/handoff/aviso-ao-lead.ts` e `lib/agenda/lembretes.ts`: recusa
 *   contato bloqueado e despacha pelo adapter do canal (o provider é decisão
 *   do seam `lib/channels/`, não deste arquivo). Não existe ator "sistema".
 *
 * ─── O que não faz ──────────────────────────────────────────────────────────
 *
 * Não lança. Um aviso que não sai devolve `{ ok: false, motivo }` e vai para o
 * log; quem chama (um vigia, um cron) não pode cair por causa dele. E não
 * abre canal: sem sessão `WORKING` na Conta, o motivo é `sem_canal` — o vigia
 * de rotinas, em particular, avisa o Dono pelo mesmo canal que pode estar
 * caído, e essa limitação fica registrada nele.
 *
 * Limitação conhecida: a conversa do Dono é uma conversa normal, então uma
 * RESPOSTA dele entra pelo ingestor como mensagem de contato e pode acordar o
 * Agente. Silenciar o Agente nessa conversa é decisão de fase posterior.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { encontrarContatoPorTelefone } from "@/lib/channels/contato-por-telefone";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { logger } from "@/lib/logger";

import { whatsappDoDono } from "./config";

/** Ator do envio — é o automático falando, não uma pessoa. */
const ATOR_DO_DONO = "dono";

const NOME_DO_CONTATO = "Dono";
const SOURCE_DO_CONTATO = "dono";

export type MotivoSemDono =
  | "sem_whatsapp_do_dono"
  | "sem_canal"
  | "org_nao_encontrada"
  | "contato_falhou"
  | "conversa_falhou";

export type ConversaDoDono =
  | { ok: true; contactId: string; conversationId: string; channelSessionId: string }
  | { ok: false; motivo: MotivoSemDono };

export type ResultadoDoEnvio = { ok: true } | { ok: false; motivo: string };

async function whatsappDaConta(admin: SupabaseClient, orgId: string): Promise<string | null | undefined> {
  const { data, error } = await admin.from("organizations").select("settings").eq("id", orgId).maybeSingle();
  if (error) throw new Error(`organizations (${orgId}): ${error.message}`);
  if (!data) return undefined;
  return whatsappDoDono((data as { settings: unknown }).settings);
}

/** A sessão `WORKING` mais recente da Conta, ignorando as arquivadas. */
async function sessaoAtiva(admin: SupabaseClient, orgId: string): Promise<string | null> {
  const listar = (comArchived: boolean) => {
    let q = admin
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", orgId)
      .eq("status", "WORKING");
    if (comArchived) q = q.is(ARCHIVED_AT, null);
    return q.order("created_at", { ascending: false }).limit(1);
  };
  const { data, error } = await queryTolerantToMissingArchived(
    () => listar(true),
    () => listar(false),
  );
  if (error) throw new Error(`channel_sessions (${orgId}): ${error.message}`);
  return (data as Array<{ id: string }> | null)?.[0]?.id ?? null;
}

/**
 * Acha o contato do Dono pelas grafias do número; senão cria. Se dois crons
 * criarem ao mesmo tempo, o índice único por org/telefone derruba um deles
 * (23505) — e a busca de novo devolve o que o outro criou.
 */
async function contatoDoDono(admin: SupabaseClient, orgId: string, whatsapp: string): Promise<string | null> {
  const existente = await encontrarContatoPorTelefone(admin, orgId, whatsapp);
  if (existente) return existente.id;

  const { data, error } = await admin
    .from("contacts")
    .insert({
      organization_id: orgId,
      name: NOME_DO_CONTATO,
      display_name: NOME_DO_CONTATO,
      phone_number: canonicalPhoneBR(whatsapp),
      source: SOURCE_DO_CONTATO,
    })
    .select("id")
    .single();
  if (!error && data) return (data as { id: string }).id;

  if (error?.code === "23505") {
    const corrida = await encontrarContatoPorTelefone(admin, orgId, whatsapp);
    if (corrida) return corrida.id;
  }
  logger.warn("[dono] contato do Dono não criado", { organization_id: orgId, error: error?.message });
  return null;
}

/**
 * Garante contato e conversa do Dono na Conta. Lança só por erro de banco na
 * leitura — `enviarAoDono` embrulha; quem chama direto decide o que fazer.
 */
export async function garantirConversaDoDono(admin: SupabaseClient, orgId: string): Promise<ConversaDoDono> {
  const whatsapp = await whatsappDaConta(admin, orgId);
  if (whatsapp === undefined) return { ok: false, motivo: "org_nao_encontrada" };
  if (whatsapp === null) return { ok: false, motivo: "sem_whatsapp_do_dono" };

  // Sessão ANTES do contato: sem canal não há por que cadastrar ninguém.
  const channelSessionId = await sessaoAtiva(admin, orgId);
  if (!channelSessionId) return { ok: false, motivo: "sem_canal" };

  const contactId = await contatoDoDono(admin, orgId, whatsapp);
  if (!contactId) return { ok: false, motivo: "contato_falhou" };

  const { data: conversationId, error } = await admin.rpc(
    "fn_upsert_wa_conversation" as never,
    { p_org: orgId, p_contact: contactId, p_session: channelSessionId } as never,
  );
  if (error || !conversationId) {
    logger.warn("[dono] conversa do Dono não aberta", { organization_id: orgId, error: error?.message ?? "sem id" });
    return { ok: false, motivo: "conversa_falhou" };
  }

  return { ok: true, contactId, conversationId: String(conversationId), channelSessionId };
}

/**
 * Manda um texto ao Dono da Conta. NUNCA lança: devolve `{ ok: false, motivo }`
 * e loga — sem o texto, que pode citar o que o chamador não quer no log.
 */
export async function enviarAoDono(admin: SupabaseClient, orgId: string, texto: string): Promise<ResultadoDoEnvio> {
  try {
    const conversa = await garantirConversaDoDono(admin, orgId);
    if (!conversa.ok) {
      logger.warn("[dono] aviso ao Dono não saiu", { organization_id: orgId, motivo: conversa.motivo });
      return conversa;
    }
    await sendMessageHandler(
      admin,
      {
        organization_id: orgId,
        actor: { type: "ai_agent", id: ATOR_DO_DONO, role: "manager" },
        requestId: `dono-${orgId}-${Date.now()}`,
      },
      {
        conversation_id: conversa.conversationId,
        type: "text",
        body: texto,
        // A linha se DECLARA: é texto de sistema para o Dono, não fala do agente.
        metadata: { aviso_ao_dono: true },
      },
    );
    return { ok: true };
  } catch (err) {
    const nome = err instanceof Error ? err.name : "erro_desconhecido";
    logger.warn("[dono] aviso ao Dono lançou", {
      organization_id: orgId,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return { ok: false, motivo: `envio_falhou:${nome}` };
  }
}

export interface ResultadoDosEnvios {
  enviados: string[];
  pulados: { organizationId: string; motivo: string }[];
}

/**
 * Para quem fala no nível da INSTALAÇÃO (o vigia de rotinas, com
 * `organization_id` nulo): avisa o Dono de cada Conta que configurou o número.
 * Também nunca lança.
 */
export async function enviarAosDonos(admin: SupabaseClient, texto: string): Promise<ResultadoDosEnvios> {
  const resultado: ResultadoDosEnvios = { enviados: [], pulados: [] };
  let orgs: { id: string; settings: unknown }[];
  try {
    const { data, error } = await admin.from("organizations").select("id, settings");
    if (error) throw new Error(error.message);
    orgs = (data ?? []) as { id: string; settings: unknown }[];
  } catch (err) {
    logger.warn("[dono] Contas não lidas — ninguém avisado", {
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return resultado;
  }

  for (const org of orgs) {
    if (whatsappDoDono(org.settings) === null) {
      resultado.pulados.push({ organizationId: org.id, motivo: "sem_whatsapp_do_dono" });
      continue;
    }
    const r = await enviarAoDono(admin, org.id, texto);
    if (r.ok) resultado.enviados.push(org.id);
    else resultado.pulados.push({ organizationId: org.id, motivo: r.motivo });
  }
  return resultado;
}
