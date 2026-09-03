"use client";

import * as React from "react";
import { toast } from "sonner";

import { ImportarExtratoDialog } from "@/components/financeiro/ImportarExtratoDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import {
  useBaixarObrigacao,
  useCaixa,
  useCriarObrigacao,
  useLancamentos,
  useObrigacoes,
  type Baixa,
  type Caixa,
  type DadosDaObrigacao,
  type GrupoDeVencimento,
  type Lancamento,
  type Obrigacao,
  type Vencimentos,
} from "@/hooks/financeiro/useFinanceiro";
import { formatCentsBRL, parseReaisToCents } from "@/lib/money";

/**
 * A tela do Financeiro em quatro blocos, cada um um componente com PROPS — o
 * `FinanceiroClient` no fim é só a fiação com os hooks. É o que deixa cada
 * bloco testável sem servidor (`tests/unit/financeiro-tela.test.tsx`), e é o
 * mesmo desenho de Anúncios e da Agenda.
 *
 * ⚠️ A REGRA QUE ATRAVESSA A TELA INTEIRA: `null` não é zero.
 * `saldo_cents: null` é "esta conta nunca teve saldo lido do banco" e
 * `total_cents: null` é "falta saldo em alguma conta". Escrever R$ 0,00 no
 * lugar seria afirmar que o Dono não tem dinheiro — a mentira exata que a Fase
 * 6 existe para não contar. Onde falta dado, a tela diz "incompleto" em
 * palavras e mostra travessão no número.
 *
 * ⚠️ Nada de template literal com interpolação para texto: ele escapa da cerca
 * do `tests/unit/i18n-espanhol-cobre-a-tela` e a tela iria a produção sem
 * espanhol com o gate verde. Cada palavra passa por `t()`.
 */

/**
 * `YYYY-MM-DD` → dia legível no idioma de quem lê.
 *
 * `T00:00:00Z` mais `timeZone: "UTC"` porque a coluna é `date`, sem hora: sem
 * fixar o fuso, quem lê a oeste de Greenwich veria o dia anterior — e um
 * vencimento aparecendo um dia antes numa tela de dinheiro é defeito, não
 * detalhe. Mesmo desenho do `diaCurto` de `app/app/ai/evolution/_client.tsx`.
 */
function dia(s: string, tag: string): string {
  return new Date(`${s}T00:00:00Z`).toLocaleDateString(tag, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Rótulo da conta: o que o Dono reconhece no app do banco. */
function nomeDaConta(bankId: string, accountId: string): string {
  return bankId ? `${bankId} · ${accountId}` : accountId;
}

// ─── Caixa ─────────────────────────────────────────────────────────────────

export function CaixaPorConta({ caixa }: { caixa: Caixa }) {
  const t = useT();
  const tag = useTagDeIdioma();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Caixa por conta")}</CardTitle>
        <CardDescription>
          {t(
            "O saldo é o que o BANCO declarou no extrato, com a data em que ele valia — não a soma dos lançamentos importados. O que entrou depois dessa data aparece à parte.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm text-muted-foreground">{t("Total em caixa")}</span>
          {caixa.total_cents === null ? (
            <span data-testid="caixa-total-incompleto" className="text-sm font-medium text-yellow-700 dark:text-yellow-500">
              {t("Sem total: alguma conta está incompleta.")}
            </span>
          ) : (
            <span data-testid="caixa-total" className="text-2xl font-semibold">
              {formatCentsBRL(caixa.total_cents)}
            </span>
          )}
        </div>

        {caixa.contas.length === 0 ? (
          <p data-testid="caixa-vazio" className="text-sm text-muted-foreground">
            {t("Nenhum extrato importado ainda. Comece por “Importar extrato”.")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Conta")}</TableHead>
                  <TableHead>{t("Tipo")}</TableHead>
                  <TableHead className="text-right">{t("Saldo do banco")}</TableHead>
                  <TableHead className="text-right">{t("Depois desse saldo")}</TableHead>
                  <TableHead className="text-right">{t("Estimado hoje")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {caixa.contas.map((c) => (
                  <TableRow
                    key={`${c.bank_id}|${c.account_id}|${c.account_kind}`}
                    data-testid={`conta-${c.account_id}`}
                    data-incompleto={c.incompleto ? "true" : undefined}
                    className={c.incompleto ? "bg-yellow-50 dark:bg-yellow-950/30" : undefined}
                  >
                    <TableCell className="font-medium">{nomeDaConta(c.bank_id, c.account_id)}</TableCell>
                    <TableCell>{c.account_kind === "credit_card" ? t("Cartão de crédito") : t("Conta bancária")}</TableCell>
                    <TableCell className="text-right" data-testid={`conta-${c.account_id}-saldo`}>
                      {c.saldo_cents === null || c.saldo_em === null ? (
                        <Badge variant="outline" className="border-yellow-600 text-yellow-700">
                          {t("incompleto")}
                        </Badge>
                      ) : (
                        <span>
                          {formatCentsBRL(c.saldo_cents)}{" "}
                          <span className="text-xs text-muted-foreground" data-testid={`conta-${c.account_id}-saldo-em`}>
                            {t("em")} {dia(c.saldo_em, tag)}
                          </span>
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {c.lancamentos_depois} {t("lançamento(s)")} · {formatCentsBRL(c.soma_depois_cents)}
                    </TableCell>
                    <TableCell className="text-right font-semibold" data-testid={`conta-${c.account_id}-estimado`}>
                      {c.saldo_estimado_cents === null ? "—" : formatCentsBRL(c.saldo_estimado_cents)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {caixa.incompleto && (
          <p data-testid="caixa-aviso-incompleto" className="text-sm text-yellow-700 dark:text-yellow-500">
            {t(
              "Conta marcada como incompleta nunca teve saldo lido do banco: o extrato importado não trouxe o saldo declarado. Ela fica de fora do total até que um extrato com saldo chegue.",
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Vencimentos ───────────────────────────────────────────────────────────

function GrupoDeVencimentos({
  titulo,
  vazio,
  grupo,
  testId,
  tag,
  t,
}: {
  titulo: string;
  vazio: string;
  grupo: GrupoDeVencimento;
  testId: string;
  tag: string;
  t: (texto: string) => string;
}) {
  return (
    <div data-testid={testId} className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold">{titulo}</h3>
        <span className="text-xs text-muted-foreground" data-testid={`${testId}-totais`}>
          {t("A pagar")} {formatCentsBRL(grupo.total_cents.payable)} · {t("A receber")}{" "}
          {formatCentsBRL(grupo.total_cents.receivable)}
        </span>
      </div>
      {grupo.itens.length === 0 ? (
        <p className="text-sm text-muted-foreground">{vazio}</p>
      ) : (
        <ul className="space-y-1">
          {grupo.itens.map((i) => (
            <li key={i.id} data-testid={`vencimento-${i.id}`} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
              <Badge variant="outline">{i.direction === "payable" ? t("A pagar") : t("A receber")}</Badge>
              <span className="font-medium">{i.description}</span>
              <span>{formatCentsBRL(i.amount_cents)}</span>
              <span className="text-muted-foreground">{dia(i.due_on, tag)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function VencimentosDoDia({ vencimentos }: { vencimentos: Vencimentos }) {
  const t = useT();
  const tag = useTagDeIdioma();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("O que vence")}</CardTitle>
        <CardDescription>
          {t("O dia é o do fuso da sua organização, não o do servidor. Só contas em aberto entram aqui.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <GrupoDeVencimentos
          titulo={t("Já venceu")}
          vazio={t("Nada vencido em aberto.")}
          grupo={vencimentos.vencidas}
          testId="vencidas"
          tag={tag}
          t={t}
        />
        <GrupoDeVencimentos
          titulo={t("Vence hoje")}
          vazio={t("Nada vence hoje.")}
          grupo={vencimentos.vencem_hoje}
          testId="vencem-hoje"
          tag={tag}
          t={t}
        />
        <GrupoDeVencimentos
          titulo={t("Próximos 7 dias")}
          vazio={t("Nada nos próximos 7 dias.")}
          grupo={vencimentos.proximos_7_dias}
          testId="proximos-7"
          tag={tag}
          t={t}
        />
      </CardContent>
    </Card>
  );
}

// ─── Contas a pagar e a receber ────────────────────────────────────────────

export function ContasCadastradas({
  obrigacoes,
  hoje,
  criando,
  onCriar,
  dandoBaixa,
  onBaixar,
}: {
  obrigacoes: Obrigacao[];
  /** O dia no fuso da organização, vindo do `GET /caixa`. A tela não recalcula. */
  hoje: string;
  criando: boolean;
  onCriar: (dados: DadosDaObrigacao) => void;
  dandoBaixa: boolean;
  onBaixar: (baixa: Baixa) => void;
}) {
  const t = useT();
  const tag = useTagDeIdioma();
  const [direcao, setDirecao] = React.useState<DadosDaObrigacao["direction"]>("payable");
  const [descricao, setDescricao] = React.useState("");
  const [valor, setValor] = React.useState("");
  const [vencimento, setVencimento] = React.useState("");

  function enviar(e: React.FormEvent) {
    e.preventDefault();
    // Reais → centavos por `lib/money.ts`, nunca por conversão nova: aquele
    // arquivo já desambiguou "249.90" de "1.234" e a regra não se reescreve.
    const cents = parseReaisToCents(valor);
    if (cents === null || cents <= 0) {
      toast.error(t("Digite o valor em reais, por exemplo 1.250,00."));
      return;
    }
    onCriar({
      direction: direcao,
      description: descricao.trim(),
      amount_cents: cents,
      due_on: vencimento,
    });
    setDescricao("");
    setValor("");
    setVencimento("");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Contas a pagar e a receber")}</CardTitle>
        <CardDescription>
          {t(
            "O valor é sempre positivo: quem diz pagar ou receber é a direção. A baixa é manual — o sistema não adivinha qual lançamento do extrato pagou qual conta.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {obrigacoes.length === 0 ? (
          <p data-testid="obrigacoes-vazio" className="text-sm text-muted-foreground">
            {t("Nenhuma conta em aberto.")}
          </p>
        ) : (
          <ul className="space-y-1">
            {obrigacoes.map((o) => (
              <li key={o.id} data-testid={`obrigacao-${o.id}`} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
                <Badge variant="outline">{o.direction === "payable" ? t("A pagar") : t("A receber")}</Badge>
                <span className="font-medium">{o.description}</span>
                <span>{formatCentsBRL(o.amount_cents)}</span>
                <span className="text-muted-foreground">{dia(o.due_on, tag)}</span>
                <Button
                  type="button"
                  size="sm"
                  data-testid={`baixar-${o.id}`}
                  disabled={dandoBaixa}
                  onClick={() => onBaixar({ id: o.id, status: "paid", paid_on: hoje })}
                >
                  {o.direction === "payable" ? t("Marcar como paga") : t("Marcar como recebida")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid={`cancelar-${o.id}`}
                  disabled={dandoBaixa}
                  onClick={() => onBaixar({ id: o.id, status: "cancelled" })}
                >
                  {t("Cancelar")}
                </Button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={enviar} data-testid="form-obrigacao" className="grid gap-3 sm:grid-cols-4">
          <div className="space-y-1">
            <span className="text-sm font-medium">{t("Direção")}</span>
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                data-testid="obrigacao-payable"
                variant={direcao === "payable" ? "default" : "outline"}
                onClick={() => setDirecao("payable")}
              >
                {t("A pagar")}
              </Button>
              <Button
                type="button"
                size="sm"
                data-testid="obrigacao-receivable"
                variant={direcao === "receivable" ? "default" : "outline"}
                onClick={() => setDirecao("receivable")}
              >
                {t("A receber")}
              </Button>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="obrigacao-descricao">{t("Descrição")}</Label>
            <Input
              id="obrigacao-descricao"
              data-testid="obrigacao-descricao"
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              maxLength={200}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="obrigacao-valor">{t("Valor (R$)")}</Label>
            <Input
              id="obrigacao-valor"
              data-testid="obrigacao-valor"
              value={valor}
              onChange={(e) => setValor(e.target.value)}
              inputMode="decimal"
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="obrigacao-vencimento">{t("Vence em")}</Label>
            <Input
              id="obrigacao-vencimento"
              data-testid="obrigacao-vencimento"
              type="date"
              value={vencimento}
              onChange={(e) => setVencimento(e.target.value)}
              required
            />
          </div>
          <div className="sm:col-span-4">
            <Button type="submit" disabled={criando}>
              {criando ? t("Cadastrando…") : t("Cadastrar conta")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ─── Últimos lançamentos ───────────────────────────────────────────────────

export function UltimosLancamentos({ lancamentos }: { lancamentos: Lancamento[] }) {
  const t = useT();
  const tag = useTagDeIdioma();

  if (lancamentos.length === 0) {
    return (
      <p data-testid="lancamentos-vazio" className="text-sm text-muted-foreground">
        {t("Nenhum lançamento importado ainda.")}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("Dia")}</TableHead>
            <TableHead>{t("Descrição")}</TableHead>
            <TableHead>{t("Conta")}</TableHead>
            <TableHead className="text-right">{t("Valor")}</TableHead>
            <TableHead>{t("Identificação")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lancamentos.map((l) => (
            <TableRow key={l.id} data-testid={`lancamento-${l.id}`} data-fragil={l.key_source === "conteudo" ? "true" : undefined}>
              <TableCell>{dia(l.posted_on, tag)}</TableCell>
              <TableCell className="font-medium">{l.description}</TableCell>
              <TableCell>{nomeDaConta(l.bank_id, l.account_id)}</TableCell>
              <TableCell
                className={l.amount_cents < 0 ? "text-right text-destructive" : "text-right"}
                data-testid={`lancamento-${l.id}-valor`}
              >
                {formatCentsBRL(l.amount_cents)}
              </TableCell>
              <TableCell>
                {l.key_source === "conteudo" ? (
                  <Badge variant="outline" data-testid={`lancamento-${l.id}-fragil`} className="border-yellow-600 text-yellow-700">
                    {t("sem identificador do banco")}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">{t("do banco")}</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ─── Fiação ────────────────────────────────────────────────────────────────

export function FinanceiroClient() {
  const t = useT();
  const [importando, setImportando] = React.useState(false);

  const painel = useCaixa();
  const obrigacoes = useObrigacoes();
  const lancamentos = useLancamentos(50);
  const criar = useCriarObrigacao();
  const baixar = useBaixarObrigacao();

  return (
    <div className="space-y-6">
      <div>
        <Button type="button" data-testid="abrir-importar" onClick={() => setImportando(true)}>
          {t("Importar extrato")}
        </Button>
      </div>
      <ImportarExtratoDialog open={importando} onOpenChange={setImportando} />

      {painel.isLoading || !painel.data ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          <CaixaPorConta caixa={painel.data.caixa} />
          <VencimentosDoDia vencimentos={painel.data.vencimentos} />
        </>
      )}

      {obrigacoes.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <ContasCadastradas
          obrigacoes={obrigacoes.data ?? []}
          hoje={painel.data?.hoje ?? ""}
          criando={criar.isPending}
          onCriar={(dados) => criar.mutate(dados)}
          dandoBaixa={baixar.isPending}
          onBaixar={(baixa) => baixar.mutate(baixa)}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("Últimos lançamentos")}</CardTitle>
          <CardDescription>
            {t("As linhas do extrato, como o banco as mandou. Linha marcada é linha sem identificador confiável do banco.")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {lancamentos.isLoading ? <Skeleton className="h-32 w-full" /> : <UltimosLancamentos lancamentos={lancamentos.data ?? []} />}
        </CardContent>
      </Card>
    </div>
  );
}
