import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ROTINAS_ESPERADAS } from "./esperadas";

/**
 * `ROTINAS_ESPERADAS` é o que o vigia usa para saber o que DEVERIA ter rodado.
 * Uma lista mantida à mão diverge do crontab no primeiro cron novo — e o vigia
 * passaria a vigiar uma rotina que não existe, ou a ignorar uma que existe.
 * Este teste deriva a lista do crontab real (`docker/scheduler/entrypoint.sh`,
 * a mesma fonte que `tests/unit/cron-routes-scheduled.test.ts` lê) e exige
 * igualdade exata: nomes e período.
 */

const ENTRYPOINT = join(process.cwd(), "docker", "scheduler", "entrypoint.sh");

/** `* * * * *` = 1, `*\/5 * * * *` = 5, `17 * * * *` = 60, `0 12 * * *` = 1440. */
function periodoDaExpressao(expr: string): number {
  const [minuto = "", hora = ""] = expr.trim().split(/\s+/);
  if (minuto === "*") return 1;
  const passo = minuto.match(/^\*\/(\d+)$/);
  if (passo) return Number(passo[1]);
  if (/^\d+$/.test(minuto)) return hora === "*" ? 60 : 1440;
  throw new Error(`expressão de cron que este teste não sabe ler: "${expr}"`);
}

function rotinasDoCrontab(): { nome: string; periodoMinutos: number }[] {
  const sh = readFileSync(ENTRYPOINT, "utf8");
  const linhas = [...sh.matchAll(/^([^#\n|]+)\|(\d+)\|api\/v1\/cron\/([a-z0-9-]+)(?:\?[^\n]*)?$/gm)];
  return linhas
    .map((m) => ({ nome: m[3]!, periodoMinutos: periodoDaExpressao(m[1]!) }))
    .sort((a, b) => a.nome.localeCompare(b.nome));
}

describe("ROTINAS_ESPERADAS × crontab do scheduler", () => {
  it("o instrumento lê o crontab (guarda de vacuidade)", () => {
    const doCrontab = rotinasDoCrontab();
    expect(doCrontab.length).toBeGreaterThan(15);
    // Uma amostra de cada forma de expressão, para provar que a derivação lê certo.
    expect(doCrontab.find((r) => r.nome === "event-log-drain")?.periodoMinutos).toBe(1);
    expect(doCrontab.find((r) => r.nome === "storage-redaction")?.periodoMinutos).toBe(5);
    expect(doCrontab.find((r) => r.nome === "contact-proposals-watcher")?.periodoMinutos).toBe(60);
    expect(doCrontab.find((r) => r.nome === "lgpd-sla-watcher")?.periodoMinutos).toBe(1440);
  });

  it("a lista tem exatamente as rotinas do crontab, com o período derivado da expressão", () => {
    const esperadas = [...ROTINAS_ESPERADAS]
      .map((r) => ({ nome: r.nome, periodoMinutos: r.periodoMinutos }))
      .sort((a, b) => a.nome.localeCompare(b.nome));
    expect(esperadas).toEqual(rotinasDoCrontab());
  });

  it("o vigia vigia a si mesmo", () => {
    expect(ROTINAS_ESPERADAS.some((r) => r.nome === "rotinas-vigia")).toBe(true);
  });
});
