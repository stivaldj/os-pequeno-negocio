/**
 * O endereço público de um link de captura (ADR-0016).
 *
 * O slug sai do NOME da campanha — é o que o Dono reconhece quando lê a URL
 * no painel do Google — mais quatro caracteres aleatórios, porque o slug é
 * único no mundo (não só na org): duas clínicas com a campanha "Consulta" não
 * podem brigar pelo mesmo `/ir/consulta`. Obedece ao CHECK da tabela:
 * `^[a-z0-9][a-z0-9-]{2,60}$`.
 */
import { randomInt } from "node:crypto";

import { env } from "@/lib/env";

const ALFABETO = "abcdefghijklmnopqrstuvwxyz0123456789";

export function sufixoAleatorio(tamanho = 4): string {
  let s = "";
  for (let i = 0; i < tamanho; i++) s += ALFABETO[randomInt(ALFABETO.length)];
  return s;
}

export function slugDeCaptura(campaignName: string, sufixo: string = sufixoAleatorio()): string {
  const base =
    campaignName
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "campanha";
  return `${base}-${sufixo}`;
}

export function urlDeCaptura(slug: string): string {
  return `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/ir/${slug}`;
}
