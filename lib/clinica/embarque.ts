/**
 * O Embarque da clínica: coloca uma Conta de saúde no ar a partir de UM arquivo
 * com o que só o Dono tem — Profissionais, serviços, expediente, preços,
 * convênios, endereço.
 *
 * Tudo aqui é idempotente por construção: rodar duas vezes com o mesmo arquivo
 * deixa o banco no mesmo estado e o relatório diz o que foi feito e o que foi
 * pulado (com motivo). Nada é apagado; o que já existe é atualizado pelo seu
 * identificador estável (slug do serviço, e-mail do Profissional, md5 do
 * playbook, conteúdo do prompt).
 *
 * O que o Embarque NÃO faz, de propósito:
 *  - não cria usuário: Profissional sem conta na organização é reportado em
 *    `pulado` com `usuario_inexistente`. Convidar gente é o passo de equipe do
 *    onboarding, com e-mail e aceite — não um script;
 *  - não publica a primeira versão do agente: isso exige canal, provedor,
 *    modelo e chave, que o onboarding (`createDefaultAgent.ts`) já resolve. Sem
 *    versão publicada, reporta `sem_versao_publicada`. Com ela, publica a
 *    seguinte só acrescentando o que falta (capacidades + playbook);
 *  - não toca `inbound-turn.ts`: o playbook é conteúdo (camada `tenant` por
 *    ponteiro E `system_prompt` da versão, porque `loadPlaybook` substitui a
 *    camada tenant pelo prompt da versão publicada).
 *
 * `admin` e `pool` são injetados: o teste ao lado registra as operações em
 * dublês; o script `scripts/clinica/embarque.ts` passa os de verdade.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";
import { z } from "zod";

import { insertPlaybookVersion, setPlaybookPointer } from "@/lib/agent-engine/agent/playbook";
import { catalogoComHandler } from "@/lib/ai/agents/capacidades-padrao";
import { publicarMemoriaDaOrg } from "@/lib/ai/memoria-da-org";
import { audit } from "@/lib/audit";
import { instalarAvisoDeIa } from "@/lib/clinica/aviso-de-ia";
import { aplicarConfiguracaoClinica } from "@/lib/clinica/config";
import { SLUG_ETAPA_POR_TRANSICAO } from "@/lib/leads/appointment-stage-move";
import type { ToolBundle } from "@/lib/mcp/tools/pacotes";
import { ligarPacote, TETO_TOOLS_POR_AGENTE } from "@/lib/mcp/tools/selecao-por-pacote";

import { PLAYBOOK_DA_CLINICA } from "./playbook";

// ─── o arquivo ──────────────────────────────────────────────────────────────

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

const janelaSchema = z
  .object({
    /** 0 = domingo … 6 = sábado, como `attendant_availability.schedule`. */
    dow: z.number().int().min(0).max(6),
    start: z.string().regex(HORA, "hora no formato HH:MM"),
    end: z.string().regex(HORA, "hora no formato HH:MM"),
  })
  .refine((j) => j.start < j.end, { message: "start precisa vir antes de end" });

const expedienteSchema = z.object({
  timezone: z.string().trim().min(1),
  windows: z.array(janelaSchema).min(1, "expediente sem janela nenhuma"),
});

const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

/** O CHECK `calendar_event_types_category_check` do banco, na mesma ordem. */
export const CATEGORIAS_DE_SERVICO = [
  "consulta",
  "procedimento",
  "retorno",
  "visita",
  "vistoria",
  "reuniao",
  "call",
  "orcamento",
  "demonstracao",
  "outro",
] as const;

const servicoSchema = z.object({
  /** Handle estável do tipo — `calendar_event_types.slug`, único por org. */
  slug: z.string().regex(/^[a-z0-9-]{2,60}$/, "slug: minúsculas, dígitos e hífen"),
  nome: z.string().trim().min(1).max(120),
  duracao_minutos: z.number().int().min(5).max(1440),
  categoria: z.enum(CATEGORIAS_DE_SERVICO).default("consulta"),
  /** Preço cadastrado; ausente = a equipe informa (o Agente não chuta). */
  price_cents: z.number().int().min(0).optional(),
  /** Margem Declarada em pontos-base (6000 = 60%). */
  margin_bps: z.number().int().min(0).max(10000).optional(),
  /** Quem atende este serviço — precisa estar em `profissionais`. */
  profissional_email: emailSchema.optional(),
  /** Liga o lembrete do tipo com esta antecedência (1440 = 24h). */
  lembrete_minutos_antes: z.number().int().min(0).max(43200).optional(),
});

const profissionalSchema = z.object({
  email: emailSchema,
  nome: z.string().trim().min(1).max(120),
  /** Sem expediente próprio, vale o da clínica. */
  expediente: expedienteSchema.optional(),
});

export const embarqueSchema = z
  .object({
    organization_id: z.uuid(),
    dono: z.object({
      nome: z.string().trim().min(1).max(120),
      whatsapp: z.string().trim().min(8).max(20),
    }),
    profissionais: z.array(profissionalSchema).min(1, "pelo menos um Profissional"),
    servicos: z.array(servicoSchema).min(1, "pelo menos um serviço"),
    convenios: z.array(z.string().trim().min(1).max(80)).default([]),
    endereco: z.string().trim().min(1).max(300),
    expediente_da_clinica: expedienteSchema,
  })
  .superRefine((d, ctx) => {
    const emails = new Set(d.profissionais.map((p) => p.email));
    d.servicos.forEach((s, i) => {
      if (s.profissional_email !== undefined && !emails.has(s.profissional_email)) {
        ctx.addIssue({
          code: "custom",
          path: ["servicos", i, "profissional_email"],
          message: `${s.profissional_email} não está em profissionais`,
        });
      }
    });
    const slugs = d.servicos.map((s) => s.slug);
    if (new Set(slugs).size !== slugs.length) {
      ctx.addIssue({ code: "custom", path: ["servicos"], message: "slug repetido" });
    }
  })
  .transform((d) => ({
    ...d,
    profissionais: d.profissionais.map((p) => ({
      ...p,
      expediente: p.expediente ?? d.expediente_da_clinica,
    })),
  }));

export type Embarque = z.output<typeof embarqueSchema>;
export type ExpedienteDoEmbarque = z.output<typeof expedienteSchema>;

export interface RelatorioDoEmbarque {
  feito: string[];
  pulado: Array<{ item: string; motivo: string }>;
}

// ─── capacidades ────────────────────────────────────────────────────────────

/**
 * Os pacotes que a clínica liga. `vender` carrega a família de agenda inteira
 * (listar tipos, achar horário, marcar, remarcar, confirmar); `evoluir` carrega
 * a busca no acervo e a memória da org. A passagem para humano é a ferramenta
 * NATIVA `request_human_handoff` (ligada por `handoff_tool_enabled`), não um id
 * do catálogo — a variante do catálogo está em `BLOCKED_TOOL_IDS`.
 *
 * Por que não `escalar` nem `atender`: `vender` (19) + `escalar` (10) já passa
 * do teto de 25; `vender` + `evoluir` cabe (24). Medido contra o catálogo com
 * handler. Nunca lista à mão — derivado dos pacotes em tempo de execução, como
 * `capacidadesPadraoDoOnboarding`.
 */
export const PACOTES_DA_CLINICA: readonly ToolBundle[] = ["vender", "evoluir"];

export function capacidadesDaClinica(existentes: readonly string[]): string[] {
  const catalogo = catalogoComHandler();
  return PACOTES_DA_CLINICA.reduce<string[]>(
    (acc, pacote) => ligarPacote(acc, catalogo, pacote),
    [...existentes],
  );
}

// ─── memória da org ─────────────────────────────────────────────────────────

const DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/** "segunda a sexta, 07:00–19:30" — agrupa janelas iguais e resume dias seguidos. */
export function descreverExpediente(exp: ExpedienteDoEmbarque): string {
  const porHorario = new Map<string, number[]>();
  for (const j of exp.windows) {
    const chave = `${j.start}–${j.end}`;
    porHorario.set(chave, [...(porHorario.get(chave) ?? []), j.dow]);
  }
  const partes: string[] = [];
  for (const [horario, dows] of porHorario) {
    const ordenados = [...new Set(dows)].sort((a, b) => a - b);
    const seguidos =
      ordenados.length >= 3 && ordenados.every((d, i) => i === 0 || d === ordenados[i - 1]! + 1);
    const dias = seguidos
      ? `${DIAS[ordenados[0]!]} a ${DIAS[ordenados[ordenados.length - 1]!]}`
      : ordenados.map((d) => DIAS[d]).join(", ");
    partes.push(`${dias}, ${horario}`);
  }
  return `${partes.join("; ")} (fuso ${exp.timezone})`;
}

/**
 * O que o Agente precisa saber da clínica e que não cabe em tabela nenhuma:
 * endereço, expediente e convênios. Vai para a memória da org — o mesmo lugar
 * que a tela de Memória edita depois. O WhatsApp do Dono fica de fora: é
 * contato de operação, não informação para o Paciente.
 */
export function memoriaDaClinica(dados: Embarque): string {
  const convenios =
    dados.convenios.length > 0
      ? `Convênios aceitos: ${dados.convenios.join(", ")}.`
      : "Convênios: nenhum cadastrado. Se perguntarem, diga que a equipe confirma se o convênio é aceito.";
  const servicos = dados.servicos.map((s) => `${s.nome} (${s.duracao_minutos} min)`).join(", ");
  return [
    "# Informações da clínica",
    `Endereço: ${dados.endereco}.`,
    `Horário de funcionamento: ${descreverExpediente(dados.expediente_da_clinica)}.`,
    convenios,
    `Serviços: ${servicos}.`,
    "Preço: só o que estiver cadastrado no serviço; sem preço cadastrado, a equipe informa.",
  ].join("\n");
}

// ─── o embarque ─────────────────────────────────────────────────────────────

interface Escrita {
  error: { message: string } | null;
}

async function escrever(q: PromiseLike<Escrita>, rotulo: string): Promise<void> {
  const { error } = await q;
  if (error) throw new Error(`${rotulo}: ${error.message}`);
}

function mesmaLista(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

async function usuariosDaOrg(
  pool: pg.Pool,
  orgId: string,
  emails: readonly string[],
): Promise<Map<string, string>> {
  if (emails.length === 0) return new Map();
  const { rows } = await pool.query<{ id: string; email: string }>(
    `select u.id, lower(u.email) as email
       from auth.users u
       join user_organizations uo on uo.user_id = u.id
      where uo.organization_id = $1
        and uo.revoked_at is null
        and lower(u.email) = any($2::text[])`,
    [orgId, [...emails]],
  );
  return new Map(rows.map((r) => [r.email, r.id]));
}

export async function executarEmbarque(
  admin: SupabaseClient,
  pool: pg.Pool,
  dados: Embarque,
): Promise<RelatorioDoEmbarque> {
  const feito: string[] = [];
  const pulado: RelatorioDoEmbarque["pulado"] = [];
  const orgId = dados.organization_id;

  // 0 · a Conta existe? Não é relatório, é erro: nada abaixo faz sentido sem ela.
  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .select("id, settings")
    .eq("id", orgId)
    .maybeSingle();
  if (orgErr) throw new Error(`organizations: ${orgErr.message}`);
  if (!org) throw new Error(`organização ${orgId} não existe`);

  // 1 · redação clínica ligada (ADR-0004) — merge não destrutivo em settings.
  const settings = aplicarConfiguracaoClinica(
    (org.settings as Record<string, unknown> | null) ?? null,
    { redacao: true },
  );
  await escrever(admin.from("organizations").update({ settings }).eq("id", orgId), "organizations");
  feito.push("redacao_clinica");

  // 2 · funil padrão: vocabulário e as duas etapas que a agenda espelha.
  const { data: funil, error: funilErr } = await admin
    .from("crm_pipelines")
    .select("id, vocabulary")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .eq("is_archived", false)
    .maybeSingle();
  if (funilErr) throw new Error(`crm_pipelines: ${funilErr.message}`);
  if (!funil) {
    pulado.push({ item: "funil", motivo: "sem_funil_padrao" });
  } else {
    const pipelineId = funil.id as string;
    // Mesmo merge de `updatePipelineConfig`: o que o Dono já renomeou fica.
    const vocabulary = {
      ...((funil.vocabulary as Record<string, unknown> | null) ?? {}),
      lead: "Paciente",
      won: "Agendado",
    };
    await escrever(
      admin.from("crm_pipelines").update({ vocabulary }).eq("id", pipelineId),
      "crm_pipelines",
    );
    feito.push("vocabulario:Paciente/Agendado");

    const { data: etapas, error: etapasErr } = await admin
      .from("crm_stages")
      .select("slug, position")
      .eq("pipeline_id", pipelineId)
      .eq("is_archived", false)
      .order("position");
    if (etapasErr) throw new Error(`crm_stages: ${etapasErr.message}`);
    const existentes = new Set((etapas ?? []).map((e) => String(e.slug)));
    let ultima = Math.max(0, ...(etapas ?? []).map((e) => Number(e.position)));
    const alvos: Array<{ slug: string; name: string }> = [
      { slug: SLUG_ETAPA_POR_TRANSICAO.pending!, name: "Agendamento solicitado" },
      { slug: SLUG_ETAPA_POR_TRANSICAO.confirmed!, name: "Agendado" },
    ];
    for (const etapa of alvos) {
      if (existentes.has(etapa.slug)) continue;
      ultima += 1000;
      await escrever(
        admin.from("crm_stages").insert({
          organization_id: orgId,
          pipeline_id: pipelineId,
          name: etapa.name,
          slug: etapa.slug,
          position: ultima,
        }),
        `crm_stages(${etapa.slug})`,
      );
      feito.push(`etapa:${etapa.slug}`);
    }
  }

  // 3 · quem existe: os e-mails do arquivo que têm usuário nesta organização.
  const emails = [
    ...new Set([
      ...dados.profissionais.map((p) => p.email),
      ...dados.servicos.flatMap((s) => (s.profissional_email ? [s.profissional_email] : [])),
    ]),
  ];
  const usuarios = await usuariosDaOrg(pool, orgId, emails);

  // 4 · expediente por Profissional.
  for (const p of dados.profissionais) {
    const userId = usuarios.get(p.email);
    if (!userId) {
      pulado.push({ item: `profissional:${p.email}`, motivo: "usuario_inexistente" });
      continue;
    }
    await escrever(
      admin.from("attendant_availability").upsert(
        { organization_id: orgId, user_id: userId, is_available: true, schedule: p.expediente },
        { onConflict: "organization_id,user_id" },
      ),
      `attendant_availability(${p.email})`,
    );
    feito.push(`profissional:${p.email}`);
  }

  // 5 · serviços: upsert por slug. Só o que o arquivo traz é escrito — preço
  // ausente não zera o que o Dono cadastrou pela tela.
  for (const s of dados.servicos) {
    const donoId = s.profissional_email ? usuarios.get(s.profissional_email) : undefined;
    if (s.profissional_email && !donoId) {
      pulado.push({ item: `servico:${s.slug}:profissional`, motivo: "usuario_inexistente" });
    }
    const linha: Record<string, unknown> = {
      organization_id: orgId,
      slug: s.slug,
      name: s.nome,
      category: s.categoria,
      duration_minutes: s.duracao_minutos,
      is_active: true,
    };
    if (s.price_cents !== undefined) linha.price_cents = s.price_cents;
    if (s.margin_bps !== undefined) linha.margin_bps = s.margin_bps;
    if (s.lembrete_minutos_antes !== undefined) {
      // O fork faz o lembrete nascer desligado (migration 0194); o arquivo liga.
      linha.reminder_enabled = true;
      linha.reminder_minutes_before = s.lembrete_minutos_antes;
    }
    if (donoId) linha.default_owner_user_id = donoId;
    await escrever(
      admin.from("calendar_event_types").upsert(linha, { onConflict: "organization_id,slug" }),
      `calendar_event_types(${s.slug})`,
    );
    feito.push(`servico:${s.slug}`);
  }

  // 6 · playbook tenant — idempotente por md5 do corpo (padrão da migration
  // 0191): acha a versão pelo hash, senão insere; o ponteiro anda SEMPRE.
  const { rows: versoes } = await pool.query<{ id: string }>(
    `select id from playbook_versions
      where organization_id = $1 and layer = 'tenant' and md5(content) = md5($2)
      order by created_at desc limit 1`,
    [orgId, PLAYBOOK_DA_CLINICA],
  );
  let playbookVersionId = versoes[0]?.id;
  if (!playbookVersionId) {
    const nova = await insertPlaybookVersion(pool, {
      tenantId: orgId,
      layer: "tenant",
      content: PLAYBOOK_DA_CLINICA,
    });
    playbookVersionId = nova.id;
  }
  await setPlaybookPointer(pool, { tenantId: orgId, layer: "tenant", versionId: playbookVersionId });
  feito.push("playbook:tenant");

  // 7 · aviso de IA (CFM 2.454/2026).
  await instalarAvisoDeIa(pool, orgId);
  feito.push("aviso_de_ia");

  // 8 · memória da org: endereço, expediente, convênios. Publicada em nome do
  // primeiro Profissional com usuário — `created_by` é FK para auth.users.
  const autor = dados.profissionais.map((p) => usuarios.get(p.email)).find((id) => id);
  if (!autor) {
    pulado.push({ item: "memoria_da_org", motivo: "usuario_inexistente" });
  } else {
    const texto = memoriaDaClinica(dados);
    const { data: ultima, error: memErr } = await admin
      .from("org_memory_versions")
      .select("content")
      .eq("organization_id", orgId)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (memErr) throw new Error(`org_memory_versions: ${memErr.message}`);
    if (ultima?.content === texto) {
      feito.push("memoria_da_org:ja_publicada");
    } else {
      const pub = await publicarMemoriaDaOrg(admin, orgId, autor, texto);
      if (pub.ok) feito.push("memoria_da_org");
      else pulado.push({ item: "memoria_da_org", motivo: `${pub.erro}:${pub.mensagem}` });
    }
  }

  // 9 · versão do agente: acrescenta as capacidades e o playbook ao que está
  // publicado. Nunca inventa canal, modelo ou chave.
  await publicarVersaoDaClinica(admin, orgId, feito, pulado);

  await audit({
    action: "clinica.embarque_executado",
    organizationId: orgId,
    resourceType: "organization",
    resourceId: orgId,
    bypassedRls: true,
    metadata: { feito, pulado },
  });

  return { feito, pulado };
}

async function publicarVersaoDaClinica(
  admin: SupabaseClient,
  orgId: string,
  feito: string[],
  pulado: RelatorioDoEmbarque["pulado"],
): Promise<void> {
  const { data: agente, error: agenteErr } = await admin
    .from("ai_agents")
    .select("id, published_version_id")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .is("archived_at", null)
    .maybeSingle();
  if (agenteErr) throw new Error(`ai_agents: ${agenteErr.message}`);
  const publicadaId = agente?.published_version_id as string | null | undefined;
  if (!agente || !publicadaId) {
    pulado.push({ item: "agente", motivo: "sem_versao_publicada" });
    return;
  }

  const { data: versao, error: versaoErr } = await admin
    .from("ai_agent_versions")
    .select("*")
    .eq("id", publicadaId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (versaoErr) throw new Error(`ai_agent_versions: ${versaoErr.message}`);
  if (!versao) {
    pulado.push({ item: "agente", motivo: "versao_publicada_nao_encontrada" });
    return;
  }

  const atual = versao as Record<string, unknown>;
  const toolIdsAtuais = (atual.tool_ids as string[] | null) ?? [];
  const toolIds = capacidadesDaClinica(toolIdsAtuais);
  const promptAtual = String(atual.system_prompt ?? "");
  const prompt = promptAtual.includes(PLAYBOOK_DA_CLINICA)
    ? promptAtual
    : `${promptAtual.trimEnd()}\n\n${PLAYBOOK_DA_CLINICA}`;
  const mudou =
    prompt !== promptAtual ||
    !mesmaLista(toolIds, toolIdsAtuais) ||
    atual.handoff_tool_enabled !== true;
  if (!mudou) {
    feito.push("agente:ja_no_ar");
    return;
  }
  if (toolIds.length > TETO_TOOLS_POR_AGENTE) {
    pulado.push({ item: "agente", motivo: `teto_de_capacidades:${toolIds.length}>${TETO_TOOLS_POR_AGENTE}` });
    return;
  }

  // Cópia da versão publicada com o que muda por cima. `select("*")` de
  // propósito: coluna nova na versão vem junto em vez de sumir na cópia.
  const {
    id: _id,
    version_number,
    status: _status,
    published_at: _publishedAt,
    superseded_at: _supersededAt,
    created_at: _createdAt,
    created_by: _createdBy,
    ...copia
  } = atual;
  const numero = Number(version_number) + 1;
  const agora = new Date().toISOString();
  const { data: nova, error: novaErr } = await admin
    .from("ai_agent_versions")
    .insert({
      ...copia,
      version_number: numero,
      system_prompt: prompt,
      tool_ids: toolIds,
      handoff_tool_enabled: true,
      status: "published",
      published_at: agora,
      superseded_at: null,
      created_by: null,
    })
    .select("id")
    .single();
  if (novaErr || !nova) throw new Error(`ai_agent_versions: ${novaErr?.message ?? "insert_sem_id"}`);

  // Mesma ordem de `pauseAgentAction`: supera a anterior e move o ponteiro.
  await escrever(
    admin
      .from("ai_agent_versions")
      .update({ status: "superseded", superseded_at: agora })
      .eq("id", publicadaId)
      .eq("organization_id", orgId)
      .eq("status", "published"),
    "ai_agent_versions(superseded)",
  );
  await escrever(
    admin
      .from("ai_agents")
      .update({ published_version_id: nova.id })
      .eq("id", agente.id)
      .eq("organization_id", orgId),
    "ai_agents",
  );
  feito.push(`agente:v${numero}`);
}
