-- ---- a sessão sabe que entrou por Coexistência (migration 0206) ----
--
-- ADR-0015: o Número pode entrar por Embedded Signup em Coexistência — o app do
-- WhatsApp Business continua no telefone da recepção e a Cloud API opera o
-- mesmo número. A flag é o que distingue esse número de um conectado à mão.
alter table public.channel_sessions
  add column if not exists meta_coexistence boolean not null default false;

comment on column public.channel_sessions.meta_coexistence is
  'true quando o número entrou por Embedded Signup em Coexistência (ADR-0015): o app do WhatsApp Business continua ativo no telefone e responde pelo mesmo número.';
