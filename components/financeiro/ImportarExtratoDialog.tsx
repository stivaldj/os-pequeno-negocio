"use client";

import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { useImportarExtrato, type ResumoDaImportacao } from "@/hooks/financeiro/useFinanceiro";

/**
 * Importar o extrato OFX do banco.
 *
 * Molde: `components/contacts/ImportContactsDialog.tsx`, e as duas decisões
 * dele valem aqui pelo mesmo motivo, só que mais caro:
 *
 *   • O diálogo NÃO FECHA SOZINHO. O resumo é o que o Dono veio ver — quantos
 *     lançamentos entraram, quantos já existiam, o que foi descartado e por
 *     quê. Fechar ao terminar esconderia exatamente a informação que decide se
 *     ele reexporta o arquivo ou não.
 *   • O upload é `fetch` cru com `FormData` (no hook), porque o `apiClient`
 *     serializa o corpo como JSON e não fala multipart.
 *
 * ⚠️ `por_conteudo > 0` VIRA AVISO, não um número no meio dos outros. Ele diz
 * que aquele banco não mandou identificador confiável (FITID) para parte dos
 * lançamentos: a chave de idempotência passa a ser dia + valor + ordem no
 * arquivo, e reimportar um período que se sobrepõe pode duplicar. É a única
 * contagem do resumo que muda o que o Dono deve FAZER, então ela é uma frase e
 * não um contador.
 *
 * ⚠️ Nada de template literal com interpolação para texto. `` `${n} importados` ``
 * escaparia da cerca do `tests/unit/i18n-espanhol-cobre-a-tela` (ela varre
 * `JsxText`, `StringLiteral` e `NoSubstitutionTemplateLiteral`) e a tela iria
 * para produção sem espanhol, com o gate verde. Cada palavra passa por `t()`.
 */
export function ImportarExtratoDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const t = useT();
  const importar = useImportarExtrato();
  const [file, setFile] = React.useState<File | null>(null);
  const [resumo, setResumo] = React.useState<ResumoDaImportacao | null>(null);

  function limpar() {
    setFile(null);
    setResumo(null);
  }

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    if (!file || importar.isPending) return;
    try {
      setResumo(await importar.mutateAsync(file));
    } catch (err) {
      // A rota escreve mensagens que ENSINAM (como exportar OFX no site do
      // banco, exportar um mês por vez quando o arquivo é grande). Elas chegam
      // como `message` do ApiError e vão inteiras para o toast.
      const msg = err instanceof Error && err.message ? t(err.message) : t("Não foi possível importar o extrato.");
      toast.error(msg);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) limpar();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Importar extrato do banco")}</DialogTitle>
          <DialogDescription>
            {t(
              "Envie o arquivo .ofx exportado pelo banco. No site do banco procure “Exportar extrato” e escolha OFX (aparece também como Money ou Quicken); PDF e planilha não servem. Importar o mesmo arquivo duas vezes não cria lançamento repetido.",
            )}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={enviar} data-testid="form-extrato" className="space-y-4">
          {!resumo && (
            <>
              <div className="space-y-2">
                <Label htmlFor="extrato-file">{t("Arquivo OFX")}</Label>
                <Input
                  id="extrato-file"
                  data-testid="extrato-file"
                  type="file"
                  accept=".ofx,text/plain,application/x-ofx"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                {file && (
                  <p data-testid="extrato-arquivo" className="text-xs text-muted-foreground">
                    {file.name}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={importar.isPending}>
                  {t("Cancelar")}
                </Button>
                <Button type="submit" data-testid="extrato-enviar" disabled={!file || importar.isPending}>
                  {importar.isPending ? t("Importando…") : t("Importar")}
                </Button>
              </DialogFooter>
            </>
          )}

          {resumo && <ResumoDaImportacaoNaTela resumo={resumo} onOutro={limpar} onConcluir={() => onOpenChange(false)} />}
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * O resumo, exportado com props para ser testável sem diálogo nem servidor —
 * mesmo desenho dos blocos de `app/app/financeiro/_client.tsx`.
 */
export function ResumoDaImportacaoNaTela({
  resumo,
  onOutro,
  onConcluir,
}: {
  resumo: ResumoDaImportacao;
  onOutro: () => void;
  onConcluir: () => void;
}) {
  const t = useT();
  return (
    <div className="space-y-3" data-testid="extrato-resumo">
      <div className="flex flex-wrap gap-2 text-sm">
        <span className="rounded-sm bg-surface px-2 py-1" data-testid="resumo-total">
          {resumo.total_lancamentos} {t("lançamento(s) no arquivo")}
        </span>
        <span className="rounded-sm px-2 py-1 font-medium" data-testid="resumo-importados">
          {resumo.importados} {t("importado(s)")}
        </span>
        <span className="rounded-sm bg-surface px-2 py-1" data-testid="resumo-duplicados">
          {resumo.duplicados} {t("já existente(s)")}
        </span>
        <span className="rounded-sm bg-surface px-2 py-1" data-testid="resumo-saldos">
          {resumo.saldos_gravados} {t("saldo(s) do banco gravado(s)")}
        </span>
        {resumo.descartados.length > 0 && (
          <span className="rounded-sm px-2 py-1 font-medium" data-testid="resumo-descartados">
            {resumo.descartados.length} {t("descartado(s)")}
          </span>
        )}
      </div>

      {resumo.por_conteudo > 0 && (
        <p
          data-testid="resumo-por-conteudo"
          className="rounded-sm border border-yellow-600 p-2 text-sm text-yellow-700 dark:text-yellow-500"
        >
          <span className="font-medium">
            {resumo.por_conteudo} {t("lançamento(s) sem identificador do banco.")}
          </span>{" "}
          {t(
            "Este banco não manda um identificador confiável para essas linhas, então elas são reconhecidas por dia, valor e ordem no arquivo. Reimportar um período que se sobrepõe a este pode duplicá-las: exporte períodos sem sobreposição.",
          )}
        </p>
      )}

      {resumo.descartados.length > 0 && (
        <div
          data-testid="resumo-lista-descartados"
          className="max-h-48 space-y-1 overflow-y-auto rounded-sm border border-border p-2 text-sm"
        >
          {resumo.descartados.map((d, i) => (
            <p key={`${d.motivo}-${d.contexto}-${i}`}>
              <span className="font-medium">{d.motivo}</span> <code className="text-muted-foreground">{d.contexto}</code>
            </p>
          ))}
        </div>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" data-testid="extrato-outro" onClick={onOutro}>
          {t("Importar outro arquivo")}
        </Button>
        <Button type="button" data-testid="extrato-concluir" onClick={onConcluir}>
          {t("Concluir")}
        </Button>
      </DialogFooter>
    </div>
  );
}
