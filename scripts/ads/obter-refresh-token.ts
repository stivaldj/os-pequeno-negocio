/**
 * Obtém UMA VEZ o refresh token do Google Ads para a instalação (HITL da Fase 5).
 *
 *   GOOGLE_ADS_OAUTH_CLIENT_ID=… GOOGLE_ADS_OAUTH_CLIENT_SECRET=… pnpm tsx scripts/ads/obter-refresh-token.ts
 *
 * Fluxo "installed app" com loopback + PKCE, escopo `adwords`, `access_type=offline`
 * e `prompt=consent`. Faça login com o usuário do MCC. O consent screen do app
 * precisa estar PUBLICADO: em "Testing" o refresh token morre em 7 dias.
 * Cole o valor impresso em `GOOGLE_ADS_REFRESH_TOKEN`.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const clientId = process.env.GOOGLE_ADS_OAUTH_CLIENT_ID ?? "";
const clientSecret = process.env.GOOGLE_ADS_OAUTH_CLIENT_SECRET ?? "";
if (!clientId || !clientSecret) {
  console.error("uso: GOOGLE_ADS_OAUTH_CLIENT_ID=… GOOGLE_ADS_OAUTH_CLIENT_SECRET=… pnpm tsx scripts/ads/obter-refresh-token.ts");
  process.exit(2);
}

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("sem code");
    return;
  }
  const port = (server.address() as { port: number }).port;
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: `http://127.0.0.1:${port}`,
    grant_type: "authorization_code",
    code_verifier: verifier,
  });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  const json = (await r.json()) as { refresh_token?: string; error?: string; error_description?: string };
  if (!json.refresh_token) {
    res.writeHead(500).end("sem refresh_token — veja o terminal");
    console.error("falhou:", json.error, json.error_description);
    server.close();
    process.exit(1);
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Pronto. Volte ao terminal.");
  console.log("\nGOOGLE_ADS_REFRESH_TOKEN=" + json.refresh_token + "\n");
  server.close();
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `http://127.0.0.1:${port}`,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/adwords",
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  console.log("Abra no navegador, logado com o usuário do MCC:\n\n" + auth.toString() + "\n");
});
