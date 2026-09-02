/**
 * PROVA DA FASE 4 (issue #22, Spec 0003): da mensagem clínica redigida à
 * consulta paga — pelo adapter fake, sem WhatsApp e sem modelo.
 *
 *   pnpm tsx scripts/prova-agenda.ts            # contra a pilha local (supabase start)
 *   PROVA_GOOGLE=1 pnpm tsx scripts/prova-agenda.ts   # e empurra ao Google Calendar conectado
 *   pnpm tsx scripts/prova-agenda.ts --manter   # não apaga a org de prova no fim
 *
 * Pré-requisito: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e
 * `SUPABASE_DB_URL` no ambiente (ou `.env.local`), apontando para um banco com
 * o `supabase/baseline.sql` aplicado.
 */
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { anunciarDestino, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";
import { afirmar, passo, pular } from "./lib/prova";

const credenciais = credenciaisSupabaseDeTeste();
if (!credenciais.url || !credenciais.serviceRole || !credenciais.dbUrl) {
  console.error(
    "prova-agenda: faltam NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e/ou SUPABASE_DB_URL.\n" +
      "Suba a pilha local (`supabase start`), exporte as variáveis de `supabase status -o env` e aplique o baseline.",
  );
  process.exit(2);
}
anunciarDestino("prova-agenda", credenciais);
for (const [k, v] of Object.entries({
  NEXT_PUBLIC_SUPABASE_URL: credenciais.url,
  SUPABASE_SERVICE_ROLE_KEY: credenciais.serviceRole,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: credenciais.anonKey,
  NEXT_PUBLIC_APP_URL: credenciais.appUrl,
  SUPABASE_DB_URL: credenciais.dbUrl,
})) process.env[k] ??= v as string;

const MANTER = process.argv.includes("--manter");
const FUSO = "America/Cuiaba";
const SLUG_ORG = "clinica-prova-agenda";
const SLUG_TIPO = "consulta-clinica-geral-prova";
const EMAIL_PROFISSIONAL = "profissional.prova@clinica.invalid";

async function main(): Promise<void> {
  // Módulos do produto só depois do ambiente estar no lugar: `lib/env` valida ao importar.
  const { handleInboundWebhook } = await import("@/lib/channels/inbound");
  const { garantirSessaoFake } = await import("@/lib/channels/fake/sessao");
  const { lerEnviados, limparCaixaFake } = await import("@/lib/channels/fake/caixa");
  const { MARCADOR_CLINICO } = await import("@/lib/clinica/redacao");
  const { crmListEventTypes, crmFindFreeSlots, crmBookAppointment } = await import("@/lib/mcp/tools/agendamento");
  const { alterarAgendamentoHandler } = await import("@/app/api/v1/agenda/agendamentos/_handler");
  const { enviarLembretesDevidos } = await import("@/lib/agenda/lembretes");

  const admin = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
  const pool = new pg.Pool({ connectionString: credenciais.dbUrl });
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

  // ── 1. Conta de saúde, Profissional, serviço com preço, sessão fake, contato ──
  const orgId = await passo("Conta de saúde com redação clínica ligada", async () => {
    const { rows } = await pool.query(
      `insert into public.organizations (slug, legal_name, display_name, timezone, settings)
         values ($1, 'Clínica Prova', 'Clínica Prova', $2, '{"clinica":{"redacao_clinica":true}}'::jsonb)
       on conflict (slug) do update set settings = excluded.settings
       returning id`,
      [SLUG_ORG, FUSO],
    );
    return rows[0].id as string;
  });

  const profissionalId = await passo("Profissional com Expediente seg–sex 07:00–19:30", async () => {
    const { data: lista } = await admin.auth.admin.listUsers({ perPage: 1000 });
    let user = lista?.users.find((u) => u.email === EMAIL_PROFISSIONAL) ?? null;
    if (!user) {
      const { data, error } = await admin.auth.admin.createUser({
        email: EMAIL_PROFISSIONAL,
        password: "prova-agenda-" + Math.random().toString(36).slice(2),
        email_confirm: true,
        user_metadata: { full_name: "Dra. Prova" },
      });
      if (error || !data.user) throw new Error(`criar profissional: ${error?.message}`);
      user = data.user;
    }
    await q(
      `insert into public.user_organizations (user_id, organization_id, role, accepted_at) values ($1, $2, 'agent', now())
       on conflict do nothing`,
      [user.id, orgId],
    );
    const schedule = { timezone: FUSO, windows: [1, 2, 3, 4, 5].map((dow) => ({ dow, start: "07:00", end: "19:30" })) };
    const { error } = await admin
      .from("attendant_availability")
      .upsert({ organization_id: orgId, user_id: user.id, is_available: true, schedule } as never, { onConflict: "organization_id,user_id" });
    if (error) throw new Error(`attendant_availability: ${error.message}`);
    return user.id;
  });

  const tipoId = await passo("Serviço com preço R$ 200 e Margem Declarada 60%, lembrete 24h", async () => {
    const { rows } = await pool.query(
      `insert into public.calendar_event_types
         (organization_id, name, slug, category, duration_minutes, location_kind, default_owner_user_id,
          price_cents, margin_bps, reminder_enabled, reminder_minutes_before, minimum_notice_minutes, booking_window_days)
       values ($1, 'Consulta clínica geral (prova)', $2, 'consulta', 30, 'in_person', $3, 20000, 6000, true, 1440, 0, 30)
       on conflict (organization_id, slug) do update
         set price_cents = excluded.price_cents, margin_bps = excluded.margin_bps,
             reminder_enabled = true, reminder_minutes_before = 1440, default_owner_user_id = excluded.default_owner_user_id
       returning id`,
      [orgId, SLUG_TIPO, profissionalId],
    );
    return rows[0].id as string;
  });

  const sessao = await passo("Sessão de canal fake", async () => garantirSessaoFake(admin as never, orgId));

  const contatoId = await passo("Contato (paciente)", async () => {
    const { rows } = await pool.query(
      `insert into public.contacts (organization_id, display_name, phone_number) values ($1, 'Paciente Prova', '+5565999990101')
       on conflict do nothing returning id`,
      [orgId],
    );
    if (rows[0]) return rows[0].id as string;
    const r = await q(`select id from public.contacts where organization_id = $1 and phone_number = '+5565999990101'`, [orgId]);
    return r[0].id as string;
  });

  // ── 2. Mensagem clínica pelo adapter fake: redigida e em Passagem (Fase 3) ──
  await passo("Mensagem clínica entra redigida e a conversa vai para humano", async () => {
    limparCaixaFake();
    const r = await handleInboundWebhook(admin as never, {
      session: { id: sessao.sessionId, organization_id: orgId, provider: "fake_channel" },
      rawBody: JSON.stringify({ from: "5565999990101", text: "tô com dor no peito e tomo losartana 50mg", external_id: `prova-clinico-${Date.now()}` }),
      headers: new Headers(),
      secret: sessao.webhookPathToken,
    });
    afirmar(r.ok, `ingest falhou: ${JSON.stringify(r)}`);
    const [msg] = await q(
      `select body, metadata from public.messages where organization_id = $1 order by created_at desc limit 1`,
      [orgId],
    );
    afirmar(msg.body === MARCADOR_CLINICO, `body deveria ser o marcador, veio: ${msg.body}`);
    const varredura = await q(
      `select count(*)::int as n from public.messages where organization_id = $1 and (body ilike '%losartana%' or metadata::text ilike '%losartana%')`,
      [orgId],
    );
    afirmar(varredura[0].n === 0, "o termo clínico vazou para o banco");
    const [conv] = await q(`select bot_silenced_until from public.conversations where organization_id = $1 order by created_at desc limit 1`, [orgId]);
    afirmar(conv && conv.bot_silenced_until !== null, "a conversa não foi passada para humano");
  });

  // ── 3. O Agente lista, acha vaga e marca (handlers MCP in-process) ──
  const ctx = {
    organizationId: orgId,
    role: "manager" as const,
    actor: { type: "ai_agent" as const, id: "prova-agenda", role: "ai_operator" },
    apiTokenId: "prova",
    requestId: `prova-${Date.now()}`,
    supabase: admin,
  } as never;

  await passo("crm_list_event_types traz o preço cadastrado", async () => {
    const r = (await crmListEventTypes.handler({}, ctx)) as { tipos: { slug: string; preco_cents: number | null }[] };
    const t = r.tipos.find((x) => x.slug === SLUG_TIPO);
    afirmar(t, "o serviço da prova não apareceu na lista");
    afirmar(t.preco_cents === 20000, `preco_cents deveria ser 20000, veio ${t.preco_cents}`);
  });

  const horario = await passo("crm_find_free_slots devolve horário livre", async () => {
    const r = (await crmFindFreeSlots.handler({ event_type_slug: SLUG_TIPO, dias_a_frente: 7, limite: 5 }, ctx)) as {
      horarios: { inicio: string }[];
      publicou_horarios?: boolean;
    };
    afirmar(r.horarios && r.horarios.length > 0, `sem horários: ${JSON.stringify(r)}`);
    return r.horarios[0]!.inicio;
  });

  const agendamentoId = await passo("crm_book_appointment marca a consulta", async () => {
    const r = (await crmBookAppointment.handler({ event_type_slug: SLUG_TIPO, starts_at: horario, contact_id: contatoId }, ctx)) as {
      marcado: boolean;
      compromisso?: { id: string };
      motivo?: string;
      mensagem?: string;
    };
    afirmar(r.marcado && r.compromisso, `não marcou: ${r.motivo} ${r.mensagem}`);
    return r.compromisso.id;
  });

  await passo("o agendamento pede push ao Google (needs_google_push) e tem a conversa", async () => {
    const [a] = await q(`select needs_google_push, conversation_id, status from public.calendar_appointments where id = $1`, [agendamentoId]);
    afirmar(a.needs_google_push === true, `needs_google_push deveria ser true, veio ${a.needs_google_push}`);
    afirmar(a.conversation_id !== null, "conversation_id continua nulo");
  });

  // ── 4. A recepção marca compareceu com o valor pago (ADR-0017) ──
  await passo("PATCH compareceu com R$ 200 grava paid_cents (Venda Confirmada)", async () => {
    // O handler exige que o desfecho seja sobre o passado; em produção é o relógio.
    await q(`update public.calendar_appointments set starts_at = now() - interval '2 hours', ends_at = now() - interval '90 minutes' where id = $1`, [agendamentoId]);
    const r = await alterarAgendamentoHandler(admin as never, { organization_id: orgId, requestId: "prova-pago", actor: { type: "user", id: profissionalId } }, {
      id: agendamentoId,
      status: "completed",
      paid_cents: 20000,
    });
    afirmar(!("inalterado" in r), "PATCH devolveu inalterado");
    const [a] = await q(`select status, paid_cents, paid_currency from public.calendar_appointments where id = $1`, [agendamentoId]);
    afirmar(a.status === "completed" && Number(a.paid_cents) === 20000 && a.paid_currency === "BRL", `gravou ${JSON.stringify(a)}`);
    const [t] = await q(`select price_cents, margin_bps from public.calendar_event_types where id = $1`, [tipoId]);
    afirmar(Number(t.price_cents) === 20000 && Number(t.margin_bps) === 6000, "preço/margem do tipo não batem");
  });

  // ── 5. Lembrete de consulta ──
  await passo("lembrete 24h antes sai pelo canal e marca reminder_sent_at", async () => {
    limparCaixaFake();
    const r2 = (await crmBookAppointment.handler({ event_type_slug: SLUG_TIPO, starts_at: horario, contact_id: contatoId }, ctx)) as {
      marcado: boolean;
      compromisso?: { id: string; starts_at?: string };
      motivo?: string;
    };
    afirmar(r2.marcado && r2.compromisso, `não marcou o segundo: ${r2.motivo}`);
    const [a] = await q(`select starts_at from public.calendar_appointments where id = $1`, [r2.compromisso.id]);
    const agora = new Date(new Date(a.starts_at).getTime() - 23 * 60 * 60 * 1000);
    const res = await enviarLembretesDevidos(admin as never, { agora });
    afirmar(res.enviados >= 1, `nenhum lembrete enviado: ${JSON.stringify(res)}`);
    const [b] = await q(`select reminder_sent_at from public.calendar_appointments where id = $1`, [r2.compromisso.id]);
    afirmar(b.reminder_sent_at !== null, "reminder_sent_at continua nulo");
    const enviados = lerEnviados(orgId);
    afirmar(enviados.some((e) => e.kind === "message" && (e.envelope?.body ?? "").includes("Lembrete")), "o lembrete não saiu pela caixa fake");
  });

  // ── 6. Google Calendar (opcional) ──
  if (process.env.PROVA_GOOGLE === "1") {
    await passo("push ao Google Calendar conectado", async () => {
      const { NextRequest } = await import("next/server");
      const rota = await import("@/app/api/v1/cron/agenda-google-push/route");
      const segredo = process.env.INTERNAL_CRON_SECRET || process.env.INTERNAL_SECRET || "";
      const res = await rota.GET(new NextRequest("http://localhost/api/v1/cron/agenda-google-push", { headers: { authorization: `Bearer ${segredo}` } }));
      afirmar(res.status === 200, `cron respondeu ${res.status}`);
      const [a] = await q(`select google_event_id from public.calendar_appointments where id = $1`, [agendamentoId]);
      afirmar(a.google_event_id, "google_event_id continua nulo — a Conta tem Calendar conectado?");
    });
  } else {
    pular("push ao Google Calendar", "HITL — rode com PROVA_GOOGLE=1 numa Conta com Calendar conectado");
  }

  if (!MANTER) {
    await passo("limpeza da org de prova", async () => {
      await q(`delete from public.organizations where id = $1`, [orgId]);
    });
  }
  await pool.end();
  console.log("\nprova-agenda: VERDE");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
