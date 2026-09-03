# Runbook — Ligar o ciclo de release no fork

O `release.yml` reprova em **todo** push para a `main` desde que o fork nasceu, e
por um motivo banal: ele autentica com um GitHub App que existe no repositório do
autor e **não** neste. Sem os dois segredos, o primeiro passo dos dois jobs morre
em 9 segundos.

Este runbook é a lista de cliques que resolve. Não dá para automatizar: criar um
GitHub App e gravar chave privada são atos de administrador da conta, e nenhum
agente faz isso por você — nem deveria.

Contexto da decisão: [`docs/doctrine/packaging.md`](../doctrine/packaging.md).
Deploy do outro lado da cadeia: [`deploy.md`](./deploy.md).

---

## Sintoma

```
Error: The 'client-id' (or deprecated 'app-id') input must be set to a non-empty string.
    actions/create-github-app-token@v3
```

Job `cortar-tag` do workflow `release`, vermelho em todos os merges.

## Diagnóstico

```bash
gh api repos/<owner>/<repo>/actions/secrets --jq '.total_count'   # 0 = é isto
```

O `release.yml` pede `secrets.RELEASE_APP_ID` e `secrets.RELEASE_APP_PRIVATE_KEY`
nas linhas 41-42 e 100-101. Sem eles, nenhum dos dois atos do ciclo acontece.

### Por que isso custa caro, e não é só um X vermelho

**A tag não nasce, e sem tag nada chega ao parque.** O ato 2 do workflow é quem
cria `vX.Y.Z`, e é a tag que dispara o `publish-image.yml`. Sem imagem no GHCR, a
VPS instalada não atualiza — e a doutrina de packaging manda a instalação apontar
para número de versão, nunca para tag móvel. Hoje o dano é invisível só porque
nenhum merge recente foi um corte de release.

**Vermelho permanente ensina a ignorar vermelho.** Enquanto o `release` reprovar
por configuração, uma reprovação real dele passa despercebida.

## Ação

### 0. Antes de tudo: a conta precisa estar paga

Se o Actions estiver bloqueado por billing, os jobs nem começam — a anotação diz
`The job was not started because recent account payments have failed`. Nesse
estado os segredos abaixo não mudam nada, porque nada roda. Resolva o billing
primeiro, em **Settings › Billing & plans**, e só então siga.

### 1. Criar o GitHub App

**Settings › Developer settings › GitHub Apps › New GitHub App**

| Campo | Valor |
| --- | --- |
| Nome | `os-pequeno-negocio-release` (qualquer nome livre serve) |
| Homepage URL | a URL do repositório |
| Webhook | **desmarcar "Active"** — o App não recebe evento, só assina requisição |

**Repository permissions** — exatamente duas, e nada além:

| Permissão | Nível | Para quê |
| --- | --- | --- |
| **Contents** | Read and write | `git push` da branch `release/X.Y.Z`, da tag `vX.Y.Z` e o `gh release create` |
| **Pull requests** | Read and write | o `gh pr create` do ato 1 |

Em **Where can this GitHub App be installed?** deixe *Only on this account*.

### 2. Instalar o App no repositório

Na página do App: **Install App** → sua conta → **Only select repositories** →
marcar apenas este repositório. App instalado em repositório errado é escopo de
escrita dado de graça.

### 3. Gerar a chave privada

Ainda na página do App: **General › Private keys › Generate a private key**.
Baixa um `.pem`. Anote também o **App ID**, que aparece no topo da mesma página.

### 4. Gravar os dois segredos

**Repositório › Settings › Secrets and variables › Actions › New repository secret**

| Nome | Conteúdo |
| --- | --- |
| `RELEASE_APP_ID` | o App ID (só dígitos) |
| `RELEASE_APP_PRIVATE_KEY` | o **conteúdo inteiro** do `.pem`, incluindo as linhas `-----BEGIN…` e `-----END…` |

⚠️ O `.pem` tem de entrar com as quebras de linha preservadas — cole o arquivo
inteiro, não uma linha só. Depois de colar, **apague o `.pem` do disco**: ele é
credencial, e o segredo do GitHub já é a cópia que importa.

### 5. Apagar o `.pem` e conferir

```bash
rm ~/Downloads/*.private-key.pem
gh api repos/<owner>/<repo>/actions/secrets --jq '.total_count'   # esperado: 2
```

## Verificação

O critério é o último run do `release` na `main` concluir `success` — o que exige
um push qualquer para a `main` depois dos segredos gravados:

```bash
gh run list --workflow release --branch main --limit 1 --json conclusion --jq '.[0].conclusion' | grep -qx success
```

Não confunda com "o ciclo funciona". Verde aqui só diz que o App autentica e que
o job decidiu `cortar=nao`. A cadeia inteira só está provada quando um corte de
verdade atravessar:

1. **Run workflow** no `release` → abre o PR de release lendo `.changes/`;
2. merge desse PR → nasce a tag `vX.Y.Z` e a release no GitHub;
3. a tag dispara o `publish-image.yml`;
4. o passo "As três imagens existem nesta versão?" responde 200 para
   `deskcommcrm`, `deskcomm-worker` e `deskcomm-scheduler` no GHCR.

O passo 4 existe porque o ato 2 **não confia**: ele espera a publicação e confere,
falhando alto se as imagens não aparecerem.

## O que NÃO fazer

**Não troque o App pelo `GITHUB_TOKEN`.** É a saída óbvia e é uma armadilha
documentada pelo próprio GitHub: evento disparado com o `GITHUB_TOKEN` não cria
novo workflow run. A tag nasceria, ninguém veria erro, e o `publish-image.yml`
jamais rodaria — falha silenciosa, descoberta só quando um cliente tentasse
atualizar. O comentário no topo do `release.yml` diz isso; este parágrafo existe
porque a tentação reaparece toda vez que alguém vê o vermelho.

**Não apague o gatilho `push: branches: [main]`** para o vermelho sumir. Ele é
quem denuncia; sem ele o ciclo continua morto, agora em silêncio.

**Não suba `permissions:` no topo do workflow.** Todo escopo de escrita vem do
App justamente para o `GITHUB_TOKEN` seguir com `contents: read` — é o que mantém
`tests/unit/workflows-tem-permissions.test.ts` sem entrada nova.

## Pós-mortem

O fork herdou um workflow que depende de segredo, e segredo não atravessa fork.
Vale como lembrete geral: ao herdar CI, a primeira pergunta é *de que segredos
isto depende*, e a resposta se confere com `gh api .../actions/secrets`, não com
leitura do YAML.
