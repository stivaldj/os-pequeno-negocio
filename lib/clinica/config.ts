/**
 * Configuração clínica da Conta — o bit que liga `lib/clinica/` por organização.
 *
 * Vive em `organizations.settings.clinica` (jsonb), ao lado das outras chaves de
 * settings (`lost_reasons_extra`, `ai_dispatch_mode`, `branding`...). Duas
 * funções, e só duas, porque quem grava (a Server Action do toggle) e quem lê
 * (os ingestores, antes do insert — ADR-0004) precisam concordar sobre o MESMO
 * caminho no jsonb; escrever o caminho em dois lugares é o jeito de eles
 * divergirem em silêncio.
 *
 * A leitura é estrita: só `true` literal liga. `"true"`, `1` e qualquer chave
 * fora do lugar valem desligado — o custo de um falso positivo é redigir a
 * conversa de uma Conta que não é de saúde; o de um falso negativo, em Conta de
 * saúde, é persistir Conteúdo Clínico. Nenhum dos dois é aceitável, mas o
 * primeiro é visível na tela e o segundo não, então a coerção fica de fora.
 */

export interface ConfiguracaoClinica {
  /** Redigir Conteúdo Clínico antes de gravar e passar a conversa a humano. */
  redacao: boolean;
}

const CHAVE = "clinica";
const CHAVE_REDACAO = "redacao_clinica";

function blocoClinico(settings: unknown): Record<string, unknown> | null {
  if (settings === null || typeof settings !== "object") return null;
  const bloco = (settings as Record<string, unknown>)[CHAVE];
  if (bloco === null || typeof bloco !== "object" || Array.isArray(bloco)) return null;
  return bloco as Record<string, unknown>;
}

/** Lê `settings.clinica.redacao_clinica === true`. Qualquer outra forma é desligado. */
export function configuracaoClinica(settings: unknown): ConfiguracaoClinica {
  const bloco = blocoClinico(settings);
  return { redacao: bloco?.[CHAVE_REDACAO] === true };
}

/**
 * Devolve um `settings` novo com o bloco clínico aplicado. Merge não destrutivo
 * nos dois níveis: preserva toda outra chave de `settings` e toda outra chave
 * de `settings.clinica` (fases seguintes gravam ali também). Não muta a entrada.
 */
export function aplicarConfiguracaoClinica(
  settings: Record<string, unknown> | null,
  patch: ConfiguracaoClinica,
): Record<string, unknown> {
  const atual = settings ?? {};
  const bloco = blocoClinico(atual) ?? {};
  return {
    ...atual,
    [CHAVE]: { ...bloco, [CHAVE_REDACAO]: patch.redacao },
  };
}
