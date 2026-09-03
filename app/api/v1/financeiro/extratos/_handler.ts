/**
 * A REGRA de importar um extrato OFX — fora da rota, de propósito.
 *
 * ⚠️ A PROVA DE REALIDADE NÃO CHAMA ROTA NEXT. `tests/prova/financeiro.prova.ts`
 * roda em vitest, onde `requireRole` → `loadAuthUser` → `cookies()` de
 * `next/headers` não existe: uma prova que batesse na rota morreria com 401 na
 * primeira asserção. É o mesmo motivo pelo qual a agenda extraiu
 * `app/api/v1/agenda/agendamentos/_handler.ts` — a regra mora aqui, e a ROTA e
 * a PROVA chamam a mesma função. Por isso este arquivo não importa
 * `next/headers`, nem `require-role`, nem cookie nenhum.
 *
 * ⚠️ A ORGANIZAÇÃO ENTRA POR PARÂMETRO (`ctx.organizationId`), nunca resolvida
 * aqui. A rota tira do gate de autenticação; a prova semeia a sua. O corpo da
 * requisição nunca é fonte: o client é service role e bypassa RLS.
 *
 * Este handler NÃO audita. `importarExtrato` já emite
 * `financeiro.extrato_importado` por dentro — é lá que um arquivo vira linha, e
 * a trilha tem de valer também para a prova, que não passa por HTTP. Auditar
 * aqui de novo escreveria duas linhas para o mesmo fato.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { fail, ok } from "@/lib/api/wrappers";
import { importarExtrato } from "@/lib/financeiro/importar";
import { lerCabecalho } from "@/lib/financeiro/ofx";
import { OFX_MAX_BYTES } from "@/lib/financeiro/ofx/tipos";

export interface ContextoDaImportacao {
  /** Resolvido pelo chamador a partir de fonte confiável. NUNCA do body. */
  organizationId: string;
  /** Correlaciona resposta, audit e log. */
  requestId?: string;
  /** Quem subiu o arquivo, quando a origem é a tela. */
  actorUserId?: string | null;
}

/** Tipos que navegador e site de banco põem num `.ofx`. */
const TIPOS_ACEITOS = new Set(["text/plain", "application/x-ofx", "application/octet-stream"]);

const MB = (n: number): string => (n / 1024 / 1024).toFixed(1).replace(".", ",");

export async function importarExtratoHandler(
  admin: SupabaseClient,
  ctx: ContextoDaImportacao,
  file: File,
): Promise<Response> {
  const { organizationId, requestId } = ctx;

  // ─── Borda 1: parece um extrato OFX? ──────────────────────────────────────
  //
  // Extensão OU tipo, e não os dois: o navegador manda `application/octet-stream`
  // para `.ofx` (não há tipo registrado no IANA), e o banco que serve o arquivo
  // como `text/plain` às vezes o nomeia sem a extensão. Exigir os dois recusaria
  // arquivo bom; aceitar qualquer um deixa a recusa de CONTEÚDO (borda 3) fazer
  // o trabalho de verdade — nome de arquivo não é prova de nada.
  const nome = file.name ?? "";
  const tipoOk = nome.toLowerCase().endsWith(".ofx") || TIPOS_ACEITOS.has(file.type);
  if (!tipoOk) {
    return fail(
      "validation_failed",
      "Formato não suportado — envie um arquivo .ofx. No site do banco procure " +
        "'Exportar extrato' e escolha OFX (aparece também como Money ou Quicken); " +
        "PDF e planilha não servem.",
      422,
      { requestId },
    );
  }

  // ─── Borda 2: cabe? ───────────────────────────────────────────────────────
  //
  // Antes de ler os bytes, e com 413 em vez de 422: o arquivo não está errado,
  // está grande. O teto é o mesmo `OFX_MAX_BYTES` que o parser cobra — a fonte é
  // uma só, importada de `lib/financeiro/ofx/tipos.ts`.
  if (file.size > OFX_MAX_BYTES) {
    return fail(
      "payload_too_large",
      `Arquivo de ${MB(file.size)} MB excede o teto de ${MB(OFX_MAX_BYTES)} MB — ` +
        "exporte um período menor no site do banco (um mês por vez) e importe em partes.",
      413,
      { requestId },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // ─── Borda 3: o conteúdo é legível? ───────────────────────────────────────
  //
  // `lerCabecalho` é a recusa de borda declarada do parser (o comentário dele
  // diz isso): lança quando não há `<OFX>`, com a mensagem que ensina a exportar
  // do banco. Chamá-lo AQUI, em vez de deixar `importarExtrato` lançar, é o que
  // separa "seu arquivo não serve" (422) de "o Postgres caiu" (500) — sem essa
  // separação uma indisponibilidade do banco sairia para o Dono como se o
  // extrato dele estivesse corrompido, e ele passaria a tarde reexportando um
  // arquivo que estava certo. O custo é decodificar o cabeçalho duas vezes, que
  // num extrato é ruído.
  try {
    lerCabecalho(buffer);
  } catch (err) {
    return fail("validation_failed", `Não deu para ler o arquivo: ${(err as Error).message}`, 422, {
      requestId,
    });
  }

  const resumo = await importarExtrato(admin, {
    organizationId,
    buffer,
    nomeDoArquivo: nome,
    requestId: requestId ?? null,
    actorUserId: ctx.actorUserId ?? null,
  });

  return ok(resumo, { requestId });
}
