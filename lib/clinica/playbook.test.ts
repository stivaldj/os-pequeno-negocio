import { describe, expect, it } from "vitest";

import {
  MAX_PLAYBOOK_LAYER_LINES,
  validatePlaybookLayerContent,
} from "@/lib/agent-engine/agent/playbook";

import { PLAYBOOK_DA_CLINICA } from "./playbook";

/**
 * O playbook da clínica é CONTEÚDO: entra na camada `tenant` (ou no
 * system_prompt da versão publicada do agente, que a substitui). O motor só
 * valida a forma; o que este teste prende é o que as ADRs 0012 e 0013 mandam
 * o Agente dizer e não dizer.
 */
describe("PLAYBOOK_DA_CLINICA", () => {
  it("passa na validação de forma da camada (≤200 linhas, seções ## ...)", () => {
    expect(() => validatePlaybookLayerContent(PLAYBOOK_DA_CLINICA)).not.toThrow();
    expect(PLAYBOOK_DA_CLINICA.split("\n").length).toBeLessThanOrEqual(MAX_PLAYBOOK_LAYER_LINES);
  });

  it("tem as seções que o plano pede", () => {
    for (const secao of [
      "## Quem é você",
      "## O que você faz",
      "## O que você não faz",
      "## Quando parar e chamar a equipe",
      "## Fora do expediente",
      "## Vocabulário",
    ]) {
      expect(PLAYBOOK_DA_CLINICA).toContain(secao);
    }
  });

  it("se declara assistente virtual com inteligência artificial (CFM 2.454/2026)", () => {
    expect(PLAYBOOK_DA_CLINICA).toMatch(/assistente virtual/i);
    expect(PLAYBOOK_DA_CLINICA).toMatch(/inteligência artificial/i);
  });

  it("não faz triagem: sintoma, remédio e gravidade são da equipe (ADR-0012)", () => {
    expect(PLAYBOOK_DA_CLINICA).toMatch(/não avalia sintoma/i);
    expect(PLAYBOOK_DA_CLINICA).toMatch(/não indica (remédio|medicamento)/i);
    expect(PLAYBOOK_DA_CLINICA).toMatch(/não diz se é grave/i);
    expect(PLAYBOOK_DA_CLINICA).toContain("isso quem responde é a equipe");
  });

  it("escolher serviço ou profissional não é conteúdo clínico — segue agendando (ADR-0012)", () => {
    expect(PLAYBOOK_DA_CLINICA).toMatch(/escolher (um )?serviço/i);
    expect(PLAYBOOK_DA_CLINICA).toMatch(/não é (conteúdo|informação) clínic/i);
  });

  it("fora do expediente avisa que está fechada e segue agendando (ADR-0013)", () => {
    expect(PLAYBOOK_DA_CLINICA).toMatch(/clínica está fechada/i);
    expect(PLAYBOOK_DA_CLINICA).toMatch(/continue? (atendendo|agendando)/i);
    expect(PLAYBOOK_DA_CLINICA).not.toMatch(/fora do expediente[^\n]*chame (a equipe|um humano)/i);
  });

  it("nomeia os gatilhos de passagem e a ferramenta que os executa", () => {
    expect(PLAYBOOK_DA_CLINICA).toContain("request_human_handoff");
    for (const gatilho of ["pedido de humano", "reclamação", "desconto", "dúvida clínica"]) {
      expect(PLAYBOOK_DA_CLINICA.toLowerCase()).toContain(gatilho);
    }
  });

  it("agenda pelas ferramentas de agenda e confirma no SIM ao lembrete", () => {
    for (const tool of [
      "crm_list_event_types",
      "crm_find_free_slots",
      "crm_book_appointment",
      "crm_reschedule_appointment",
      "crm_cancel_appointment",
      "crm_confirm_appointment",
    ]) {
      expect(PLAYBOOK_DA_CLINICA).toContain(tool);
    }
    expect(PLAYBOOK_DA_CLINICA).toMatch(/SIM/);
  });

  it("não promete resultado nem dá desconto fora da tabela; preço só o cadastrado", () => {
    expect(PLAYBOOK_DA_CLINICA).toMatch(/não promet[ae] resultado/i);
    expect(PLAYBOOK_DA_CLINICA).toMatch(/desconto/i);
    expect(PLAYBOOK_DA_CLINICA).toMatch(/preço[^\n]*cadastrad/i);
  });

  it("usa o vocabulário da clínica: Paciente e Agendado", () => {
    const vocabulario = PLAYBOOK_DA_CLINICA.slice(PLAYBOOK_DA_CLINICA.indexOf("## Vocabulário"));
    expect(vocabulario).toContain("Paciente");
    expect(vocabulario).toContain("Agendado");
  });
});
