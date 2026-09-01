-- ---- canal fake para provas locais (migration 0204) ----
--
-- `fake_channel` é o `ChannelAdapter` das provas locais (Spec 0003, Fase 2):
-- envia para uma caixa em memória e recebe pelo webhook genérico. O registry
-- em `lib/channels/index.ts` só o conhece fora de produção.
--
-- Reconstrói as duas constraints de provider com o vocabulário FINAL, como a
-- 0132 fez. No baseline elas são editadas in place (uma constraint, um bloco).
alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider = any (array['waha'::text, 'meta_cloud'::text, 'zernio'::text, 'fake_channel'::text]));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'       and waha_session_name    is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider = 'zernio'     and zernio_account_id    is not null) or
    (provider = 'fake_channel' and waha_session_name  is not null)
  );
