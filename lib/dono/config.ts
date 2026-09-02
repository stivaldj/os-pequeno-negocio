/**
 * Configuração do Dono da Conta — o número no qual o produto fala com ele.
 *
 * Vive em `organizations.settings.dono` (jsonb), ao lado das outras chaves de
 * settings (`clinica`, `lost_reasons_extra`, `branding`...). Duas funções, e só
 * duas, pelo mesmo motivo de `lib/clinica/config.ts`: quem grava (a Server
 * Action da Conta) e quem lê (`lib/dono/destinatario.ts`, os vigias, o Agente
 * de Anúncios) precisam concordar sobre o MESMO caminho no jsonb.
 *
 * A leitura é estrita: só string em E.164 vale. Número com máscara, sem `+`
 * ou de tipo errado é "não configurado" — melhor o aviso não sair (e o motivo
 * `sem_whatsapp_do_dono` ficar no log) do que o produto criar um contato com
 * telefone que o CHECK `contacts_phone_e164_format` recusaria.
 */

export interface ConfiguracaoDoDono {
  /** WhatsApp do Dono em E.164 (`+5511999999999`); `null` desliga o destinatário. */
  whatsapp: string | null;
}

const CHAVE = "dono";
const CHAVE_WHATSAPP = "whatsapp";

/** E.164: `+`, primeiro dígito 1–9, 8 a 15 dígitos no total. */
const E164 = /^\+[1-9]\d{7,14}$/;

export function ehWhatsappValido(valor: string): boolean {
  return E164.test(valor);
}

function blocoDoDono(settings: unknown): Record<string, unknown> | null {
  if (settings === null || typeof settings !== "object") return null;
  const bloco = (settings as Record<string, unknown>)[CHAVE];
  if (bloco === null || typeof bloco !== "object" || Array.isArray(bloco)) return null;
  return bloco as Record<string, unknown>;
}

/** Lê `settings.dono.whatsapp` quando é E.164. Qualquer outra forma é `null`. */
export function whatsappDoDono(settings: unknown): string | null {
  const valor = blocoDoDono(settings)?.[CHAVE_WHATSAPP];
  return typeof valor === "string" && ehWhatsappValido(valor) ? valor : null;
}

/**
 * Devolve um `settings` novo com o bloco do Dono aplicado. Merge não destrutivo
 * nos dois níveis: preserva toda outra chave de `settings` e toda outra chave
 * de `settings.dono` (fases seguintes gravam ali também). Não muta a entrada.
 */
export function aplicarConfiguracaoDoDono(
  settings: Record<string, unknown> | null,
  patch: ConfiguracaoDoDono,
): Record<string, unknown> {
  const atual = settings ?? {};
  const bloco = blocoDoDono(atual) ?? {};
  return {
    ...atual,
    [CHAVE]: { ...bloco, [CHAVE_WHATSAPP]: patch.whatsapp },
  };
}
