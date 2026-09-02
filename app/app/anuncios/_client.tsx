"use client";

import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  useCampanhas,
  useContaDeAnuncios,
  useCriarLink,
  useDecidirProposta,
  useLinksDeCaptura,
  usePropostasPendentes,
  useSalvarConta,
  type Campanha,
  type ContaDeAnuncios,
  type DadosDaConta,
  type DadosDoLink,
  type Decisao,
  type Dias,
  type LinkDeCaptura,
  type Proposta,
} from "@/hooks/ads/useAnuncios";
import { copyToClipboard } from "@/lib/clipboard";
import { Copy } from "@/lib/ui/icons";

/**
 * A tela de Anúncios em quatro blocos, cada um um componente com PROPS — o
 * `AnunciosClient` no fim é só a fiação com os hooks. É o que deixa cada bloco
 * testável sem servidor (`tests/unit/anuncios-tela.test.tsx`) e é o mesmo
 * desenho da Agenda.
 */

function moeda(cents: number, tag: string): string {
  return new Intl.NumberFormat(tag, { style: "currency", currency: "BRL" }).format(cents / 100);
}

// ─── Conta ─────────────────────────────────────────────────────────────────

const NIVEL_DE_AUTONOMIA: Record<number, string> = {
  1: "Nível 1 — só propõe",
  2: "Nível 2 — aplica com aprovação",
  3: "Nível 3 — aplica dentro dos limites",
};

export function ContaCard({
  conta,
  salvando,
  onSalvar,
}: {
  conta: ContaDeAnuncios | null;
  salvando: boolean;
  onSalvar: (dados: DadosDaConta) => void;
}) {
  const t = useT();
  const tag = useTagDeIdioma();
  const [customerId, setCustomerId] = React.useState(conta?.customer_id ?? "");
  const [conversionCustomerId, setConversionCustomerId] = React.useState(conta?.conversion_customer_id ?? "");
  const [conversionAction, setConversionAction] = React.useState(conta?.conversion_action ?? "");

  function enviar(e: React.FormEvent) {
    e.preventDefault();
    onSalvar({
      customer_id: customerId.trim(),
      conversion_customer_id: conversionCustomerId.trim() || null,
      conversion_action: conversionAction.trim() || null,
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Conta do Google Ads")}</CardTitle>
        <CardDescription>
          {t("O ID do cliente e a ação de conversão que recebe os agendamentos pagos.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={enviar} data-testid="form-conta" className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="conta-customer-id">{t("ID do cliente (10 dígitos)")}</Label>
            <Input
              id="conta-customer-id"
              data-testid="conta-customer-id"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              inputMode="numeric"
              pattern="[0-9]{10}"
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="conta-conversion-customer-id">{t("Cliente da conversão (opcional)")}</Label>
            <Input
              id="conta-conversion-customer-id"
              data-testid="conta-conversion-customer-id"
              value={conversionCustomerId}
              onChange={(e) => setConversionCustomerId(e.target.value)}
              inputMode="numeric"
              pattern="[0-9]{10}"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="conta-conversion-action">{t("Ação de conversão")}</Label>
            <Input
              id="conta-conversion-action"
              data-testid="conta-conversion-action"
              value={conversionAction}
              onChange={(e) => setConversionAction(e.target.value)}
            />
          </div>
          <div className="sm:col-span-3">
            <Button type="submit" disabled={salvando}>
              {salvando ? t("Salvando…") : t("Salvar conta")}
            </Button>
          </div>
        </form>

        <dl className="grid gap-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">{t("Nível de autonomia")}</dt>
            <dd data-testid="conta-autonomia">
              {conta ? t(NIVEL_DE_AUTONOMIA[conta.autonomy_level] ?? `Nível ${conta.autonomy_level}`) : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("Último sync")}</dt>
            <dd data-testid="conta-sync">
              {conta?.last_sync_at ? new Date(conta.last_sync_at).toLocaleString(tag, { hour12: false }) : t("Ainda não sincronizou")}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("Último erro")}</dt>
            <dd data-testid="conta-erro" className={conta?.last_error ? "text-destructive" : ""}>
              {conta?.last_error ?? "—"}
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

// ─── Campanhas ─────────────────────────────────────────────────────────────

export function TabelaDeCampanhas({ campanhas }: { campanhas: Campanha[] }) {
  const t = useT();
  const tag = useTagDeIdioma();

  if (campanhas.length === 0) {
    return (
      <p data-testid="campanhas-vazio" className="text-sm text-muted-foreground">
        {t("Nenhuma campanha com gasto ou contato no período.")}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("Campanha")}</TableHead>
            <TableHead className="text-right">{t("Gasto")}</TableHead>
            <TableHead className="text-right">{t("Cliques")}</TableHead>
            <TableHead className="text-right">{t("Conversas")}</TableHead>
            <TableHead className="text-right">{t("Agendamentos")}</TableHead>
            <TableHead className="text-right">{t("Receita")}</TableHead>
            <TableHead className="text-right">{t("Sobra por Real")}</TableHead>
            <TableHead>{t("Dados")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {campanhas.map((c) => (
            <TableRow
              key={c.campaign_id}
              data-testid={`campanha-${c.campaign_id}`}
              data-incompleto={c.incompleto ? "true" : undefined}
              className={c.incompleto ? "bg-yellow-50 dark:bg-yellow-950/30" : undefined}
            >
              <TableCell className="font-medium">{c.campaign_name ?? c.campaign_id}</TableCell>
              <TableCell className="text-right">{moeda(c.gasto_cents, tag)}</TableCell>
              <TableCell className="text-right" data-testid={`campanha-${c.campaign_id}-cliques`}>
                {c.cliques ?? "—"}
              </TableCell>
              <TableCell className="text-right">{c.contatos}</TableCell>
              <TableCell className="text-right" data-testid={`campanha-${c.campaign_id}-agendamentos`}>
                {c.agendamentos}
              </TableCell>
              <TableCell className="text-right">{moeda(c.receita_cents, tag)}</TableCell>
              <TableCell className="text-right font-semibold" data-testid={`campanha-${c.campaign_id}-sobra-por-real`}>
                {c.sobra_por_real === null ? "—" : `${moeda(Math.round(c.sobra_por_real * 100), tag)} ${t("por real")}`}
              </TableCell>
              <TableCell>
                {c.incompleto ? (
                  <Badge variant="outline" data-testid={`campanha-${c.campaign_id}-incompleto`} className="border-yellow-600 text-yellow-700">
                    {c.dias_sem_gasto.length} {t("dia(s) sem gasto")}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">{t("Completo")}</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ─── Links de captura ──────────────────────────────────────────────────────

export function LinksDeCaptura({
  links,
  criando,
  onCriar,
}: {
  links: LinkDeCaptura[];
  criando: boolean;
  onCriar: (dados: DadosDoLink) => void;
}) {
  const t = useT();
  const [campaignId, setCampaignId] = React.useState("");
  const [campaignName, setCampaignName] = React.useState("");
  const [whatsapp, setWhatsapp] = React.useState("");
  const [mensagem, setMensagem] = React.useState("");

  async function copiar(url: string) {
    const ok = await copyToClipboard(url);
    if (ok) toast.success(t("Link copiado."));
    else toast.error(t("Não foi possível copiar. Selecione e copie o endereço."));
  }

  function enviar(e: React.FormEvent) {
    e.preventDefault();
    onCriar({
      campaign_id: campaignId.trim(),
      campaign_name: campaignName.trim(),
      whatsapp_e164: whatsapp.trim(),
      mensagem: mensagem.trim(),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Links de captura")}</CardTitle>
        <CardDescription>
          {t("A URL final de cada anúncio. Quem clica cai no WhatsApp com a mensagem pronta, e o contato chega atribuído à campanha.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {links.length === 0 ? (
          <p data-testid="links-vazio" className="text-sm text-muted-foreground">
            {t("Nenhum link ainda. Crie um por campanha.")}
          </p>
        ) : (
          <ul className="space-y-2">
            {links.map((l) => (
              <li key={l.id} data-testid={`link-${l.id}`} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
                <span className="font-medium">{l.campaign_name ?? l.campaign_id}</span>
                <code className="rounded bg-muted px-1 py-0.5">{l.url}</code>
                {!l.active && <Badge variant="outline">{t("Inativo")}</Badge>}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  data-testid={`copiar-${l.id}`}
                  aria-label={t("Copiar link")}
                  onClick={() => void copiar(l.url)}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={enviar} data-testid="form-link" className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="link-campaign-id">{t("ID da campanha no Google")}</Label>
            <Input id="link-campaign-id" data-testid="link-campaign-id" value={campaignId} onChange={(e) => setCampaignId(e.target.value)} required />
          </div>
          <div className="space-y-1">
            <Label htmlFor="link-campaign-name">{t("Nome da campanha")}</Label>
            <Input id="link-campaign-name" data-testid="link-campaign-name" value={campaignName} onChange={(e) => setCampaignName(e.target.value)} required />
          </div>
          <div className="space-y-1">
            <Label htmlFor="link-whatsapp">{t("WhatsApp de destino (E.164)")}</Label>
            <Input id="link-whatsapp" data-testid="link-whatsapp" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} placeholder="+5565999990000" required />
          </div>
          <div className="space-y-1">
            <Label htmlFor="link-mensagem">{t("Mensagem pré-escrita")}</Label>
            <Textarea id="link-mensagem" data-testid="link-mensagem" value={mensagem} onChange={(e) => setMensagem(e.target.value)} maxLength={300} required />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={criando}>
              {criando ? t("Criando…") : t("Criar link")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ─── Propostas ─────────────────────────────────────────────────────────────

const TIPO_DE_PROPOSTA: Record<Proposta["kind"], string> = {
  orcamento: "Orçamento",
  pausar: "Pausar",
  palavra_chave: "Palavra-chave",
  anuncio: "Anúncio",
  observacao: "Observação",
};

export function PropostasPendentes({
  propostas,
  decidindo,
  onDecidir,
}: {
  propostas: Proposta[];
  decidindo: boolean;
  onDecidir: (id: string, status: Decisao) => void;
}) {
  const t = useT();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Propostas do agente")}</CardTitle>
        <CardDescription>{t("O agente propõe; quem decide é você. Nada muda no Google sem aprovação.")}</CardDescription>
      </CardHeader>
      <CardContent>
        {propostas.length === 0 ? (
          <p data-testid="propostas-vazio" className="text-sm text-muted-foreground">
            {t("Nenhuma proposta pendente.")}
          </p>
        ) : (
          <ul className="space-y-3">
            {propostas.map((p) => (
              <li key={p.id} data-testid={`proposta-${p.id}`} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{t(TIPO_DE_PROPOSTA[p.kind] ?? p.kind)}</Badge>
                  <span className="font-medium">{p.title}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{p.body}</p>
                <div className="mt-2 flex gap-2">
                  <Button type="button" size="sm" data-testid={`aprovar-${p.id}`} disabled={decidindo} onClick={() => onDecidir(p.id, "aprovada")}>
                    {t("Aprovar")}
                  </Button>
                  <Button type="button" size="sm" variant="outline" data-testid={`recusar-${p.id}`} disabled={decidindo} onClick={() => onDecidir(p.id, "recusada")}>
                    {t("Recusar")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Fiação ────────────────────────────────────────────────────────────────

export function AnunciosClient() {
  const t = useT();
  const [dias, setDias] = React.useState<Dias>(30);

  const conta = useContaDeAnuncios();
  const salvarConta = useSalvarConta();
  const links = useLinksDeCaptura();
  const criarLink = useCriarLink();
  const campanhas = useCampanhas(dias);
  const propostas = usePropostasPendentes();
  const decidir = useDecidirProposta();

  return (
    <div className="space-y-6">
      {conta.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <ContaCard
          key={conta.data?.id ?? "nova"}
          conta={conta.data ?? null}
          salvando={salvarConta.isPending}
          onSalvar={(dados) => salvarConta.mutate(dados)}
        />
      )}

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>{t("Campanhas")}</CardTitle>
            <CardDescription>{t("Quanto sobra por real gasto, depois da Margem Declarada. Linha amarela = dia sem gasto no período.")}</CardDescription>
          </div>
          <div className="flex gap-1">
            <Button type="button" size="sm" variant={dias === 7 ? "default" : "outline"} onClick={() => setDias(7)}>
              {t("7 dias")}
            </Button>
            <Button type="button" size="sm" variant={dias === 30 ? "default" : "outline"} onClick={() => setDias(30)}>
              {t("30 dias")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {campanhas.isLoading ? <Skeleton className="h-32 w-full" /> : <TabelaDeCampanhas campanhas={campanhas.data?.campanhas ?? []} />}
        </CardContent>
      </Card>

      {links.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <LinksDeCaptura links={links.data ?? []} criando={criarLink.isPending} onCriar={(dados) => criarLink.mutate(dados)} />
      )}

      {propostas.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <PropostasPendentes
          propostas={propostas.data ?? []}
          decidindo={decidir.isPending}
          onDecidir={(id, status) => decidir.mutate({ id, status })}
        />
      )}
    </div>
  );
}
