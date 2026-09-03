/**
 * Categoria de um lançamento pela descrição que o banco escreveu.
 *
 * `ledger_categories.match_terms` guarda os termos do Dono ("FARMACIA",
 * "ALUGUEL"); a comparação é sem acento e sem caixa, porque o mesmo banco
 * manda `FARMÁCIA` num extrato e `FARMACIA` no seguinte.
 *
 * O empate é resolvido pelo `slug` em ordem alfabética, e isso não é gosto: o
 * `select` do Postgres não promete ordem, então sem desempate declarado o
 * mesmo lançamento cairia em categorias diferentes entre duas importações do
 * mesmo arquivo — dado que decide dinheiro não pode depender da ordem em que o
 * banco devolveu as linhas.
 *
 * Puro: sem banco, sem `organization_id`. Quem lê as categorias da organização
 * é o importador.
 */

/** O bastante de `ledger_categories` para classificar — nada além. */
export interface Categoria {
  id: string;
  slug: string;
  match_terms: string[];
}

/** Sem acento e em maiúsculas: "Farmácia" tem de ler igual a "FARMACIA". */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase();
}

/**
 * `id` da categoria que casa com a descrição, ou `null` quando nenhuma casa.
 *
 * Casa por substring: a descrição do banco é telegráfica e colada
 * ("PAGTOFARMACIA"), e exigir palavra inteira perderia o caso comum. Termo
 * vazio é ignorado — `"".includes` em toda descrição transformaria uma
 * categoria mal cadastrada no destino de todo o Extrato.
 */
export function categoriaDe(descricao: string, categorias: Categoria[]): string | null {
  const alvo = normalizar(descricao);
  if (alvo.trim() === "") return null;

  const candidatas = categorias.filter((c) =>
    (c.match_terms ?? []).some((termo) => {
      const t = normalizar(termo).trim();
      return t !== "" && alvo.includes(t);
    }),
  );
  if (candidatas.length === 0) return null;

  // Ordem alfabética do slug, não `localeCompare`: a comparação de código de
  // ponto é a mesma em qualquer locale da instalação self-host.
  candidatas.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return candidatas[0]!.id;
}
