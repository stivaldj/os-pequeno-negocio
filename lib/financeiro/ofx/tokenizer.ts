/**
 * Tokenizer de OFX — SGML (1.x) e XML (2.x) no mesmo laço.
 *
 * Um tokenizer só para as duas versões porque a diferença entre elas é apenas
 * *quanto* de fechamento o arquivo traz: em SGML a folha é `<TAG>valor` sem
 * fechar, em XML é `<TAG>valor</TAG>`. A regra que unifica é simples — tag que
 * abre enquanto outra está aberta fecha a anterior. Nenhum `if (versao === 2)`
 * existe neste arquivo, e a fixture `ofx2.xml.ofx` prova isso afirmando
 * lançamentos idênticos aos da fixture 1.x.
 *
 * Nada de parser XML de terceiro: um `.ofx` de banco brasileiro não é XML bem
 * formado (`&` cru, tag sem fechar, `<` no meio de descrição), então um parser
 * XML estrito recusa o arquivo inteiro. Foi o defeito medido da `ofx-js@1.1.1`:
 * ela LANÇA quando um `MEMO` contém `<`, e o extrato do Dono se perde por causa
 * de um sinal de menor.
 */

export type ValorDeNo = string | No;
export interface No {
  [tag: string]: ValorDeNo | ValorDeNo[];
}

/**
 * Só é tag o que casa isto. Um `<` seguido de qualquer outra coisa (`< 5`,
 * `<20>` com espaço, `<R$`) é TEXTO — é o caractere que derruba a `ofx-js`.
 */
const TAG = /^<(\/?)([A-Z0-9_.]+)>/i;

/** As cinco entidades do XML mais as numéricas. `&` solto continua `&`. */
const ENTIDADES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodificaEntidades(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (inteiro, corpo: string) => {
    if (corpo.startsWith("#")) {
      const hex = corpo[1] === "x" || corpo[1] === "X";
      const n = Number.parseInt(hex ? corpo.slice(2) : corpo.slice(1), hex ? 16 : 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : inteiro;
    }
    // Entidade desconhecida fica literal: um `&SOMETHING;` de descrição de
    // banco não é entidade, é o texto que o Dono vai ler na tela.
    return ENTIDADES[corpo.toLowerCase()] ?? inteiro;
  });
}

/** Repetição no mesmo nível vira array — dois `STMTTRN` não podem se sobrescrever. */
function guarda(no: No, tag: string, valor: ValorDeNo): void {
  const atual = no[tag];
  if (atual === undefined) {
    no[tag] = valor;
    return;
  }
  if (Array.isArray(atual)) {
    atual.push(valor);
    return;
  }
  no[tag] = [atual, valor];
}

/**
 * Corpo (a partir de `<OFX>`) → árvore.
 *
 * Tolera, de propósito: CRLF, tabs, padding de espaços, `&` cru, `<` no meio de
 * texto, fechamento misto (folha fechada e folha aberta no MESMO arquivo — o
 * Bradesco faz isso, com o primeiro `<STATUS>` de um jeito e o segundo de
 * outro) e agregado fechado fora de ordem.
 */
export function tokenizar(corpo: string): No {
  // Quais tags aparecem fechadas em ALGUM lugar do documento. Serve à única
  // ambiguidade real do SGML sem DTD: `<MEMO>` seguido de outra tag, sem texto
  // no meio, pode ser folha vazia ou agregado. A spec 1.x manda fechar todo
  // agregado (só a FOLHA pode omitir o fechamento), então "nunca aparece como
  // `</TAG>` neste arquivo" é prova de que é folha. Sem isto, um `<MEMO>` vazio
  // engoliria o `<FITID>` seguinte para dentro de si e a transação perderia a
  // chave — falha silenciosa, que é a espécie que este módulo existe para não ter.
  const fechadas = new Set<string>();
  for (const m of corpo.matchAll(/<\/([A-Z0-9_.]+)>/gi)) fechadas.add(m[1]!.toUpperCase());

  const raiz: No = {};
  const pilha: Array<{ tag: string; no: No }> = [{ tag: "", no: raiz }];
  /** Tag aberta cujo texto está sendo acumulado — pode virar folha ou agregado. */
  let aberta: string | null = null;
  let texto = "";
  let i = 0;

  const topo = (): No => pilha[pilha.length - 1]!.no;

  /** Com texto: folha. Sem texto e fechada em algum lugar: agregado, vira nível. */
  const resolveAberta = (): void => {
    if (aberta === null) return;
    const valor = decodificaEntidades(texto).trim();
    if (valor === "" && fechadas.has(aberta)) {
      const novo: No = {};
      guarda(topo(), aberta, novo);
      pilha.push({ tag: aberta, no: novo });
    } else {
      guarda(topo(), aberta, valor);
    }
    aberta = null;
    texto = "";
  };

  while (i < corpo.length) {
    if (corpo[i] !== "<") {
      texto += corpo[i];
      i += 1;
      continue;
    }
    const m = corpo.slice(i).match(TAG);
    if (m === null) {
      // `<` que não abre tag é texto. É o caso do `MEMO` com `< 5 REAIS`.
      texto += "<";
      i += 1;
      continue;
    }
    const fecha = m[1] === "/";
    const tag = m[2]!.toUpperCase();
    i += m[0].length;

    if (!fecha) {
      resolveAberta();
      aberta = tag;
      texto = "";
      continue;
    }

    // `</TAG>` fechando a própria folha que está aberta: `<CODE>0</CODE>`.
    if (aberta === tag) {
      guarda(topo(), aberta, decodificaEntidades(texto).trim());
      aberta = null;
      texto = "";
      continue;
    }
    // Fechamento de agregado que ninguém abriu: ignora e segue como se não
    // existisse. Fechar a folha pendente aqui seria PIOR que o lixo — o
    // `<OFX>` do começo do arquivo viraria folha vazia e a árvore inteira
    // desabaria para a raiz.
    const alvo = pilha.findIndex((n) => n.tag === tag);
    if (alvo <= 0) continue;

    // `</TAG>` de agregado de verdade: a folha pendente (se houver) fecha antes.
    if (aberta !== null) {
      guarda(topo(), aberta, decodificaEntidades(texto).trim());
      aberta = null;
      texto = "";
    }
    pilha.length = alvo;
  }
  resolveAberta();
  return raiz;
}

/**
 * Um filho vira objeto, dois viram array — a armadilha do SGML sem fechamento.
 * TODO acesso a filho repetível passa por aqui; a fixture `duas-contas.ofx`
 * trava os dois sentidos no mesmo arquivo.
 */
export function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Lê uma folha de texto. Devolve `null` para ausente, vazio ou agregado. */
export function texto(no: No | undefined, tag: string): string | null {
  if (no === undefined) return null;
  const v = no[tag];
  const primeiro = Array.isArray(v) ? v[0] : v;
  if (typeof primeiro !== "string") return null;
  const t = primeiro.trim();
  return t === "" ? null : t;
}

/** Lê um agregado filho. Devolve `undefined` quando ausente ou folha de texto. */
export function filho(no: No | undefined, tag: string): No | undefined {
  if (no === undefined) return undefined;
  const v = no[tag];
  const primeiro = Array.isArray(v) ? v[0] : v;
  return typeof primeiro === "object" && primeiro !== null ? primeiro : undefined;
}

/** Lê filhos repetíveis já como lista de agregados. */
export function filhos(no: No | undefined, tag: string): No[] {
  if (no === undefined) return [];
  return asArray(no[tag]).filter((v): v is No => typeof v === "object" && v !== null);
}
