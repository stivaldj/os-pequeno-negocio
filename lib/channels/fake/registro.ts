/**
 * O `fake_channel` só existe fora de produção. A decisão mora aqui, pura, para
 * ser testada sem reimportar o registry — que arrasta `lib/env.ts` e, em modo
 * produção, exige o `.env` inteiro.
 */
export function fakeChannelDisponivel(nodeEnv: string | undefined = process.env["NODE_ENV"]): boolean {
  return nodeEnv !== "production";
}
