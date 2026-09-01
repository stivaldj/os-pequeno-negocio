# TypeScript, Next.js e Supabase — o lock-in que aceitamos

Um repo só: Next.js App Router em TypeScript, painel e API juntos, Postgres no Supabase com RLS, acesso por Drizzle atrás de uma camada que injeta a Conta.

Alternativas reais eram backend separado (Hono/Fastify) e Python no servidor. Recusadas pelo mesmo motivo: o time é uma pessoa que vai operar tudo à mão nos primeiros meses, e cada runtime a mais é um plantão a mais. O trabalho pesado aqui é integração e orquestração, não numérico — Python não ganharia nada. Supabase entra pelo RLS nativo (ver ADR-0002) e por entregar auth e storage prontos.

## Consequências

Ficamos presos ao Postgres e ao ecossistema Supabase para auth. Sair custa semanas. Em compensação, a segunda trava de isolamento vem de graça e não depende de disciplina de código.

## Emenda (01/09/2026, Spec 0003)

O fork do DeskcommCRM não usa Drizzle: o acesso é `@supabase/supabase-js` atrás de RLS, com admin client filtrando `organization_id` à mão quando bypassa. A decisão de stack se mantém; a menção a Drizzle é substituída pelo que o fork entrega.
