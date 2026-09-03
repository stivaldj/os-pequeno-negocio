"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useHistoricoDeRelatorios, type RelatorioEnviado } from "@/hooks/relatorio/useRelatorio";

/**
 * Histórico do Relatório das 8h: um card por dia, mais recente primeiro.
 *
 * ⚠️ Nada de template literal com interpolação para texto que passa por
 * `t()`: escapa da cerca do `tests/unit/i18n-espanhol-cobre-a-tela` e a tela
 * iria a produção sem espanhol com o gate verde.
 */

/** `YYYY-MM-DD` → dia legível no idioma de quem lê. Mesmo desenho de `dia()` em `app/app/financeiro/_client.tsx`. */
function diaLegivel(s: string, tag: string): string {
  return new Date(`${s}T00:00:00Z`).toLocaleDateString(tag, {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
}

const NOME_DA_SECAO: Record<string, string> = {
  atendimentos: "Atendimentos",
  agenda: "Agenda",
  ads: "Anúncios",
  financeiro: "Financeiro",
};

function CardDoRelatorio({ r, tag }: { r: RelatorioEnviado; tag: string }) {
  const t = useT();
  const [aberto, setAberto] = React.useState(false);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
        <CardTitle className="text-base font-medium">{diaLegivel(r.report_date, tag)}</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          {r.status === "falhou" ? (
            <Badge variant="destructive">{t("Falhou")}</Badge>
          ) : (
            <Badge variant="secondary">{t("Enviado")}</Badge>
          )}
          {r.incomplete_sections.map((secao) => (
            <Badge key={secao} variant="outline">
              {t(NOME_DA_SECAO[secao] ?? secao)} {t("incompleto")}
            </Badge>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {r.status === "falhou" && r.failure_reason ? (
          <p className="text-sm text-destructive">{r.failure_reason}</p>
        ) : (
          <>
            <button
              type="button"
              className="text-sm font-medium text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setAberto((v) => !v)}
              data-testid="relatorio-toggle"
            >
              {aberto ? t("Ocultar texto") : t("Ver texto enviado")}
            </button>
            {aberto && (
              <pre className="mt-3 whitespace-pre-wrap rounded-md bg-muted p-3 text-sm" data-testid="relatorio-texto">
                {r.body}
              </pre>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function RelatorioClient() {
  const t = useT();
  const tag = useTagDeIdioma();
  const { data, isLoading } = useHistoricoDeRelatorios();

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const relatorios = data ?? [];
  if (relatorios.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p data-testid="relatorio-vazio" className="text-sm text-muted-foreground">
            {t("Nenhum relatório enviado ainda. O primeiro chega às 8h.")}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {relatorios.map((r) => (
        <CardDoRelatorio key={r.id} r={r} tag={tag} />
      ))}
    </div>
  );
}
