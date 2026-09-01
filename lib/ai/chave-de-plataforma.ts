/**
 * A chave de plataforma do provedor — as mesmas variáveis que
 * `llmEdgeConfigFromEnv` (lib/agent-engine/edge/llm/credentials.ts) lê no turno
 * de produção. Google não tem: o runtime real também não tem ramo de fallback
 * para ele, e prometer aqui um caminho que lá não existe faria o onboarding
 * passar e a mensagem real falhar.
 *
 * Morava em `lib/ai/runtime/agent.ts`; saiu de lá quando o fork aposentou o
 * motor antigo — um lookup de env não pertence a motor nenhum.
 */
export function chaveDePlataforma(provider: string): string | null {
  const nome = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" }[
    provider
  ];
  if (!nome) return null;
  const v = (process.env[nome] ?? "").trim();
  return v === "" ? null : v;
}
