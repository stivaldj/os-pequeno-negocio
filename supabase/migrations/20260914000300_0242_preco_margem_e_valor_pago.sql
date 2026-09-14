-- ---- preço, Margem Declarada e valor pago (migration 0242) ----
--
-- ADR-0017: em clínica, Venda Confirmada é a consulta que a recepção marcou
-- como "compareceu" com o valor pago. O serviço (tipo de agendamento) ganha
-- preço e Margem Declarada; o Agendamento ganha o valor pago.
--
-- Dinheiro em centavos (`bigint`), margem em pontos-base (0..10000 = 0%..100%),
-- moeda explícita. `paid_cents` NULO é dado FALTANTE — a recepção marcou o
-- comparecimento sem digitar valor — e o Relatório Diário o trata como
-- incompleto, nunca como zero. Colunas nulas: nenhuma linha existente viola
-- os CHECKs, então nascem sem correção de dados.
alter table public.calendar_event_types
  add column if not exists price_cents bigint null,
  add column if not exists margin_bps integer null;

alter table public.calendar_event_types
  drop constraint if exists calendar_event_types_price_cents_check;
alter table public.calendar_event_types
  add constraint calendar_event_types_price_cents_check check (price_cents is null or price_cents >= 0);

alter table public.calendar_event_types
  drop constraint if exists calendar_event_types_margin_bps_check;
alter table public.calendar_event_types
  add constraint calendar_event_types_margin_bps_check check (margin_bps is null or (margin_bps between 0 and 10000));

comment on column public.calendar_event_types.price_cents is
  'Preço do serviço em centavos, cadastrado pelo Dono. Nulo = não cadastrado (o Agente diz que não tem o valor). ADR-0017.';
comment on column public.calendar_event_types.margin_bps is
  'Margem Declarada em pontos-base (6000 = 60%). Insumo de Sobra por Real (Spec 0003). Nulo = não declarada.';

alter table public.calendar_appointments
  add column if not exists paid_cents bigint null,
  add column if not exists paid_currency char(3) not null default 'BRL';

alter table public.calendar_appointments
  drop constraint if exists calendar_appointments_paid_cents_check;
alter table public.calendar_appointments
  add constraint calendar_appointments_paid_cents_check check (paid_cents is null or paid_cents >= 0);

comment on column public.calendar_appointments.paid_cents is
  'Valor pago pelo Contato, digitado pela recepção ao marcar "compareceu" (ADR-0017). Nulo = dado faltante, não zero. É a Venda Confirmada.';

notify pgrst, 'reload schema';
