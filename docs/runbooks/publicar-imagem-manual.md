# Runbook — Publicar imagem manualmente, sem o Actions

O caminho normal de release **não builda nada localmente**: `release.yml` corta a
tag, `publish-image.yml` builda as três imagens nos runners do GitHub e publica
no GHCR, e a VPS só puxa (`docs/runbooks/deploy.md`). Este runbook é a exceção —
o que fazer quando o Actions está fora do ar (cota estourada, billing, ou o
próprio `release` quebrado — ver `docs/runbooks/ativar-release.md`) e uma versão
nova precisa sair mesmo assim.

**Isto é emergência, não substituto permanente.** Builda do seu computador, exige
Docker Desktop com Buildx (já vem por padrão), e pula o gate que o PR normalmente
passa (`invariants`, `e2e`, `imagem-do-app-sobe`) — rode a suíte local
(`pnpm test:db && pnpm build`) antes de publicar, ou você está entregando ao
parque instalado algo que nunca foi provado.

---

## Sintoma

`gh run list --workflow release` ou `publish-image` só mostra `failure`, e a
causa não é o código — é a conta (billing, cota de minutos, ou os segredos do
`release.yml` ainda não configurados). Uma versão nova (correção urgente, fase
que acabou de fechar) precisa chegar à VPS da clínica e não há como esperar o
Actions voltar.

## Diagnóstico

```bash
gh api repos/stivaldj/os-pequeno-negocio/actions/secrets --jq '.total_count'
gh run list --limit 5 --json conclusion,name --jq '.[] | "\(.conclusion // "—")  \(.name)"'
```

Se **todo** workflow reprova em segundos (não só o `release`), é conta parada —
confira Settings → Billing and plans → Actions minutes. Se só o `release` cai no
passo do App token, é o cenário de `ativar-release.md`. Os dois têm a mesma
saída aqui: builda e publica manual, e cada um a seu tempo continua o conserto
de origem.

## Ação

### 0. As três imagens, e por que são três

`publish-image.yml` builda `deskcommcrm` (`Dockerfile`), `deskcomm-worker`
(`Dockerfile.worker`) e `deskcomm-scheduler` (`Dockerfile.scheduler`) — as três,
sempre juntas. O worker e o scheduler entraram nessa lista por um defeito real:
um serviço sem `image:` publicada fica **build-only** no compose, e
`docker compose pull` o ignora — ele congelava no código do dia da instalação
porque nenhum `update.sh` jamais o reconstruía (`docs/doctrine/packaging.md`,
invariante 1). Publicar só o `deskcommcrm` reproduz exatamente esse defeito à
mão. As três, sempre.

### 1. Login no GHCR

Um **Personal Access Token** com escopo `write:packages` (Settings → Developer
settings → Personal access tokens). Não commite o token; se ele acabar num
arquivo por engano, revogue e gere outro.

```bash
echo "SEU_TOKEN_AQUI" | docker login ghcr.io -u stivaldj --password-stdin
```

### 2. Rode a suíte local antes de builda — não pule isto

```bash
cd "$(git rev-parse --show-toplevel)"
pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit && pnpm build && pnpm test:db
```

É o gate que `verify`, `invariants` e `e2e` fariam no PR. Publicar sem rodar
isto é o mesmo erro que o comentário de `imagem-do-app-sobe` documenta: imagem
que builda não é imagem que sobe, e "buildou" nunca foi prova de nada.

### 3. Decida o número da versão

```bash
git tag --list "v*" --sort=-v:refname | head -3
grep -A5 '## \[Não lançado\]' CHANGELOG.md
ls .changes/ 2>/dev/null
```

O `CHANGELOG.md` costuma já ter a próxima versão escrita sob um cabeçalho
`## [X.Y.Z] — <data>` que nunca foi tagueado — é o candidato natural. Se houver
arquivo em `.changes/`, ele ainda não foi dobrado no CHANGELOG por
`scripts/cortar-release.ts`; confira o campo `impacto:` dele (`nada_mudou` não
sobe versão sozinho, costuma entrar na mesma release pendente) antes de decidir
o número. Na dúvida, escreva a entrada do CHANGELOG à mão antes de seguir — a
VPS que atualiza lê essa seção para saber se precisa de atenção manual.

### 4. Build e push das três imagens

```bash
VERSAO=1.11.1   # ajuste para o número decidido no passo 3

docker buildx build --platform linux/amd64 \
  --build-arg APP_VERSION=$VERSAO \
  -f Dockerfile \
  -t ghcr.io/stivaldj/deskcommcrm:$VERSAO \
  -t ghcr.io/stivaldj/deskcommcrm:stable \
  --push .

docker buildx build --platform linux/amd64 \
  --build-arg APP_VERSION=$VERSAO \
  -f Dockerfile.worker \
  -t ghcr.io/stivaldj/deskcomm-worker:$VERSAO \
  -t ghcr.io/stivaldj/deskcomm-worker:stable \
  --push .

docker buildx build --platform linux/amd64 \
  --build-arg APP_VERSION=$VERSAO \
  -f Dockerfile.scheduler \
  -t ghcr.io/stivaldj/deskcomm-scheduler:$VERSAO \
  -t ghcr.io/stivaldj/deskcomm-scheduler:stable \
  --push .
```

Três decisões que espelham `publish-image.yml` de propósito, não por acaso:

- **`--platform linux/amd64` é obrigatório**, mesmo num Mac Apple Silicon
  (arm64 nativo). O comentário do workflow explica por quê: "o VPS HostGator e
  a imagem do WAHA são amd64" — publicar arm64 sobe uma imagem que a VPS de
  produção não roda. O Buildx cross-compila via QEMU; só fica mais lento.
- **`APP_VERSION` como build-arg**, não só como tag — é o que preenche
  `/api/v1/health` com a versão que está rodando. Sem ele, quem depurar um
  incidente vê o SHA de build em vez do número que o CHANGELOG documenta.
- **As duas tags juntas, `$VERSAO` e `stable`**, na mesma chamada — nunca duas
  chamadas separadas. `stable` é "a última release publicada"
  (`publish-image.yml` tem um comentário inteiro sobre por que ela existe
  separada de `latest`, que é o topo da `main` não lançado); publicá-las em
  momentos diferentes arrisca os dois canais apontando para digests
  diferentes por um instante, e é exatamente o defeito medido na v1.3.0 que
  fez o workflow original ganhar as três condições de `enable=` que tem hoje.

### 5. A tag do Git — a doutrina não é só sobre a imagem

```bash
git tag v$VERSAO
git push origin v$VERSAO
```

`docs/doctrine/packaging.md` (invariante 3): instalação aponta para número de
versão, nunca tag móvel. É a tag `v*` no Git que `hostgator-setup-kit/agent.sh`
lê para decidir qual é a versão mais nova disponível — sem ela, o mecanismo de
"há atualização?" do kit self-host não enxerga o que você acabou de publicar,
mesmo com a imagem certa já no GHCR.

⚠️ Taguear um commit que a `main` não contém é o que
`a-tag-veio-da-main` normalmente barra automaticamente. Sem o Actions rodando,
essa checagem não existe — confira à mão:

```bash
git merge-base --is-ancestor HEAD origin/main && echo "ok: contido na main" || echo "PARE: este commit não está na main"
```

### 6. Atualizar o CHANGELOG, se ainda não estava escrito

Se o passo 3 achou a seção já pronta, só confirme a data. Se você escreveu à
mão, mova o conteúdo de `## [Não lançado]` para `## [$VERSAO] — <hoje>` e
commite antes de taguear (o passo 5 tagueia o HEAD — a ordem importa).

### 7. Na VPS

```bash
bash hostgator-setup-kit/update.sh
```

⚠️ **Confira `APP_IMAGE`/`WORKER_IMAGE`/`SCHEDULER_IMAGE` no `.env` da VPS antes
de rodar isto.** O default do `docker-compose.prod.yml`, sem essas três
variáveis setadas, aponta para `ghcr.io/melgarafael/...` — as imagens do autor
original do fork, não as deste repositório. Uma VPS cujo `.env` nunca setou as
três vive rodando o upstream, silenciosamente, mesmo depois de todo este
runbook:

```bash
grep -E '^(APP|WORKER|SCHEDULER)_IMAGE=' .env
```

Se qualquer uma faltar, adicione apontando para `ghcr.io/stivaldj/<nome>:stable`
antes do `update.sh`.

## Verificação

```bash
curl -s https://<domínio-da-clínica>/api/v1/health | jq .version
```

Esperado: `$VERSAO`, o mesmo número do passo 3. Confira também que as três
imagens realmente chegaram ao GHCR (sonda anônima, a mesma de
`docs/runbooks/ativar-packaging.md` e do passo "As três imagens existem nesta
versão?" de `release.yml`):

```bash
for img in deskcommcrm deskcomm-worker deskcomm-scheduler; do
  t=$(curl -s "https://ghcr.io/token?scope=repository:stivaldj/$img:pull&service=ghcr.io" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  printf '%s: ' "$img"
  curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $t" \
    -H 'Accept: application/vnd.oci.image.index.v1+json' \
    "https://ghcr.io/v2/stivaldj/$img/manifests/$VERSAO"
done
```

Esperado: `200` nas três linhas.

## O que NÃO fazer

**Não pule o passo 2** (a suíte local) achando que "é só uma imagem, é rápido".
É exatamente o atalho que o comentário de `imagem-do-app-sobe` em
`publish-image.yml` existe para lembrar que já custou uma produção fora do ar.

**Não publique só uma das três imagens.** Ver passo 0 — o worker e o scheduler
build-only foi o defeito original que fez as três entrarem juntas no mesmo
workflow.

**Não pule a tag do Git** (passo 5) achando que a imagem no GHCR já basta — o
mecanismo de atualização do self-host depende dela, não só da imagem existir.

**Não vire hábito.** Assim que o Actions voltar (billing resolvido, ou os
segredos de `ativar-release.md` gravados), volte ao caminho automático — ele
tem os gates (`invariants`, `e2e`, `imagem-do-app-sobe`) que este runbook
conscientemente pula.

## Pós-mortem

Registrado em 2026-09-07, quando o Actions da conta ficou parado (cota de
minutos do plano gratuito esgotada) no meio da sequência de fases que fechou o
roadmap original (Fases 6 a 8). Nenhuma versão foi cortada por este caminho
ainda — o runbook existe pronto para quando for necessário, não como relato de
um incidente já ocorrido.
