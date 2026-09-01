import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O botão de Embedded Signup na tela do canal oficial.
 *
 * ─── O que estes casos protegem ─────────────────────────────────────────────
 *
 * O Embedded Signup é OPCIONAL por instalação (ADR-0015): só existe quando o
 * servidor tem app da Meta configurado. Sem isso a tela não pode nem sugerir o
 * caminho — o botão abriria um popup que falha em silêncio. E com ele, o
 * formulário manual continua embaixo: é a saída de quem já tem token na mão.
 *
 * O terceiro caso prova o encaixe das duas metades do fluxo da Meta: o `code`
 * vem no callback do `FB.login`, os ids vêm por `postMessage` do popup. Só com
 * os três a rota é chamada — e é chamada com os três.
 */

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...a: unknown[]) => getMock(...a),
    post: (...a: unknown[]) => postMock(...a),
  },
}));
const toastOk = vi.fn();
const toastErro = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (m: string) => toastOk(m), error: (m: string) => toastErro(m) },
}));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn(async () => true) }));

import { CanalOficialClient } from "@/components/connections/CanalOficialClient";

const base = {
  connected: false,
  hasToken: false,
  phoneNumberId: null,
  wabaId: null,
  displayName: null,
  phoneNumber: null,
  status: null,
  webhook: null,
};

const semSignup = {
  data: { ...base, embeddedSignup: { available: false, appId: null, configId: null } },
};

const comSignup = {
  data: { ...base, embeddedSignup: { available: true, appId: "app1", configId: "cfg1" } },
};

function renderTela() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CanalOficialClient />
    </QueryClientProvider>,
  );
}

const BOTAO = /entrar com a conta da meta/i;

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  toastOk.mockReset();
  toastErro.mockReset();
});

afterEach(() => {
  delete (window as unknown as { FB?: unknown }).FB;
});

describe("instalação SEM app da Meta", () => {
  it("não mostra o botão — e o formulário manual está lá", async () => {
    getMock.mockResolvedValue(semSignup);
    renderTela();
    expect(await screen.findByLabelText(/ID do número de telefone/)).toBeInTheDocument();
    expect(screen.queryByText("Conectar pelo WhatsApp Business")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: BOTAO })).not.toBeInTheDocument();
  });
});

describe("instalação COM app da Meta", () => {
  it("mostra o botão ANTES do formulário manual, que continua acessível", async () => {
    getMock.mockResolvedValue(comSignup);
    renderTela();
    expect(await screen.findByText("Conectar pelo WhatsApp Business")).toBeInTheDocument();
    const botao = screen.getByRole("button", { name: BOTAO });
    const campoManual = screen.getByLabelText(/ID do número de telefone/);
    expect(campoManual).toBeInTheDocument();
    // Ordem no DOM: o caminho guiado vem primeiro; o manual é a alternativa.
    expect(botao.compareDocumentPosition(campoManual) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("code do FB.login + ids do postMessage → chama a rota com os três", async () => {
    getMock.mockResolvedValue(comSignup);
    postMock.mockResolvedValue({
      data: { connected: true, coexistence: true, displayName: "Clínica", phoneNumber: "+5511" },
    });
    const login = vi.fn((cb: (r: { authResponse?: { code?: string } }) => void, _opts?: unknown) =>
      cb({ authResponse: { code: "c1" } }),
    );
    (window as unknown as { FB: unknown }).FB = { init: vi.fn(), login };

    renderTela();
    fireEvent.click(await screen.findByRole("button", { name: BOTAO }));

    // O popup manda os ids por postMessage, com origem da Meta.
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://www.facebook.com",
        data: JSON.stringify({
          type: "WA_EMBEDDED_SIGNUP",
          event: "FINISH",
          data: { waba_id: "waba9", phone_number_id: "pn9" },
        }),
      }),
    );

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/v1/channels/official/embedded-signup", {
        code: "c1",
        waba_id: "waba9",
        phone_number_id: "pn9",
      }),
    );
    expect(login).toHaveBeenCalledTimes(1);
    expect(login.mock.calls[0]?.[1]).toMatchObject({ config_id: "cfg1", response_type: "code" });
    await waitFor(() => expect(toastOk).toHaveBeenCalled());
  });

  it("mensagem de origem que não é a Meta é ignorada", async () => {
    getMock.mockResolvedValue(comSignup);
    const login = vi.fn((cb: (r: { authResponse?: { code?: string } }) => void, _opts?: unknown) =>
      cb({ authResponse: { code: "c1" } }),
    );
    (window as unknown as { FB: unknown }).FB = { init: vi.fn(), login };

    renderTela();
    fireEvent.click(await screen.findByRole("button", { name: BOTAO }));
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://evil.example",
        data: JSON.stringify({
          type: "WA_EMBEDDED_SIGNUP",
          event: "FINISH",
          data: { waba_id: "x", phone_number_id: "y" },
        }),
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(postMock).not.toHaveBeenCalled();
  });

  it("CANCEL vira aviso e nada é enviado", async () => {
    getMock.mockResolvedValue(comSignup);
    const login = vi.fn((cb: (r: { authResponse?: { code?: string } }) => void, _opts?: unknown) => cb({}));
    (window as unknown as { FB: unknown }).FB = { init: vi.fn(), login };

    renderTela();
    fireEvent.click(await screen.findByRole("button", { name: BOTAO }));
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://www.facebook.com",
        data: JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: {} }),
      }),
    );
    await waitFor(() => expect(toastErro).toHaveBeenCalled());
    // O stub DESTE caso é o invocado — o SDK dublado não fica preso ao do caso anterior.
    expect(login).toHaveBeenCalledTimes(1);
    expect(toastErro).toHaveBeenCalledTimes(1);
    expect(postMock).not.toHaveBeenCalled();
  });
});
