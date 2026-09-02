/**
 * O Código de Clique (ADR-0016): nasce na Página de Captura, viaja na frase
 * pré-preenchida do WhatsApp e é lido da PRIMEIRA mensagem do Contato. O
 * extrator tem de ser tolerante ao que a pessoa faz com a frase — apagar o
 * parêntese, trocar caixa, pôr dois-pontos — e intolerante a seis letras
 * soltas sem `ref`, que é o que evita casar com uma palavra qualquer.
 */
import { describe, expect, it } from "vitest";
import { ALFABETO_DO_CODIGO, extrairCodigoDeClique, frasePreenchida, gerarCodigoDeClique } from "@/lib/ads/codigo";

describe("gerarCodigoDeClique", () => {
  it("6 caracteres, só do alfabeto sem 0/O/1/I", () => {
    for (let i = 0; i < 200; i++) {
      const c = gerarCodigoDeClique();
      expect(c).toHaveLength(6);
      for (const ch of c) expect(ALFABETO_DO_CODIGO).toContain(ch);
    }
    expect(ALFABETO_DO_CODIGO).not.toMatch(/[0O1I]/);
  });

  it("não repete em 500 sorteios (é aleatório de verdade)", () => {
    const vistos = new Set(Array.from({ length: 500 }, () => gerarCodigoDeClique()));
    expect(vistos.size).toBeGreaterThan(490);
  });
});

describe("frasePreenchida", () => {
  it("anexa o código no formato que o extrator lê", () => {
    const frase = frasePreenchida("Olá, quero marcar uma consulta", "X7K3MQ");
    expect(frase).toBe("Olá, quero marcar uma consulta (ref X7K3MQ)");
    expect(extrairCodigoDeClique(frase)).toBe("X7K3MQ");
  });
});

describe("extrairCodigoDeClique", () => {
  it.each([
    ["Olá, quero marcar uma consulta (ref X7K3MQ)", "X7K3MQ"],
    ["REF: x7k3mq", "X7K3MQ"],
    ["ref-X7K3MQ", "X7K3MQ"],
    ["ref#X7K3MQ oi", "X7K3MQ"],
    ["Réf X7K3MQ", "X7K3MQ"],
  ])("%s → %s", (texto, esperado) => {
    expect(extrairCodigoDeClique(texto)).toBe(esperado);
  });

  it("texto sem `ref` devolve null, mesmo com seis letras soltas", () => {
    expect(extrairCodigoDeClique("quero marcar com a cardiologista")).toBeNull();
    expect(extrairCodigoDeClique("X7K3MQ")).toBeNull();
    expect(extrairCodigoDeClique("prefX7K3MQ")).toBeNull();
    expect(extrairCodigoDeClique("")).toBeNull();
    expect(extrairCodigoDeClique(null)).toBeNull();
    expect(extrairCodigoDeClique(undefined)).toBeNull();
  });

  it("código colado a mais caracteres não casa (não é o código)", () => {
    expect(extrairCodigoDeClique("ref X7K3MQZZ")).toBeNull();
  });

  it("texto clínico com o código extrai o código — o código não é Conteúdo Clínico", () => {
    expect(extrairCodigoDeClique("tomo losartana e tô com dor no peito (ref X7K3MQ)")).toBe("X7K3MQ");
  });
});
