/**
 * O que DEVERIA rodar, e com que período — a lista que o vigia consulta.
 *
 * Espelha linha a linha o `CRONS=` de `docker/scheduler/entrypoint.sh`, que é
 * a fonte da verdade do que o self-host agenda. `lib/rotinas/esperadas.test.ts`
 * deriva a lista do próprio entrypoint e exige igualdade exata (nome e
 * período), então cron novo sem linha aqui reprova o CI — o mesmo movimento
 * que `tests/unit/cron-routes-scheduled.test.ts` faz para rota sem agendamento.
 *
 * `periodoMinutos` é o intervalo entre duas execuções esperadas. A tolerância
 * que o vigia aplica em cima dele vive em `vigia.ts`.
 */
export interface RotinaEsperada {
  readonly nome: string;
  readonly periodoMinutos: number;
}

export const ROTINAS_ESPERADAS: readonly RotinaEsperada[] = [
  { nome: "followup-flow-worker", periodoMinutos: 1 },
  { nome: "event-log-drain", periodoMinutos: 1 },
  { nome: "routing-worker", periodoMinutos: 1 },
  { nome: "recover-stuck-messages", periodoMinutos: 1 },
  { nome: "storage-redaction", periodoMinutos: 5 },
  { nome: "snooze-watcher", periodoMinutos: 5 },
  { nome: "attendant-heartbeat", periodoMinutos: 5 },
  { nome: "webhook-log-retention", periodoMinutos: 5 },
  { nome: "channel-health", periodoMinutos: 5 },
  { nome: "contact-avatars", periodoMinutos: 10 },
  { nome: "agenda-google-refresh", periodoMinutos: 10 },
  { nome: "agenda-google-sync", periodoMinutos: 15 },
  { nome: "agenda-google-push", periodoMinutos: 5 },
  { nome: "agenda-lembretes", periodoMinutos: 10 },
  { nome: "risk-watcher", periodoMinutos: 15 },
  { nome: "contact-phones", periodoMinutos: 30 },
  { nome: "contact-proposals-watcher", periodoMinutos: 60 },
  { nome: "lgpd-sla-watcher", periodoMinutos: 1440 },
  { nome: "kb-conversations-batch", periodoMinutos: 1440 },
  { nome: "sync-model-catalog", periodoMinutos: 1440 },
  { nome: "data-retention", periodoMinutos: 1440 },
  { nome: "rotinas-vigia", periodoMinutos: 60 },
  { nome: "clinica-vigia", periodoMinutos: 60 },
  { nome: "ads-spend-sync", periodoMinutos: 1440 },
];
