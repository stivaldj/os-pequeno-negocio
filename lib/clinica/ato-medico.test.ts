import { describe, expect, it } from "vitest";

import { pareceAtoMedico } from "./ato-medico";

/**
 * "Não é ato médico" (ADR-0012): o Agente marca consulta, não prescreve, não
 * diagnostica e não orienta tratamento. Esta função é o olho do vigia que lê
 * as respostas dele em observação — falso positivo custa um aviso na Central;
 * falso negativo custa o que o CFM chama de exercício ilegal.
 */

describe("pareceAtoMedico — o que É ato médico", () => {
  it.each([
    ["você deve tomar 1 comprimido de 8 em 8 horas", "prescricao"],
    ["tome 50mg de losartana pela manhã", "prescricao"],
    ["use 20 gotas de dipirona se a dor voltar", "prescricao"],
  ] as const)("prescrição: %s", (texto, motivo) => {
    expect(pareceAtoMedico(texto)).toEqual({ parece: true, motivo });
  });

  it.each([
    ["isso parece uma infecção", "diagnostico"],
    ["pode ser gastrite", "diagnostico"],
    ["pelo que você descreve, você tem sinusite", "diagnostico"],
    ["deve ser labirintite, é comum nessa idade", "diagnostico"],
  ] as const)("diagnóstico: %s", (texto, motivo) => {
    expect(pareceAtoMedico(texto)).toEqual({ parece: true, motivo });
  });

  it.each([
    ["aumenta a dose", "orientacao"],
    ["pode suspender o remédio por enquanto", "orientacao"],
    ["reduza a metformina pela metade", "orientacao"],
    ["pare de tomar o antibiótico", "orientacao"],
  ] as const)("orientação terapêutica: %s", (texto, motivo) => {
    expect(pareceAtoMedico(texto)).toEqual({ parece: true, motivo });
  });

  it("ignora acento e caixa", () => {
    expect(pareceAtoMedico("Isso PARECE uma Infecção").parece).toBe(true);
  });
});

describe("pareceAtoMedico — atendimento normal NÃO é ato médico", () => {
  it.each([
    "a consulta com o cardiologista é às 14h",
    "traga seus exames",
    "o valor da consulta é R$ 200",
    "posso agendar para quinta às 9h?",
    "a doutora atende das 8h às 12h",
    "confirmo seu horário",
    "o endereço é Av. Brigadeiro Eduardo Gomes, 508",
    "aceitamos Unimed",
    "traga seus exames anteriores",
    "importante: este atendimento usa inteligência artificial",
  ])("%s", (texto) => {
    expect(pareceAtoMedico(texto)).toEqual({ parece: false, motivo: null });
  });

  it("vazio e nulo", () => {
    expect(pareceAtoMedico(null)).toEqual({ parece: false, motivo: null });
    expect(pareceAtoMedico("")).toEqual({ parece: false, motivo: null });
    expect(pareceAtoMedico("   ")).toEqual({ parece: false, motivo: null });
  });

  it("verbo de uso sem medicação nem dose não basta (ecoar o Contato não é prescrever)", () => {
    expect(pareceAtoMedico("pode tomar água antes do exame").parece).toBe(false);
    expect(pareceAtoMedico("aumente o zoom para ver o mapa").parece).toBe(false);
  });
});
