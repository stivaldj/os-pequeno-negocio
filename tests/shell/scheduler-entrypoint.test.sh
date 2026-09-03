#!/usr/bin/env bash
# Gate do docker/scheduler/entrypoint.sh — o único artefato executável novo da
# doutrina de packaging, e o que ficou sem cobertura na primeira versão dela.
#
# O que ele guarda, e por que cada coisa:
#
# 1. O SEGREDO SOBREVIVE INTEIRO E LITERAL. O crond executa cada linha do crontab
#    por `/bin/sh -c`, então o valor é REAVALIADO na hora de disparar. A versão
#    anterior interpolava o INTERNAL_SECRET dentro de aspas duplas: um `$` no
#    valor virava expansão de variável (header truncado → todo cron respondendo
#    401 em silêncio) e uma crase virava substituição de comando — execução
#    arbitrária a cada minuto. Aqui o teste monta o header com um `sh` DE VERDADE,
#    como o crond faria, e compara byte a byte.
#
# 2. NENHUMA ROTA SE PERDE. O crontab saiu do `command:` inline do compose e veio
#    para cá; a contagem tem de bater com app/api/v1/cron. (A cerca principal é
#    tests/unit/cron-routes-scheduled.test.ts; esta aqui pega o caso em que o
#    arquivo GERADO diverge da lista escrita, que aquele teste não vê.)
#
# 3. FALHA FECHADA SEM SEGREDO. Sem INTERNAL_SECRET os crons responderiam 401 e
#    nada aconteceria — sem erro, sem log, sem sintoma. O script recusa subir.
#
# 4. QUEM ESCREVE AO DONO ACORDA ELE NA HORA CERTA. O contêiner roda em UTC, e
#    um cron que termina em `enviarAoDono` tem hora civil, não hora de máquina.
#    O ads-agent viveu uma fase inteira em `0 7 * * *` — 04:00 em Brasília —
#    com todos os gates verdes, porque nenhum olhava a hora.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

ENTRYPOINT="docker/scheduler/entrypoint.sh"
fail=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

check() {
  local nome="$1"; shift
  if "$@" >/dev/null 2>&1; then printf '  ✓ %s\n' "$nome"
  else printf '  ✗ %s\n' "$nome"; fail=1; fi
}

# `crond` dublado: o entrypoint termina em `exec crond`, que não existe no macOS
# nem no runner. Sem o dublê o script morreria DEPOIS de escrever o crontab — o
# arquivo estaria certo e o teste falharia por motivo errado.
mkdir -p "$TMP/bin"
printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/crond"
chmod +x "$TMP/bin/crond"

rodar() { # $1 = valor de INTERNAL_SECRET ("" = ausente)
  local out="$TMP/crontab"
  : > "$out"
  if [ -z "$1" ]; then
    env -u INTERNAL_SECRET PATH="$TMP/bin:$PATH" CRONTAB_PATH="$out" \
      sh "$ENTRYPOINT" >"$TMP/saida" 2>&1
  else
    env INTERNAL_SECRET="$1" PATH="$TMP/bin:$PATH" CRONTAB_PATH="$out" \
      sh "$ENTRYPOINT" >"$TMP/saida" 2>&1
  fi
  echo $?
}

echo "scheduler: o crontab é gerado com todas as rotas"
RC="$(rodar 'segredo-simples')"
check "o entrypoint termina com sucesso" test "$RC" -eq 0
ROTAS_CODIGO="$(find app/api/v1/cron -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
ROTAS_CRONTAB="$(grep -oE 'api/v1/cron/[a-z0-9-]+' "$TMP/crontab" | sort -u | wc -l | tr -d ' ')"
check "as $ROTAS_CODIGO rotas do código estão no crontab (achei $ROTAS_CRONTAB)" \
  test "$ROTAS_CODIGO" -eq "$ROTAS_CRONTAB"
check "uma linha por cron, nenhuma vazia" \
  test "$(grep -c . "$TMP/crontab")" -eq "$(wc -l < "$TMP/crontab" | tr -d ' ')"

# 4. CRON QUE ESCREVE AO DONO CAI NA HORA CIVIL DELE.
#
# O contêiner roda com TZ: UTC (docker-compose.prod.yml). Para um lote isso é
# indiferente; para um cron que termina em `enviarAoDono` a hora é "que horas
# alguém é acordado". O `ads-agent` foi para produção em `0 7 * * *` e mandou
# WhatsApp ao Dono às 4h da manhã durante uma fase inteira, com TODOS os gates
# verdes — porque nenhum deles olhava a hora. Este bloco olha.
#
# A tabela diz a INTENÇÃO em Brasília; a conversão para UTC é feita aqui, para
# que ninguém precise fazer +3 de cabeça ao ler ou ao registrar um cron novo.
# O +3 é constante: o Brasil não tem horário de verão desde 2019 (Decreto
# 9.772/2019). Se isso voltar, este é o lugar de consertar — uma linha.
# Cron de madrugada (retenção, sync de catálogo) não entra: ele não fala com
# ninguém, e a madrugada é onde ele deve mesmo estar.
HUMANOS="
ads-agent|7|0
"
echo "scheduler: cron que escreve ao Dono cai na hora civil de Brasília"
while IFS='|' read -r rota hora minuto; do
  [ -n "$rota" ] || continue
  ESPERADO_CRON="$minuto $(( (hora + 3) % 24 )) * * *"
  # Ancorado no fim da rota para que `ads-agent` não case com um `ads-agent-v2`
  # futuro. Rota ausente ou renomeada deixa ATUAL vazio e REPROVA — o modo de
  # falha que importa é este, não o de hora errada.
  ATUAL_CRON="$(grep -E "api/v1/cron/${rota}\"" "$TMP/crontab" | head -1 | cut -d' ' -f1-5)"
  check "${rota}: '${ESPERADO_CRON}' UTC = $(printf '%02d:%02d' "$hora" "$minuto") em Brasília (achei '${ATUAL_CRON:-NADA}')" \
    test "$ATUAL_CRON" = "$ESPERADO_CRON"
done <<< "$HUMANOS"

echo "scheduler: o segredo atravessa o sh do crond intacto"
# Os três caracteres que quebram interpolação ingênua, de uma vez só.
HOSTIL='seg`whoami`redo$HOME-com'\''aspa-e-"aspas"'
RC="$(rodar "$HOSTIL")"
check "gerou o crontab mesmo com segredo cheio de metacaractere" test "$RC" -eq 0

# A medição que importa: pegar a PRIMEIRA linha, tirar o prefixo de agendamento,
# e mandar um `sh` de verdade avaliá-la — exatamente o que o crond faz. O `curl`
# é dublado por um script que imprime o header que recebeu.
printf '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "-H" ] && { printf "%%s" "$2"; exit 0; }; shift; done\nexit 1\n' > "$TMP/bin/curl"
chmod +x "$TMP/bin/curl"
LINHA="$(head -1 "$TMP/crontab")"
COMANDO="${LINHA#* * * * * }"                 # tira o agendamento de 5 campos
COMANDO="${COMANDO%% >/dev/null*}"            # tira a redireção
RECEBIDO="$(PATH="$TMP/bin:$PATH" sh -c "$COMANDO")"
ESPERADO="Authorization: Bearer ${HOSTIL}"
if [ "$RECEBIDO" = "$ESPERADO" ]; then
  printf '  ✓ o header chega ao curl byte a byte igual ao segredo do .env\n'
else
  printf '  ✗ o segredo foi corrompido pelo sh do crond\n'
  printf '     esperado: %s\n' "$ESPERADO"
  printf '     recebido: %s\n' "$RECEBIDO"
  fail=1
fi
# Controle negativo do próprio instrumento: se a crase tivesse sido executada, o
# crontab conteria a saída de `whoami` no lugar dela, não o texto literal.
check "a crase NÃO foi executada (está literal no arquivo)" \
  grep -q 'whoami' "$TMP/crontab"

echo "scheduler: sem INTERNAL_SECRET, recusa em vez de subir mudo"
RC="$(rodar '')"
check "sai com código 1" test "$RC" -eq 1
check "explica o motivo na saída" grep -q "INTERNAL_SECRET" "$TMP/saida"
check "não deixou crontab pela metade" test ! -s "$TMP/crontab"

if [ "$fail" -eq 0 ]; then
  echo "OK — todas as provas passaram."
else
  echo "FALHOU."
fi
exit "$fail"
