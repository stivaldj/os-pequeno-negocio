"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useConnectOfficialChannelByEmbeddedSignup } from "@/hooks/channels/useOfficialChannel";
import { useT } from "@/hooks/i18n/useT";
import {
  META_SDK_URL,
  META_SDK_VERSION,
  lerEventoEmbeddedSignup,
  type FbSdk,
} from "@/lib/channels/meta/coexistencia/sdk";

declare global {
  interface Window {
    FB?: FbSdk;
    fbAsyncInit?: () => void;
  }
}

/**
 * O SDK entra na página UMA vez. A promessa em módulo é só do SCRIPT: dois
 * botões (ou dois cliques) esperam a mesma injeção em vez de repeti-la. Se
 * `window.FB` já existe (outro script da Meta na página, ou o teste que o
 * dubla), não injeta nada — só inicializa aquela instância, uma vez.
 */
let carregando: Promise<FbSdk> | null = null;
const inicializados = new WeakSet<FbSdk>();
function pronto(fb: FbSdk, appId: string): FbSdk {
  if (!inicializados.has(fb)) {
    fb.init({ appId, version: META_SDK_VERSION, xfbml: false, cookie: false });
    inicializados.add(fb);
  }
  return fb;
}
function carregarSdk(appId: string): Promise<FbSdk> {
  if (window.FB) return Promise.resolve(pronto(window.FB, appId));
  if (carregando) return carregando;
  carregando = new Promise<FbSdk>((resolve, reject) => {
    window.fbAsyncInit = () => {
      if (window.FB) resolve(pronto(window.FB, appId));
      else reject(new Error("sdk_sem_fb"));
    };
    const script = document.createElement("script");
    script.src = META_SDK_URL;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => {
      carregando = null;
      reject(new Error("sdk_nao_carregou"));
    };
    document.head.appendChild(script);
  });
  return carregando;
}

/**
 * Botão do Embedded Signup da Meta (Coexistência, ADR-0015).
 *
 * O fluxo chega em DUAS metades, por canais diferentes e em ordem que a Meta
 * não garante: o `code` vem no callback do `FB.login`; `waba_id` e
 * `phone_number_id` vêm por `postMessage` do popup. Só com as três a rota é
 * chamada, uma vez. O servidor troca o `code` por token — a tela nunca vê
 * segredo nenhum.
 */
export function EmbeddedSignupButton({ appId, configId }: { appId: string; configId: string }) {
  const t = useT();
  const conectar = useConnectOfficialChannelByEmbeddedSignup();
  const { mutate } = conectar;

  const code = useRef<string | null>(null);
  const ids = useRef<{ waba_id: string; phone_number_id: string } | null>(null);
  const emAndamento = useRef(false);
  const [aguardando, setAguardando] = useState(false);

  const encerrar = useCallback(() => {
    code.current = null;
    ids.current = null;
    emAndamento.current = false;
    setAguardando(false);
  }, []);

  const concluirSePronto = useCallback(() => {
    if (!code.current || !ids.current) return;
    const input = { code: code.current, ...ids.current };
    encerrar();
    mutate(input, {
      onSuccess: (r) => {
        toast.success(
          `${t("Conectado:")} ${r.data.displayName} ${r.data.phoneNumber ?? ""}`.trim(),
        );
      },
    });
  }, [encerrar, mutate, t]);

  useEffect(() => {
    function aoReceber(event: MessageEvent) {
      const evento = lerEventoEmbeddedSignup(event.origin, event.data);
      if (!evento) return;
      if (evento.kind === "finish") {
        ids.current = { waba_id: evento.wabaId, phone_number_id: evento.phoneNumberId };
        concluirSePronto();
        return;
      }
      if (!emAndamento.current) return;
      encerrar();
      toast.error(
        evento.kind === "cancel"
          ? t("Conexão cancelada antes de terminar. Nada foi alterado.")
          : (evento.message ?? t("A Meta devolveu um erro durante a conexão.")),
      );
    }
    window.addEventListener("message", aoReceber);
    return () => window.removeEventListener("message", aoReceber);
  }, [concluirSePronto, encerrar, t]);

  async function abrir() {
    if (emAndamento.current) return;
    emAndamento.current = true;
    setAguardando(true);
    let fb: FbSdk;
    try {
      fb = await carregarSdk(appId);
    } catch {
      encerrar();
      toast.error(t("Não foi possível carregar o SDK da Meta. Verifique bloqueadores e tente de novo."));
      return;
    }
    fb.login(
      (response) => {
        const c = response?.authResponse?.code;
        if (!c) {
          // Sem code: a pessoa fechou o popup. Se o CANCEL já chegou por
          // postMessage, `encerrar` já rodou e não repetimos o aviso.
          if (emAndamento.current) {
            encerrar();
            toast.error(t("Conexão cancelada antes de terminar. Nada foi alterado."));
          }
          return;
        }
        code.current = c;
        concluirSePronto();
      },
      {
        config_id: configId,
        response_type: "code",
        override_default_response_type: true,
        extras: {
          setup: {},
          featureType: "whatsapp_business_app_onboarding",
          sessionInfoVersion: "3",
        },
      },
    );
  }

  const ocupado = aguardando || conectar.isPending;
  return (
    <Button type="button" onClick={abrir} disabled={ocupado} data-testid="btn-embedded-signup">
      {conectar.isPending
        ? t("Conectando…")
        : aguardando
          ? t("Aguardando a Meta…")
          : t("Entrar com a conta da Meta")}
    </Button>
  );
}
