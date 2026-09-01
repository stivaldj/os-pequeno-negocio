/**
 * Vercel project config (canonical TS form).
 *
 * Crons placeholder; lista final virá da Spec 08 (Operações & Workers).
 * Os 7 crons abaixo refletem os jobs derivados das specs herdadas:
 *  - recover-stuck-messages (WAHA)
 *  - sync-sessions (WAHA)
 *  - process-pending-webhooks (event_log)
 *  - dispatch-webhooks (deliveries / outbound webhooks)
 *  - lgpd-data-request-worker (D+7 SLA)
 *  - nuvemshop-sync-incremental
 *  - audit-log-archive (cold storage)
 *
 * Auth de cron: header `Authorization: Bearer ${INTERNAL_SECRET}` validado em cada handler.
 */

import type { VercelConfig } from "@vercel/config/v1";

const config: VercelConfig = {
  // Plano Hobby só aceita cron ≤1×/dia. Os jobs */1 (routing-worker,
  // event-log-drain, followup-flow-worker) ficam de fora até Pro — no
  // self-host eles rodam no container `scheduler`. Reative-os ao subir de plano.
  crons: [
    { path: "/api/v1/cron/lgpd-sla-watcher", schedule: "0 12 * * *" },
  ],
};

export default config;
