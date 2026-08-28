# Isolamento entre Contas é obrigação legal, não boa prática

Toda tabela carrega `tenant_id`, todo acesso passa por uma camada que injeta a Conta corrente, e o Postgres roda com RLS ligada como segunda trava.

Isso não é apenas higiene. Com clínicas entre os clientes, somos **operador** e a Conta é **controladora** (LGPD art. 5º, VI e VII), com responsabilidade solidária pelo art. 42, §1º, I. Mais decisivo: o art. 11, §4º veda uso compartilhado de dado de saúde para vantagem econômica — dado de uma Conta não pode melhorar o produto de outra. Um `where` esquecido num painel não é bug de listagem, é incidente reportável à ANPD em três dias úteis (Resolução CD/ANPD nº 15/2024).

## Consequências

Não existe consulta cross-tenant, nem para métrica agregada, nem para treinar ou avaliar o Agente. Qualquer necessidade futura de agregado exige dado desidentificado na origem, decidido em ADR própria.
