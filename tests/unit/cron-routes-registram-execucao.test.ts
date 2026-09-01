import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * TODA ROTA DE CRON REGISTRA A PRÓPRIA EXECUÇÃO.
 *
 * `job_runs` só vale se TODA rotina escreve nela — o vigia (`lib/rotinas/vigia.ts`)
 * lê a última linha de cada rotina de `ROTINAS_ESPERADAS`, e uma rota que
 * existe, está no crontab e roda, mas não passa por `comExecucaoDeRotina`,
 * aparece para o vigia como "nunca rodou" e vira alerta falso de hora em hora.
 * O contrário é pior: se o vigia a ignorasse, a rota poderia morrer em silêncio,
 * que é exatamente o defeito que a Fase 2 existe para acabar.
 *
 * Cerca mecânica, como `cron-routes-scheduled.test.ts`: lê o diretório (fonte
 * da verdade do que existe) e exige o embrulho em cada `route.ts`. Rota nova
 * sem ele reprova no CI, não seis meses depois por um alerta falso.
 */

const RAIZ = join(__dirname, "..", "..");
const DIR_CRON = join(RAIZ, "app", "api", "v1", "cron");

function rotasDeCron(): string[] {
  return readdirSync(DIR_CRON, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

describe("rotas de cron × registro de execução em job_runs", () => {
  it("o instrumento enxerga as rotas (controle positivo)", () => {
    expect(rotasDeCron().length).toBeGreaterThan(10);
  });

  it.each(rotasDeCron())("%s exporta GET embrulhado em comExecucaoDeRotina", (rota) => {
    const fonte = readFileSync(join(DIR_CRON, rota, "route.ts"), "utf8");
    expect(
      fonte,
      `app/api/v1/cron/${rota}/route.ts não passa por comExecucaoDeRotina(: a rota roda e ` +
        `job_runs não fica sabendo — o vigia a trata como "nunca rodou".`,
    ).toContain("comExecucaoDeRotina(");
    // O nome registrado é o do diretório — é por ele que o vigia procura.
    expect(fonte).toContain(`comExecucaoDeRotina("${rota}"`);
    // E é o GET que sai embrulhado, não uma função interna qualquer.
    expect(fonte).toMatch(new RegExp(`export const GET = comExecucaoDeRotina\\("${rota}"`));
  });
});
