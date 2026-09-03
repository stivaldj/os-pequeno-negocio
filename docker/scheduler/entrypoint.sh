#!/bin/sh
# Entrypoint do deskcomm-scheduler: escreve o crontab e entrega o PID 1 ao crond.
#
# Por que gerar em runtime em vez de assar o arquivo na imagem: o INTERNAL_SECRET
# só existe no .env do cliente, e o busybox crond não expande variáveis dentro da
# linha do cron. Então a expansão acontece aqui, uma vez, no start.
#
# O que MUDOU em relação ao `command:` inline do compose: não há mais
# `apk add --no-cache curl tzdata` a cada start. curl e tzdata vêm na imagem. O
# cron do cliente deixa de depender de a VPS ter internet e de o mirror do Alpine
# estar de pé no momento de um restart — que é justamente o momento em que a
# máquina está se recuperando de alguma coisa.
set -eu

if [ -z "${INTERNAL_SECRET:-}" ]; then
  echo "scheduler: INTERNAL_SECRET vazio — os crons responderiam 401 em silêncio." >&2
  echo "scheduler: confira a chave no .env e suba de novo." >&2
  exit 1
fi

# Constante, não configuração: `app` é o nome do serviço na rede interna do
# compose, e o scheduler não fala com mais nada. A primeira versão disto lia um
# `SCHEDULER_APP_ORIGIN` que o compose nunca repassava e nenhum template
# documentava — controle decorativo, que é pior que controle nenhum: quem o
# encontrasse no código o definiria no `.env` e não veria efeito.
APP_ORIGIN="http://app:3000"

# O crond executa cada linha por `/bin/sh -c`, então o segredo é REAVALIADO pelo
# shell na hora de disparar. Interpolá-lo cru dentro de aspas duplas fazia com
# que um `$` no valor virasse expansão de variável (o header sairia truncado, e
# todo cron responderia 401 em silêncio) e uma crase virasse substituição de
# comando — execução arbitrária a cada minuto. Medido com um segredo hostil: a
# versão com aspas duplas entregava `segrafaelmelgacoredo/Users/rafaelmelgaco…`,
# com o `whoami` EXECUTADO. Aqui o valor vai entre aspas SIMPLES, com as aspas
# simples internas escapadas — dentro delas o sh não interpreta nada.
SEGREDO_SEGURO="$(printf '%s' "$INTERNAL_SECRET" | sed "s/'/'\\\\''/g")"

# minuto|timeout|caminho — uma linha por cron. O caminho vai COMPLETO de
# propósito: o literal `api/v1/cron/<rota>` é o contrato que
# tests/unit/cron-routes-scheduled.test.ts (e mais dois) leem por grep — esse
# teste compara a lista com o diretório app/api/v1/cron, e rota criada sem
# agendamento reprova o CI.
# A agenda do Google entra com DUAS cadências, e elas são diferentes de propósito.
#
# RENOVAÇÃO a cada 10 min: o access_token do Google expira em cerca de 1h, e a
# rodada só renova quem está a menos de 15 min do vencimento. Dez minutos deixa
# pelo menos uma tentativa de folga dentro da janela — a 15 min, um tick atrasado
# já deixaria o token vencer. É barata: só toca conexão perto de expirar, e
# rodada vazia não audita.
#
# SYNC a cada 15 min, e NÃO na mesma cadência. Os custos são diferentes: renovar
# é uma requisição por conexão que está vencendo; sincronizar é uma por
# calendário, sempre. Colar as duas obrigaria a escolher entre renovar raro
# demais (e a agenda morre) ou sincronizar caro demais (e gasta cota do cliente).
#
# O LEMBRETE DE VENCIMENTO às 07:20, e não em qualquer horário da madrugada: o
# Dono precisa saber o que vence hoje ANTES de o dia começar, e antes do
# Relatório das 8h. 07:20 está livre — o vizinho mais próximo é o ads-agent das
# 07:00, e os dois falam com o mesmo WhatsApp; vinte minutos de folga evitam
# que as duas mensagens cheguem coladas.
#
# ⚠️ E o comentário fica AQUI, fora da string: dentro de CRONS= ele não seria
# comentário, seria DADO — e crase em prosa dentro de aspas duplas o shell
# EXECUTA. Foi o que quebrou o entrypoint na primeira tentativa desta linha.
CRONS="
* * * * *|25|api/v1/cron/followup-flow-worker
* * * * *|45|api/v1/cron/event-log-drain
* * * * *|25|api/v1/cron/routing-worker
* * * * *|25|api/v1/cron/recover-stuck-messages
*/5 * * * *|25|api/v1/cron/storage-redaction?limit=50
*/5 * * * *|25|api/v1/cron/snooze-watcher
*/5 * * * *|25|api/v1/cron/attendant-heartbeat
*/5 * * * *|60|api/v1/cron/webhook-log-retention
*/5 * * * *|45|api/v1/cron/channel-health
*/10 * * * *|60|api/v1/cron/contact-avatars
*/10 * * * *|60|api/v1/cron/agenda-google-refresh
*/15 * * * *|90|api/v1/cron/agenda-google-sync
# A IDA. Cadência mais curta que a volta de propósito: quem marcou pela tela
# espera ver o compromisso no celular dele em minutos, e a ida é barata (só
# manda o que mudou). A volta é cara — varre calendário inteiro — e por isso
# roda a cada 15.
*/5 * * * *|60|api/v1/cron/agenda-google-push
*/10 * * * *|60|api/v1/cron/agenda-lembretes
*/15 * * * *|60|api/v1/cron/risk-watcher
*/30 * * * *|60|api/v1/cron/contact-phones
17 * * * *|60|api/v1/cron/contact-proposals-watcher
0 12 * * *|60|api/v1/cron/lgpd-sla-watcher
30 3 * * *|120|api/v1/cron/kb-conversations-batch
15 4 * * *|60|api/v1/cron/sync-model-catalog
40 4 * * *|120|api/v1/cron/data-retention
7 * * * *|60|api/v1/cron/rotinas-vigia
23 * * * *|60|api/v1/cron/clinica-vigia
10 3 * * *|120|api/v1/cron/ads-spend-sync
# O resumo diário do Agente de Anúncios cai no WhatsApp do Dono: rodar.ts
# termina em enviarAoDono SEMPRE — até rodada sem proposta manda uma linha.
# Por isso o horário aqui é hora de acordar alguém, não detalhe de operação.
# Este contêiner roda com TZ: UTC (docker-compose.prod.yml), então 10:00 UTC
# é 07:00 em Brasília. Estava em 07:00 UTC, que é 04:00 no Brasil — a rodada
# funcionava e o Dono acordava com ela. Fica depois do ads-spend-sync (03:10
# UTC), que é de onde vem o gasto do dia anterior, e uma hora antes do
# relatório das 8h da Fase 7, que lê as propostas desta rodada.
0 10 * * *|120|api/v1/cron/ads-agent
40 3 * * *|120|api/v1/cron/ads-conversion-upload
# Lembrete de vencimento ao Dono. O horario e UTC porque este container roda
# com TZ: UTC (docker-compose.prod.yml): 10:20 UTC e 07:20 em Brasilia. A
# versao anterior deste plano dizia 07:20 e teria disparado 04:20 no Brasil,
# acordando o Dono de madrugada. Fica antes do relatorio das 8h da Fase 7.
20 10 * * *|120|api/v1/cron/financeiro-lembretes
"

# CRONTAB_PATH é ponto de injeção do teste (tests/shell/scheduler-entrypoint.test.sh).
# Sem ele este script só seria exercitável dentro de um contêiner — e o único
# artefato executável novo desta entrega ficaria sem gate nenhum, que foi
# exatamente o achado da revisão adversarial.
DESTINO="${CRONTAB_PATH:-/etc/crontabs/root}"

umask 077
: > "$DESTINO"
echo "$CRONS" | while IFS='|' read -r quando timeout rota; do
  [ -n "$rota" ] || continue
  printf '%s curl -fsS -m%s -H '"'"'Authorization: Bearer %s'"'"' "%s/%s" >/dev/null 2>&1\n' \
    "$quando" "$timeout" "$SEGREDO_SEGURO" "$APP_ORIGIN" "$rota" >> "$DESTINO"
done

exec crond -f -l 2
