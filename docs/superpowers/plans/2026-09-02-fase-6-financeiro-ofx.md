# Plano — Fase 6: Financeiro por OFX — caixa, contas a pagar e a receber, lembretes

Issue: #24. Spec: `docs/spec/0003-relatorio-das-8h.md` (O dinheiro; Rotinas; Painel). ADRs: 0007 (emendada), 0008, 0017.

**Objetivo.** O Dono exporta o extrato do banco em OFX, importa pela tela Financeiro, e o sistema passa a saber três coisas que hoje não sabe: quanto tem em caixa, o que vence hoje, e o que já venceu. Importar o mesmo arquivo duas vezes não cria um lançamento a mais. Todo dia de manhã um cron manda ao Dono, pelo WhatsApp, o que vence — e grava `job_runs`, para que o silêncio seja detectável. Nada disso toca receita por paciente: essa continua nascendo no `paid_cents` da agenda (ADR-0017), e o Extrato serve ao caixa e às contas.

**Arquitetura.** Módulo próprio inteiro: `lib/financeiro/` mais um cron próprio, uma tela e quatro tabelas. Não fala com `lib/agent-engine/` de forma alguma; fala com o Dono pelo `enviarAoDono` da Fase 5, que já resolve contato, conversa e adapter. O parser de OFX é **puro**, sem banco e sem dependência nova — mesmo desenho do `lib/contacts/csv.ts` (o comentário daquele arquivo declara por quê: não trazer parser de terceiro para dentro de um self-host), e mesmo desenho de módulo determinístico de dinheiro do `lib/ads/sobra.ts`.

---

## Decisões que o levantamento impôs

Seis decisões que mudam o texto da spec ou da issue, todas com a evidência que as forçou.

**1. Parser próprio, não biblioteca — e a evidência é um bug de sinal.** O levantamento rodou `ofx-js@1.1.1` e `ofx-data-extractor@1.5.0` contra extratos reais de BB, Bradesco, Santander e Caixa. A `ofx-data-extractor` classifica crédito/débito pelo `TRNTYPE` em vez do sinal do `TRNAMT`; num extrato Santander cujos quatro lançamentos somam exatamente R$ 0,00 (`-11,76`, `-2,23`, `-33,02`, `+47,01`, todos com `TRNTYPE:OTHER`), ela reporta **+94,02 de crédito e 0,00 de débito**. A spec OFX 2.2 §3.2.9.2 diz o contrário em texto literal: o sinal está no `TRNAMT`. A `ofx-js` tokeniza bem mas ignora `CHARSET` (recebe `string`, não `Buffer`) e **lança** se um `MEMO` contiver `<`. As duas partes difíceis — cp1252, vírgula decimal, dia sem UTC, centavos inteiros, chave de idempotência — nenhuma das duas faz. Escrevemos ~250 linhas e não acrescentamos nada ao `pnpm-lock`.

**2. As fixtures são nossas, e o extrato real da clínica entra depois — sem mudar código.** Os extratos brasileiros reais anonimizados que circulam vivem em `annacruz/ofx`, que **não declara licença** (a API do GitHub devolve 404 em `/license`): sem licença, sem direito de versionar. Eles serviram de oráculo durante o desenvolvimento; o que entra no repo são fixtures escritas por nós reproduzindo os mesmos defeitos medidos, cada uma com a asserção que justifica sua existência. **O teste varre a pasta `tests/fixtures/ofx/`**, de modo que o extrato real da Clínica Humana, quando o José exportar e anonimizar, entra no gate sem que se toque numa linha de teste. Ver "Prova da fase" para como isso fecha o critério literal da issue.

**3. Caixa vem do `LEDGERBAL`, não da soma dos lançamentos.** O Dono importa uma janela (um mês, uma semana). Somar os lançamentos importados dá o movimento daquela janela, nunca o saldo. O saldo verdadeiro é o `LEDGERBAL` que o próprio banco declara no arquivo, com seu `DTASOF`. Por isso nasce uma quarta tabela, `ledger_balances`: o caixa é o último saldo declarado por conta, mais os lançamentos posteriores a ele, e a tela **diz qual é a data desse saldo**. Conta sem saldo lido é `incompleto: true`, nunca zero — a mesma disciplina do "dia sem gasto lido" do módulo de ads.

**4. Uma tabela para as duas contas, com `direction`.** A spec e a issue escrevem "`payables`/`receivables`". Duas tabelas de forma idêntica seriam duplicação sem fonte declarada, que é anti-pattern nomeado no `CLAUDE.md`; e o próprio `CONTEXT.md:119-121` define **Conta a Pagar e Conta a Receber numa entrada só** ("Compromisso financeiro com data"). Nasce `financial_obligations` com `direction in ('payable','receivable')`. O ganho concreto aparece na Fase 7: "o que vence hoje" é uma consulta, não duas.

**5. Valor com separador ambíguo é recusado, nunca adivinhado.** A spec proíbe separador de milhar, mas bancos brasileiros mandam vírgula decimal (Bradesco `-530,86`) com padding (Santander `            -11,76`) e a Caixa chega a mandar `            .  `. A regra: dois separadores presentes → o último é o decimal; um separador com 1 ou 2 dígitos depois → decimal; **um separador com 3+ dígitos depois → `null`**, a linha vai para os erros da importação com motivo legível. `parseFloat` não aparece em lugar nenhum (`parseFloat("1.005")*100 === 100.49999999999999`, medido); a conversão é por string com `BigInt`. E `"            .  "` devolve `null`, jamais `0` — zero entraria no livro-caixa como lançamento válido.

**6. A chave de fallback NÃO usa a descrição.** Foi a correção mais cara da revisão do plano. Quando o `FITID` não serve, a chave se compõe de `dia + valor + ordinal`, e **não** do `MEMO`: bancos brasileiros reescrevem a descrição entre um extrato e o seguinte, e uma chave que dependesse dela geraria `external_id` novo na reimportação, sem `23505`, criando lançamento duplicado que o caixa somaria — **saldo errado ao Dono sem nada ficar vermelho**, exatamente o desfecho que a decisão 5 existe para impedir. O preço é que dois lançamentos do mesmo dia, mesmo valor e descrições diferentes ficam indistinguíveis: por isso o ordinal, e por isso a contagem de `key_source: 'conteudo'` aparece no resumo da importação e na tela — o Dono precisa saber quando uma conta está no modo frágil.

**Duas armadilhas que viram teste, não prosa.** (a) `DTPOSTED` sem offset **nunca vira `Date`**: o dia sai por fatia de string, porque `20100826` interpretado em UTC e lido no fuso de Cuiabá volta 25/08 (medido). Com offset (`20260106000000[-3:GMT]` — o nome mente, o offset não), converte-se para `America/Sao_Paulo` e toma-se a data. (b) Em SGML sem fechamento, **um** `STMTTRN` vira objeto e **vários** viram array: todo acesso passa por um `asArray()`, e há fixture com duas contas no mesmo arquivo para travar isso.

---

## Prova da fase

Da issue #24, literal: `pnpm vitest run lib/financeiro`, hoje vermelho por "No test files found". Fecha verde com as fixtures gerando saldo e vencimentos do dia, e com a segunda importação do mesmo arquivo não criando lançamento.

Acrescenta-se a prova de realidade, no molde das Fases 4 e 5: `pnpm tsx scripts/prova-financeiro.ts` → `tests/prova/financeiro.prova.ts` contra a pilha local, que passa pelo **handler extraído** da rota (multipart), importa duas vezes e afirma zero linhas novas na segunda, afirma o caixa e os vencimentos, e roda o cron de lembrete afirmando a mensagem na caixa de saída do adapter fake.

**Sobre a palavra "real" no critério da issue.** O critério diz "OFX **real** anonimizado gera saldo e vencimentos do dia nos testes". A decisão 2 explica por que não versionamos extrato de terceiro sem licença. O critério **não é abandonado, é adiado por um passo**: a Tarefa 10 comenta na #24 registrando o argumento de licença **antes** de colar qualquer rodapé, e o HITL é justamente o José exportar o extrato do banco da Clínica Humana, anonimizar e largar em `tests/fixtures/ofx/` — o teste varre a pasta, então o gate passa a rodar com arquivo de banco real sem uma linha de código nova. A fase só fecha aí.

**HITL (José):** exportar o extrato do banco da Clínica Humana em OFX; anonimizar e pôr em `tests/fixtures/ofx/`; importar pela tela; conferir que o saldo bate com o do app do banco; cadastrar as contas que vencem no mês.

---

## Ambiente e grafo de tarefas

`export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"` antes de qualquer `pnpm`. `pnpm test:unit --maxWorkers=3`. `pnpm test:db` precisa de Docker. Baseline: apêndice **entre a linha 17431 (`notify pgrst` do bloco 0208) e a 17433 (`-- ---- VARREDURA anon`)**; migration `0209`, prefixo maior que `20260903000000`; linha no `supabase/migrations/MANIFEST.md` após a 238.

**Não há env var nova nesta fase.** `lib/env.ts`, `.env.example` e `.env.hostgator.example` ficam intocados — o executor não precisa procurar.

**Ondas de execução** (conferidas arquivo a arquivo; dentro de cada onda não há arquivo em comum):

```
onda 1:  T1 (parser)        ∥  T2 (schema + TODAS as ações de audit)
onda 2:  T3 (importar)      ∥  T5 (caixa/vencimentos)
onda 3:  T4 (rota+handler)  ∥  T6 (rotas CRUD)  ∥  T7 (cron)
onda 4:  T8 (tela)
onda 5:  T9 (prova)  →  T10 (gates, issue, PR)
```

`lib/audit/actions.ts` é append-only e foi disputado por três tarefas na primeira versão deste plano — na Fase 5 isso virou desvio registrado (`ads.sync_falhou` declarada duas vezes). **Todas as ações da fase são declaradas de uma vez na Tarefa 2**; nenhuma outra tarefa toca o arquivo.

---

## Parte A — O parser

### Tarefa 1 — `lib/financeiro/ofx/`: ler OFX brasileiro sem mentir

**Arquivos (todos novos):** `lib/financeiro/ofx/tipos.ts`, `header.ts`, `tokenizer.ts`, `normalizar.ts`, `extrair.ts`, `index.ts`, e os testes co-localizados `header.test.ts`, `tokenizer.test.ts`, `normalizar.test.ts`, `extrair.test.ts`; `tests/fixtures/ofx/` (fixtures + `gerar.mjs` + `README.md`); edita `.gitattributes`.

Nada de banco, nada de Supabase, nada de `organization_id`. Módulo puro.

1. **As fixtures precisam de bytes que o git não normaliza — e este repo normaliza.** `.gitattributes` termina em `* text=auto eol=lf`, e foi medido: um `.ofx` commitado com CRLF volta do checkout com LF (o byte cp1252 sobrevive; o `\r` não). Duas providências, nesta ordem:
   - entrada nova em `.gitattributes`, com comentário no padrão do arquivo (ele explica cada regra): `tests/fixtures/ofx/*.ofx -text`, dizendo que ali o CRLF e o cp1252 são **dado do teste**, não formatação — normalizá-los faz o teste de tolerância a CRLF ficar verde por vacuidade;
   - `tests/fixtures/ofx/gerar.mjs`, que escreve cada fixture a partir de um template em texto com `Buffer.from(texto, "latin1")` e `\r\n` explícitos. Ferramenta de edição emite UTF-8; sem este script as fixtures nascem erradas e o executor perde meia hora descobrindo por quê. O `README.md` da pasta diz o que cada arquivo prova e manda rodar `node tests/fixtures/ofx/gerar.mjs` para regerar.
2. **Fixtures** (todas `VERSION:102`, `CHARSET:1252`, CRLF, salvo onde dito):
   - `bradesco-like.ofx` — linha em branco antes do `OFXHEADER`, `DTSERVER:00000000000000`, primeiro `<STATUS>` com filhos abertos e segundo com filhos fechados, `TRNAMT` com vírgula e padding, `MEMO` com `CARTÃO`/`COBRANÇA` e um `&` não escapado, `FITID == CHECKNUM`, `ACCTID` `00012345-6 ` com espaço, `LEDGERBAL` e `AVAILBAL`.
   - `duas-contas.ofx` — dois `STMTTRNRS`, um `STMTTRN` só na segunda conta (trava o `asArray()` nos dois sentidos).
   - `caixa-decimal-quebrado.ofx` — um `TRNAMT` `            .  ` e uma linha sintética `MEMO: SALDO DIA` com `FITID:0`.
   - `fitid-repetido.ofx` — duas transações da mesma conta com o mesmo `FITID`.
   - `memo-com-sinal.ofx` — um `MEMO` contendo `<` (o caractere que derruba a `ofx-js`).
   - `cartao.ofx` — `CREDITCARDMSGSRSV1 > CCSTMTRS` com `CCACCTFROM` só de `ACCTID`.
   - `ofx2.xml.ofx` — o mesmo conteúdo em OFX 2.x (`<?xml?>` + `<?OFX OFXHEADER="200" VERSION="220"?>`, tudo fechado, UTF-8), provando que **um tokenizer só** lê os dois.
3. **`tipos.ts`**:
   ```ts
   export type ContaKind = "bank" | "credit_card";
   export interface ContaDoExtrato { bankId: string; acctId: string; kind: ContaKind; acctType: string | null }
   export type TrnType = "CREDIT" | "DEBIT" | ... | "HOLD" | "OTHER";   // 18 valores da §11.4.4.3
   export interface LancamentoOfx {
     conta: ContaDoExtrato; tipo: TrnType; dia: string;          // "YYYY-MM-DD"
     dtpostedBruto: string; valorCents: number;                  // com sinal
     moeda: string; fitid: string | null; checknum: string | null; descricao: string;
     chaveBruta: string;                                         // determinística, SEM organization_id
     chaveOrigem: "fitid" | "conteudo";
   }
   export interface SaldoOfx { conta: ContaDoExtrato; tipo: "ledger" | "available"; dia: string; dtasofBruto: string; valorCents: number }
   export interface Descartado { motivo: string; contexto: string }
   export interface ExtratoLido { versao: "1" | "2"; charset: string; lancamentos: LancamentoOfx[]; saldos: SaldoOfx[]; descartados: Descartado[] }
   export const OFX_MAX_BYTES = 5 * 1024 * 1024;
   export const OFX_MAX_LANCAMENTOS = 5000;
   ```
   `dtasofBruto` existe porque a armadilha do "lançamento no mesmo dia do saldo" (Tarefa 5) é decisão de dinheiro e só dá para refinar com a hora; `LancamentoOfx` já guarda o bruto pela mesma razão.
4. **`header.ts`** — `lerCabecalho(buf: Buffer): { versao, charset, corpo: string }`. Come BOM (`EF BB BF`, `FF FE`, `FE FF`); decide v1/v2 pela primeira linha não vazia (`<?xml` ou `<?OFX` → v2; pares `CHAVE:VALOR` → v1); lê o cabeçalho **em ASCII** e resolve o codec pelo par `ENCODING`/`CHARSET` — `1252 → windows-1252`, `ISO-8859-1 → iso-8859-1`, `NONE`/ausente/`UTF-8`/`UNICODE` → `utf-8`; decodifica com `new TextDecoder(label, { fatal: false })` (medido em `v22.22.0`: os encodings legados existem sem full-icu). Teste: o `MEMO` da fixture sai `CARTÃO`, não `CART�O`; arquivo maior que `OFX_MAX_BYTES` lança com mensagem que ensina.
5. **`tokenizer.ts`** — `tokenizar(corpo: string): No` (árvore `{ [tag]: string | No | Array<...> }`) e `asArray<T>(v: T | T[] | undefined): T[]`. Pilha; `</TAG>` fecha o topo; ausência de fechamento fecha implicitamente ao ver a próxima tag do mesmo nível; valor é tudo até o próximo `<` **que case `/^<\/?[A-Z0-9_.]+>/i`** — um `<` solto dentro de `MEMO` é texto, não tag, e não derruba o arquivo. Tolera `&` cru, tabs, CRLF, padding. Teste: fechamento misto no mesmo arquivo; `<` e `&` no `MEMO`; um filho vira objeto e dois viram array.
6. **`normalizar.ts`** — quatro funções puras. **Cabeçalho obrigatório do arquivo** apontando o irmão `lib/money.ts` e declarando a divergência: `parseReaisToCents` lê **digitação humana** de formulário e aceita `"1.234"` como 123400; `paraCentavos` lê **formato de fio de banco**, onde a spec proíbe separador de milhar, e por isso recusa o ambíguo em vez de adivinhar. Duas regras diferentes para dois problemas diferentes, dito em voz alta para não virar "duplicação sem fonte declarada".
   - `paraCentavos(raw: string): number | null` — regra da decisão 5, `BigInt`, sem `parseFloat`. `""`, `"."`, `"            .  "`, `"1.234"` → `null`; `"-1.234,56"` → `-123456`; `"            847,10"` → `84710`; `"-12.0"` → `-1200`; `"550"` → `55000` (sem separador, o ponto decimal é implícito no fim — OFX §3.2.9.2, logo `550.` = R$ 550,00).
   - `diaDoDtposted(raw: string): string | null` — regex da §3.2.8.1; **sem offset → fatia de string, nunca `Date`**; com offset → instante convertido para `America/Sao_Paulo`. `"20100826"` → `"2010-08-26"`; `"20150730120000"` → `"2015-07-30"`; `"20260106000000[-3:GMT]"` → `"2026-01-06"`; `"20170831230000[-3:BRT]"` → `"2017-08-31"` (o caso que UTC estragaria).
   - `tipoDeTransacao(raw: string): TrnType` — fora da lista de 18 → `"OTHER"`, sem lançar.
   - `descricaoDe(t): string` — `MEMO ?? NAME ?? EXTDNAME ?? ""`, trim e colapso de espaços.
7. **`extrair.ts`** — `extrair(raiz: No): { lancamentos, saldos, descartados }`. Percorre `BANKMSGSRSV1 > STMTTRNRS > STMTRS` **e** `CREDITCARDMSGSRSV1 > CCSTMTTRNRS > CCSTMTRS`, sempre por `asArray`. `BANKACCTFROM` → `{ bankId: trim(BANKID), acctId: trim(ACCTID), kind: "bank", acctType }`; `CCACCTFROM` → `{ bankId: "", acctId, kind: "credit_card", acctType: null }`. `CURDEF` vira `moeda` (default `"BRL"`).
   **Chave** (spec §3.2.1 manda compor; decisão 6 tira a descrição): por conta, se todo `FITID` for não vazio, diferente de `"0"` e **sem repetição dentro do arquivo**, `chaveBruta = "fitid|" + bankId + "|" + acctId + "|" + kind + "|" + fitid`, `chaveOrigem: "fitid"`. Senão, **aquela conta inteira** cai para `chaveBruta = "conteudo|" + bankId + "|" + acctId + "|" + kind + "|" + dia + "|" + valorCents + "|" + ordinal`, com ordinal por grupo `(dia, valorCents)` na ordem do arquivo — não índice global, para que reimportar período sobreposto reencontre o mesmo ordinal.
   Lançamento com `dia` ou `valorCents` nulo não entra: vai para `descartados` com motivo. **Saldo cujo `paraCentavos` devolve `null` também vira `descartado`** (motivo `saldo_ilegivel`) e a conta fica sem saldo — nunca `0`. `CORRECTFITID`/`CORRECTACTION` viram `descartados` com motivo `correcao_nao_suportada` (registrar em vez de aplicar errado).
8. **`index.ts`** — `export function lerOfx(buf: Buffer): ExtratoLido` e os re-exports.
9. Verde em `pnpm vitest run lib/financeiro/ofx`. Commit: `feat(financeiro): an OFX parser that survives Brazilian banks`.

---

## Parte B — O schema

### Tarefa 2 — Migration 0209: livro-caixa, saldos, categorias e obrigações

**Arquivos:** `supabase/baseline.sql` (apêndice entre 17431 e 17433), `supabase/migrations/20260904000000_0209_financeiro_ofx.sql`, `supabase/migrations/MANIFEST.md`, novo `tests/invariants/financeiro-schema.test.ts`, `tests/invariants/rls-completude-varredura.test.ts` (quatro entradas em `PROVA_PROPRIA`), `lib/audit/actions.ts` (**todas** as ações da fase, de uma vez).

Feita pelo condutor, não por agente — é a dependência de todo o resto.

1. **Invariante primeiro**, no molde de `tests/invariants/ads-schema.test.ts` (UUIDs fixos legíveis `fi600000-0000-4000-8000-00000000000a`, seed em `beforeAll` com `on conflict do nothing`): as quatro tabelas existem com RLS ligada; org B não lê nem escreve nada da org A; `viewer` não escreve e `manager` escreve; `unique (organization_id, external_id)` recusa o segundo insert com `23505`; `amount_cents` aceita negativo (é assinado, de propósito) e `currency` é `char(3)`; vocabulários recusam valor fora da lista; `anon` não tem grant. Rodar `pnpm test:db tests/invariants/financeiro-schema.test.ts` — vermelho.
2. **SQL** (bloco `-- ---- financeiro: livro-caixa por OFX, saldos, categorias e obrigações (migration 0209) ----`). **As quatro tabelas têm, sem exceção**: `id uuid primary key default gen_random_uuid()`, `organization_id uuid not null references public.organizations(id) on delete cascade`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()` com trigger `fn_set_updated_at` (molde `trg_orders_updated_at`, `baseline.sql:3034`), `enable row level security`, policy `<t>_member_select` (leitura por membro) e `<t>_manager_write` (`fn_role_at_least(organization_id,'manager')` em `using` **e** `with check`), `revoke all ... from anon`. Um único `notify pgrst, 'reload schema';` no fim do bloco inteiro. Colunas próprias:
   - `ledger_categories` — `slug text not null`, `name text not null`, `kind text not null check (kind in ('income','expense'))`, `match_terms text[] not null default '{}'`, `unique (organization_id, slug)`.
   - `ledger_entries` — `external_id text not null`, `bank_id text not null default ''`, `account_id text not null`, `account_kind text not null check (account_kind in ('bank','credit_card'))`, `posted_on date not null`, `amount_cents bigint not null` (**assinado**), `currency char(3) not null default 'BRL'`, `trn_type text not null check (trn_type in (…18 valores…))`, `description text not null default ''`, `fitid text`, `checknum text`, `key_source text not null check (key_source in ('fitid','conteudo'))`, `source text not null check (source in ('ofx','manual'))`, `category_id uuid references public.ledger_categories(id) on delete set null`, `imported_at timestamptz not null default now()`. `unique (organization_id, external_id)`; índices `(organization_id, posted_on)` e `(organization_id, account_kind, account_id, posted_on)`.
   - `ledger_balances` — `bank_id text not null default ''`, `account_id text not null`, `account_kind text not null check (…)`, `kind text not null check (kind in ('ledger','available'))`, `as_of date not null`, `balance_cents bigint not null`, `currency char(3) not null default 'BRL'`, `unique (organization_id, bank_id, account_id, account_kind, kind, as_of)` — `bank_id` é `not null default ''` justamente para o `unique` funcionar em cartão (o PG17 é `NULLS DISTINCT` por padrão: `NULL` não deduplica).
   - `financial_obligations` — `direction text not null check (direction in ('payable','receivable'))`, `description text not null`, `amount_cents bigint not null check (amount_cents > 0)` (o sinal é a `direction`, não o valor), `currency char(3) not null default 'BRL'`, `due_on date not null`, `status text not null default 'open' check (status in ('open','paid','cancelled'))`, `paid_on date`, `paid_cents bigint check (paid_cents >= 0)`, `category_id uuid references public.ledger_categories(id) on delete set null`, `ledger_entry_id uuid references public.ledger_entries(id) on delete set null`, `reminder_sent_on date`; índice `(organization_id, status, due_on)`. Regra de negócio em constraint **separada** da de vocabulário (a lição do `calendar_appointments`): `financial_obligations_baixa_coerente check (status <> 'paid' or paid_on is not null)`.
   `comment on column` em `ledger_entries.amount_cents` ("assinado: o sinal vem do TRNAMT, nunca do TRNTYPE — OFX 2.2 §3.2.9.2"), em `external_id` ("hash de org + banco + conta + FITID; quando o banco repete ou omite FITID, cai para dia+valor+ordinal — nunca a descrição, que o banco reescreve"), em `ledger_balances` ("o caixa vem daqui, não da soma dos lançamentos: o Dono importa uma janela") e em `financial_obligations.direction` (CONTEXT: uma entrada de glossário, duas direções).
3. Copiar o bloco idêntico para `supabase/migrations/20260904000000_0209_financeiro_ofx.sql`; linha no `MANIFEST.md` após a 238.
4. Quatro entradas em `PROVA_PROPRIA` de `rls-completude-varredura.test.ts`, cada uma citando `tests/invariants/financeiro-schema.test.ts` e a razão (escrita exige `manager`; o usuário semeado em `rls-isolation` é `agent`). **`DEBITO_CONHECIDO` é lista fechada — nada da Fase 6 entra lá.**
5. **Todas as ações de audit da fase, no fim de `lib/audit/actions.ts`, num commit só**: `financeiro.extrato_importado`, `financeiro.categoria_salva`, `financeiro.obrigacao_criada`, `financeiro.obrigacao_alterada`, `financeiro.lembrete_enviado`. Nenhuma outra tarefa toca este arquivo.
6. Verde em `pnpm test:db`. Commit: `feat(db): the cash book, its balances, categories and dated obligations`.

---

## Parte C — Importar

### Tarefa 3 — `lib/financeiro/importar.ts`: do arquivo às linhas, sem duplicar

**Arquivos:** novos `lib/financeiro/importar.ts`, `importar.test.ts`, `chave.ts`, `categorizar.ts`, `categorizar.test.ts`. Depende das Tarefas 1 e 2.

1. `chave.ts` — `externalIdDe(orgId: string, chaveBruta: string): string` = `createHash("sha256").update(orgId + "|" + chaveBruta).digest("hex")`. Teste: determinística; orgs diferentes nunca colidem.
2. `categorizar.ts` — `categoriaDe(descricao, categorias): string | null`: casa por termo em `match_terms`, sem acento e sem caixa (`normalize("NFD").replace(/\p{Diacritic}/gu,"").toUpperCase()`), **desempate determinístico pelo `slug` em ordem alfabética**, `null` quando nada casa. O teste inclui o desempate — dado que decide dinheiro não pode depender da ordem do `select`.
3. `importar.ts` — `importarExtrato(admin, { organizationId, buffer, nomeDoArquivo })` → `ResumoDaImportacao`:
   ```ts
   export interface ResumoDaImportacao {
     total_lancamentos: number; importados: number; duplicados: number;
     por_conteudo: number;                       // key_source 'conteudo': o modo frágil, visível (decisão 6)
     saldos_gravados: number; descartados: { motivo: string; contexto: string }[];
     contas: { bank_id: string; account_id: string; account_kind: string; lancamentos: number }[];
   }
   ```
   Insert **linha a linha**, como o import de contatos e pelo mesmo motivo declarado lá (lote vira tudo-ou-nada por causa do índice único); `23505` capturado conta como `duplicados`, nunca erro. `ledger_balances` por `upsert` com `onConflict: "organization_id,bank_id,account_id,account_kind,kind,as_of"`. Categoria resolvida na hora do insert. Teto `OFX_MAX_LANCAMENTOS` recusa com mensagem que ensina. `audit({ action: "financeiro.extrato_importado", … })` **dentro da lib**.
4. Teste com admin falso: as fixtures da Tarefa 1 produzem os números esperados; **a segunda chamada com o mesmo buffer devolve `importados: 0` e `duplicados: n`** — a asserção que a issue nomeia; `fitid-repetido.ofx` cai para `key_source: "conteudo"`, importa as duas linhas e reporta `por_conteudo: 2`; **reimportar `fitid-repetido.ofx` com o `MEMO` trocado ainda devolve `importados: 0`** — é o teste que trava a decisão 6; `caixa-decimal-quebrado.ofx` põe a linha em `descartados` e **não** grava zero.
5. Commit: `feat(financeiro): import an OFX statement, twice, without duplicating it`.

### Tarefa 4 — A rota e o handler extraído

**Arquivos:** novos `app/api/v1/financeiro/extratos/_handler.ts`, `app/api/v1/financeiro/extratos/route.ts`, `tests/unit/financeiro-import-rota.test.ts`. Depende da Tarefa 3.

**Por que o handler sai da rota:** a prova de realidade (Tarefa 9) roda em vitest, onde `requireRole` → `loadAuthUser` → `cookies()` de `next/headers` não existe; a prova da agenda só alcança handlers extraídos (`app/api/v1/agenda/agendamentos/_handler.ts`) ou rotas de cron por Bearer. Sem a extração, a Tarefa 9 morre com 401 na primeira asserção.

1. `_handler.ts` — `importarExtratoHandler(admin, { organizationId, requestId }, file: File): Promise<Response>`: valida extensão (`.ofx`) e tipo (`text/plain`, `application/x-ofx`), `> OFX_MAX_BYTES` → **413** `payload_too_large`, conteúdo ilegível → **422** `validation_failed` com a mensagem que ensina a exportar do banco, sucesso → `ok(resumo, { requestId })`. Recebe o **admin client** (a lib escreve por service role) e o `organizationId` já resolvido.
2. `route.ts` — só autentica e delega: `requireRole("manager", { requestId, resource: "ledger_entries" })` (é dinheiro: `manager`, não `agent`), `const orgId = authz.org.orgId` — **nunca do body**, que é a regra do service role no `CLAUDE.md` —, `createAdminClient()`, `form.get("file")` no molde de `app/api/v1/contacts/import/route.ts`, e chama o handler.
3. Testes no molde de `tests/unit/ads-api.test.ts` (mock de `@/lib/auth/require-role`, `@/lib/audit` e admin client): 413, 422, sucesso, papel `agent` recusado, e `organization_id` do body ignorado.
4. Commit: `feat(api): upload an OFX statement from the Financeiro screen`.

---

## Parte D — Caixa e obrigações

### Tarefa 5 — `lib/financeiro/caixa.ts`: o saldo que não mente

**Arquivos:** novos `lib/financeiro/caixa.ts`, `caixa.test.ts`, `vencimentos.ts`, `vencimentos.test.ts`. Módulos **puros** — recebem linhas, devolvem números; nada de Supabase. Depende da Tarefa 1 (os tipos `ContaKind`/`SaldoOfx` vêm de `lib/financeiro/ofx/tipos.ts`).

1. `caixa.ts` — `calcularCaixa({ saldos, lancamentos }): ResultadoDeCaixa`, no espírito de `lib/ads/sobra.ts`:
   ```ts
   export interface SaldoDaConta {
     bankId: string; acctId: string; kind: ContaKind;
     saldoCents: number | null; saldoEm: string | null;      // null = nunca importado
     lancamentosDepois: number; somaDepoisCents: number;
     saldoEstimadoCents: number | null; incompleto: boolean;
   }
   export interface ResultadoDeCaixa { contas: SaldoDaConta[]; totalCents: number | null; incompleto: boolean }
   ```
   `totalCents` é `null` se **qualquer** conta estiver incompleta — meia verdade sobre caixa é pior que "não sei". Teste: conta com saldo e dois lançamentos posteriores; conta sem saldo → incompleta e total `null`; **lançamento no mesmo dia do `DTASOF` não é somado de novo** (já está no saldo do banco) — a armadilha, e o teste que a nomeia.
2. `vencimentos.ts` — `vencimentosDoDia(obrigacoes, hoje: string)` → `{ vencemHoje, vencidas, proximos7 }`, cada um com lista e total por `direction`. Só `status: 'open'`. `hoje` entra como `"YYYY-MM-DD"` já resolvido pelo chamador — **nunca `new Date()` dentro do módulo**.
3. Commit: `feat(financeiro): cash on hand comes from the bank's own balance`.

### Tarefa 6 — Rotas de categorias, obrigações e caixa

**Arquivos:** novos `app/api/v1/financeiro/categorias/route.ts`, `obrigacoes/route.ts`, `obrigacoes/[id]/route.ts`, `caixa/route.ts`, `tests/unit/financeiro-rotas.test.ts`. Depende das Tarefas 2 e 5. **Não toca `lib/audit/actions.ts`** — as ações já existem desde a Tarefa 2.

Molde: `app/api/v1/ads/conta/route.ts` (rotas) e `tests/unit/ads-api.test.ts` (testes). `requireRole("manager")` para escrita, `requireRole("viewer")` para os GET; Zod com **os mesmos limites dos CHECK** (422 em vez de 500 de constraint); `createAdminClient()` com `organization_id` do gate; `audit()` em toda mutação. `GET /caixa` monta `calcularCaixa` a partir do banco e devolve também `vencimentosDoDia`. Commit: `feat(api): categories, dated obligations and the cash endpoint`.

---

## Parte E — O lembrete

### Tarefa 7 — Cron `financeiro-lembretes`

**Arquivos:** novos `lib/financeiro/lembretes.ts`, `lembretes.test.ts`, `app/api/v1/cron/financeiro-lembretes/route.ts`; edita `docker/scheduler/entrypoint.sh`, `lib/rotinas/esperadas.ts`. Depende das Tarefas 2 e 5. **Não toca `lib/audit/actions.ts`.**

1. `enviarLembretesDeVencimento(admin, { hoje })`: para cada organização com obrigação `open` vencendo hoje ou já vencida e **`reminder_sent_on is null or reminder_sent_on <> hoje`** — em PostgREST, `.or("reminder_sent_on.is.null,reminder_sent_on.neq.<hoje>")`. O `is null` não é detalhe: a coluna nasce nula, e `NULL <> '2026-09-02'` é `NULL`, que o `WHERE` descarta — sem ele **a primeira rodada nunca manda nada**, e o modo de falha é mudo (200, `job_runs` `ok`, zero candidatos). Caso de teste com esse nome: *"obrigação nunca lembrada entra na primeira rodada"*.
   Monta **um** texto curto por Conta e manda por `enviarAoDono(admin, orgId, texto)` — o helper da Fase 5, que nunca lança e devolve `{ ok: false, motivo }`. Texto no molde do vigia (`lib/rotinas/vigia.ts`): direto, sem instrução de operador, valores por `formatCentsBRL` de `lib/money.ts`, no máximo cinco itens e um "e mais N". Marca `reminder_sent_on = hoje` **só quando o envio deu certo** (a lição do lembrete da agenda: falha de envio não marca). `{ dryRun: true }` devolve os candidatos sem enviar nem marcar. `audit({ action: "financeiro.lembrete_enviado" })` **por Conta**, sob `if` — rodada sem vencimento não audita.
2. Rota no molde de `app/api/v1/cron/clinica-vigia/route.ts`: bloco Bearer inline, `createAdminClient()`, `export const GET = comExecucaoDeRotina("financeiro-lembretes", handle)`, `export const dynamic = "force-dynamic"`. Linha `20 7 * * *|120|api/v1/cron/financeiro-lembretes` em `CRONS` (07:20 está livre; o vizinho é `0 7 * * *` do `ads-agent`, e a intenção é falar antes do relatório das 8h da Fase 7). Entrada `{ nome: "financeiro-lembretes", periodoMinutos: 1440 }` em `ROTINAS_ESPERADAS`.
3. `pnpm vitest run lib/financeiro/lembretes lib/rotinas tests/unit/cron-routes-scheduled tests/unit/cron-routes-registram-execucao tests/unit/cron-audita-so-quando-ha-efeito` e `pnpm test:shell` (DoD item 6: tocou o scheduler). Commit: `feat(financeiro): the owner hears about what is due today`.

---

## Parte F — A tela

### Tarefa 8 — `/app/financeiro`

**Arquivos:** novos `app/app/financeiro/page.tsx`, `loading.tsx`, `_client.tsx`, `hooks/financeiro/useFinanceiro.ts`, `components/financeiro/ImportarExtratoDialog.tsx`, `tests/unit/financeiro-tela.test.tsx`; edita `lib/navigation/registry.ts` e `lib/i18n/dicionario.ts`. Depende das Tarefas 4 e 6.

Molde exato: a tela Anúncios da Fase 5 — `page.tsx` Server Component com `requireAuth` + `resolveActiveOrg` + gate `manager` (`redirect("/403")`), `loading.tsx` só de `Skeleton`, `_client.tsx` em **blocos exportados com props** (`CaixaPorConta`, `VencimentosDoDia`, `ContasCadastradas`, `UltimosLancamentos`) e o `FinanceiroClient` no fim só fiando os hooks — assim cada bloco é testável sem servidor. O diálogo de importação copia `components/contacts/ImportContactsDialog.tsx`: `fetch` cru com `FormData` (o `apiClient` não fala multipart), **não fecha sozinho**, e mostra o resumo com a lista rolável dos descartados. O caixa mostra **a data do saldo** e a palavra "incompleto" quando a conta nunca teve saldo lido; a contagem `por_conteudo` aparece como aviso quando > 0 (decisão 6).

**i18n:** o gate `tests/unit/i18n-espanhol-cobre-a-tela.test.ts` varre `JsxText`, `StringLiteral` e `NoSubstitutionTemplateLiteral` — **template literal com interpolação escapa da cerca**. Nada de `` `${total} lidos · ${importados} importados` ``: cada palavra passa por `t()` de propósito, senão a tela vai para produção sem espanhol e o gate fica verde. Porta em `registry.ts` no grupo `analise`, `minRole: "manager"`, sem `sidebar` (como Anúncios entrou). Gates: `pnpm vitest run tests/unit/financeiro-tela tests/unit/i18n-espanhol-cobre-a-tela tests/unit/navegacao-completude`. Commit: `feat(financeiro): the Financeiro screen — import, cash, and what is due`.

---

## Parte G — Prova e gates

### Tarefa 9 — `tests/prova/financeiro.prova.ts`

**Arquivos:** novos `tests/prova/financeiro.prova.ts`, `scripts/prova-financeiro.ts`. Depende das Tarefas 2, 4, 5 e 7.

Molde: `tests/prova/ads.prova.ts` (imports dinâmicos, `afirmar`/`passo` de `scripts/lib/prova`, `credenciaisSupabaseDeTeste()` de `scripts/lib/env-de-teste`), com `scripts/prova-financeiro.ts` como casca de 17 linhas chamando o vitest com `vitest.prova.config.ts`. Sequência: semeia uma Conta com `settings.dono.whatsapp` e sessão `fake_channel` (`garantirSessaoFake`); chama `importarExtratoHandler` (o **handler extraído** da Tarefa 4) com um `File` carregando a fixture; afirma o resumo; chama **de novo** e afirma `importados: 0`; afirma `calcularCaixa` a partir do banco; cadastra duas obrigações vencendo hoje; roda `enviarLembretesDeVencimento` e afirma o texto na caixa de saída fake (`lerEnviados` de `lib/channels/fake/caixa.ts`) e `reminder_sent_on` marcado; roda de novo e afirma que **não** reenvia. Limpa a org no fim. Commit: `test(prova): importing the same statement twice changes nothing`.

### Tarefa 10 — Gates, issue, PR

1. `pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit --maxWorkers=3 && pnpm test:shell && pnpm build && pnpm test:db`, cada um redirecionado para arquivo, lendo o rodapé (`Test Files` / `Tests`). `test:shell` tem um vermelho pré-existente (apóstrofo no macOS) — aceitável e declarado.
2. **Antes de colar rodapé**: comentar na #24 registrando o argumento de licença da decisão 2 e como o critério "OFX real anonimizado" se cumpre pelo HITL (o arquivo do José entra em `tests/fixtures/ofx/`, que o teste varre).
3. Rodar `pnpm vitest run lib/financeiro` (a prova literal da issue) e `pnpm tsx scripts/prova-financeiro.ts`; colar os rodapés em #24.
4. PR para `main` no formato `## Resumo / ## Mudanças / ## Testes / ## Checklist`, **sem** `Closes #24`: a fase fecha com o HITL.
5. Registrar os desvios no fim deste plano e commitar. Um já é conhecido: a issue diz "Lembrete ao Dono via `crm_send_whatsapp_message`" e usamos `enviarAoDono`, que termina no mesmo `sendMessageHandler` mas já resolve contato, conversa e sessão.

---

## O que este plano não faz

Não toca `paid_cents` da agenda nem qualquer coisa de receita por paciente (ADR-0017). Não toca `lib/agent-engine/`, `inbound-turn.ts` nem `lib/channels/`. Não cria env var. Não conecta banco por API nem Open Finance (ADR-0008). Não faz conciliação automática entre lançamento e obrigação — a baixa é manual pela tela, e `ledger_entry_id` existe para quando a conciliação nascer. Não lê OFX de investimento (`INVSTMTMSGSRSV1`), que é outra ordem de grandeza de spec. Não monta o Relatório das 8h — a Fase 7 consome `calcularCaixa` e `vencimentosDoDia` e nunca recalcula. Não cria tabela `payables` nem `receivables` separadas (decisão 4). Não versiona extrato de terceiro sem licença (decisão 2).

---

## Desvios registrados na execução (02/09/2026)

**Dois defeitos reais que a execução encontrou e o plano não previa.**

- **O Lembrete acordaria o Dono às 4h20.** O plano marcava `20 7 * * *`, e o contêiner do scheduler roda com `TZ: UTC` (`docker-compose.prod.yml:222`): 07:20 UTC é 04:20 em Brasília. Movido para `20 10 * * *` (07:20 no horário do Dono), com o porquê comentado no `entrypoint.sh`. **O mesmo defeito existe na Fase 5, já mergeada**: `ads-agent` roda `0 7 * * *` = 04:00 no Brasil e também termina em `enviarAoDono`. Não corrigido aqui — é arquivo de outra fase.
- **`pnpm build` ficou vermelho por causa da própria sintaxe do OFX.** O extrator do Tailwind varre com regex e trata qualquer `[algo:algo]` como propriedade arbitrária: a sintaxe de fuso `[-3:BRT]`, documentada em `lib/financeiro/ofx/normalizar.ts` e usada como fixture nos testes, virava `.\[-3\:BRT\] { -3: BRT; }` no `globals.css`. Curado estreitando o `content` do `tailwind.config.ts` para o que pode conter classe (teste nenhum renderiza CSS de produção; o parser de OFX não tem uma linha de JSX), com a medição no comentário.

**Acréscimo de escopo.** A Tarefa 6 constatou que nenhuma rota listava `ledger_entries`, e o bloco `UltimosLancamentos` precisava. `GET /api/v1/financeiro/lancamentos` entrou na Tarefa 8 — quem constrói a tela conhece o contrato de que ela precisa.

**Schema (Tarefa 2).** UUID de seed do invariante virou `fc600000-…`: o plano propunha `fi600000-…` e `i` não é hexadecimal. A `unique` de `ledger_balances` ganhou nome explícito (`ledger_balances_conta_tipo_dia_key`) — o automático passaria de 63 caracteres e o Postgres o truncaria, e o invariante casa a constraint pelo nome.

**Parser (Tarefa 1).** `saldo_ilegivel` cobre também `DTASOF` ilegível (mesmo desfecho, distinguido pelo `contexto`). `OFX_MAX_LANCAMENTOS` trunca com um `descartado` em vez de lançar: já há resultado parcial útil, e recusar o arquivo inteiro perderia o extrato do Dono. O tokenizer faz uma pré-varredura das tags fechadas para desambiguar folha vazia de agregado — sem isso um `<MEMO>` vazio engoliria o `<FITID>` seguinte **em silêncio**, e a transação perderia a chave. `chaveOrigem` é decidida sobre **todas** as transações da conta, inclusive as descartadas: honrar o `FITID` é propriedade do arquivo do banco, não do subconjunto que sobreviveu ao parse.

**Importação (Tarefa 3).** `por_conteudo` conta o **arquivo**, não o que entrou — na reimportação nada entra, e o Dono continua precisando saber que aquela conta está frágil. `categoriaDe` devolve o `id` (o `slug` já está gasto como critério de desempate). `OpcoesDaImportacao` ganhou `requestId?`/`actorUserId?`, senão o audit nasceria sem correlação nem autor. Erro de insert que não é `23505` vira `descartado`, não derruba o arquivo. Saldos são deduplicados antes do upsert (dois saldos iguais no mesmo comando fazem o Postgres recusar o lote inteiro).

**Rota de upload (Tarefa 4).** A checagem de conteúdo é `lerCabecalho` **antes** de `importarExtrato`, não um `try/catch` em volta: embrulhar tudo em 422 faria uma queda do Postgres sair para o Dono como "seu extrato está corrompido", e ele passaria a tarde reexportando um arquivo certo. O teste roda em ambiente `node`, não jsdom — medido: no jsdom o `instanceof File` da rota (o `File` do undici) nunca casa, e **todos** os casos passariam provando o contrário do que afirmam.

**Rotas CRUD (Tarefa 6).** `PUT` em `/categorias`, não `POST`: a identidade é o `slug` e a gravação é upsert. `proximos7` virou `proximos_7_dias` no fio (JSON é snake_case). `direction` não é alterável no `PATCH` — trocá-la moveria dinheiro de lado no Relatório sem registro. `ledger_entry_id` fica fora da API inteira enquanto a conciliação não nascer.

**Cron (Tarefa 7).** `diaCorrenteUtc` resolve o dia em UTC; às 10:20 UTC o Brasil está no mesmo dia civil, mas **a função vira o dia às 21h locais** — quem a chamar à noite (uma tela, a Fase 7) vê "hoje" um dia à frente. Registrado, não corrigido: resolver por `organizations.timezone` é fase futura. Falha do `UPDATE` da marca não derruba a rodada — lançar calaria o lembrete de todas as outras Contas por causa do erro de banco de uma.

**Caixa (Tarefa 5).** Interfaces de entrada em camelCase, como `lib/ads/sobra.ts`; o mapeamento das linhas snake_case fica com quem lê o banco. `proximos7` é disjunto de `vencemHoje` — sobrepor faria a tela somar o mesmo boleto duas vezes.

**Tela (Tarefa 8).** A baixa mora em `ContasCadastradas` e `VencimentosDoDia` é só leitura: o botão nos dois lugares duplicaria a ação sobre a mesma linha. Direção da conta é um par de botões e não um `Select` do Radix, que o jsdom não consegue exercitar — com botões o bloco fica testável de verdade.

**Texto da issue.** A #24 diz "Lembrete ao Dono via `crm_send_whatsapp_message`"; usamos `enviarAoDono`, que termina no mesmo `sendMessageHandler` mas já resolve contato, conversa e sessão.
