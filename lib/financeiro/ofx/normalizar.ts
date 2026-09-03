/**
 * Normalização de valor, data, tipo e descrição de um lançamento de OFX.
 *
 * ─── Por que não `lib/money.ts` (a divergência, declarada em voz alta) ───────
 *
 * O irmão `parseReaisToCents` de `lib/money.ts` resolve OUTRO problema e por
 * isso tem outra regra. Ele lê **digitação humana** num formulário, onde
 * `"1.234"` quase sempre quer dizer mil duzentos e trinta e quatro reais — e
 * ele acerta ao devolver 123400, porque em pt-BR grupo de milhar tem sempre 3
 * dígitos e o humano digitou o ponto de propósito.
 *
 * `paraCentavos` lê **formato de fio de banco**, onde a spec OFX (§3.2.9.2)
 * PROÍBE separador de milhar. Um `"1.234"` num `TRNAMT` não é mil e duzentos:
 * é um arquivo que já saiu errado, ou um banco que inventou formato. Adivinhar
 * ali custa cem vezes o valor num livro-caixa que o Dono vai conferir contra o
 * app do banco. Então aqui `"1.234"` é `null`, a linha vai para os erros da
 * importação com motivo legível, e ninguém soma número inventado.
 *
 * Duas regras diferentes para dois problemas diferentes — dito aqui para não
 * virar "duplicação sem fonte declarada", que é anti-pattern nomeado no
 * `CLAUDE.md`. Se um dia o financeiro ganhar um formulário de lançamento
 * manual, esse formulário usa `parseReaisToCents`, não esta função.
 *
 * ─── E por que nunca `parseFloat` ───────────────────────────────────────────
 *
 * Medido: `parseFloat("1.005") * 100 === 100.49999999999999`. Um
 * `Math.round` em cima disso esconde o erro na maioria dos casos e o solta em
 * alguns. A conversão aqui é por string com `BigInt`: exata por construção.
 */
import { TRN_TYPES, type TrnType } from "./tipos";
import { texto, type No } from "./tokenizer";

/** O fuso do produto. Cliente zero é a Clínica Humana, em São Paulo. */
const FUSO = "America/Sao_Paulo";

/**
 * `TRNAMT` / `BALAMT` → centavos com sinal. `null` quando não dá para ler sem
 * adivinhar — e `null` NUNCA vira 0 rio abaixo: zero entraria no livro-caixa
 * como lançamento válido e o saldo do Dono ficaria errado sem nada reprovar.
 *
 * A regra:
 *   - dois separadores presentes → o último é o decimal (o outro é milhar);
 *   - um separador com 0, 1 ou 2 dígitos depois → é o decimal;
 *   - um separador com 3+ dígitos depois → AMBÍGUO → `null`;
 *   - nenhum separador → inteiro em reais (`"550"` = R$ 550,00, §3.2.9.2).
 */
export function paraCentavos(raw: string): number | null {
  const s = raw.replace(/\s/g, "");
  if (s === "") return null;
  if (!/^[+-]?[\d.,]*$/.test(s)) return null;

  const negativo = s.startsWith("-");
  const corpo = s.replace(/^[+-]/, "");
  // `"."`, `",,"`, `"-"` — forma de número, nenhum dígito. Recusa, não zero.
  if (!/\d/.test(corpo)) return null;

  const ultimaVirgula = corpo.lastIndexOf(",");
  const ultimoPonto = corpo.lastIndexOf(".");

  let corte: number;
  if (ultimaVirgula >= 0 && ultimoPonto >= 0) {
    corte = Math.max(ultimaVirgula, ultimoPonto);
  } else if (ultimaVirgula >= 0 || ultimoPonto >= 0) {
    corte = Math.max(ultimaVirgula, ultimoPonto);
    // Aqui mora a decisão: 3+ dígitos depois do único separador é milhar OU
    // decimal, e o arquivo não diz qual. Recusa em vez de escolher.
    if (corpo.length - corte - 1 >= 3) return null;
  } else {
    corte = corpo.length;
  }

  const inteiro = corpo.slice(0, corte).replace(/[.,]/g, "");
  const frac = corpo.slice(corte + 1);
  if (!/^\d*$/.test(frac) || !/^\d*$/.test(inteiro)) return null;

  let centavos: bigint;
  if (frac.length <= 2) {
    centavos = BigInt(inteiro === "" ? "0" : inteiro) * 100n + BigInt(`${frac}00`.slice(0, 2));
  } else {
    // Mais de 2 casas só chega com os dois separadores presentes (o caso de um
    // separador já foi recusado acima). Arredonda meio-para-cima, sem float.
    const base = BigInt(inteiro === "" ? "0" : inteiro) * 100n + BigInt(frac.slice(0, 2));
    centavos = frac.charCodeAt(2) - 48 >= 5 ? base + 1n : base;
  }

  const comSinal = negativo ? -centavos : centavos;
  if (comSinal > BigInt(Number.MAX_SAFE_INTEGER) || comSinal < BigInt(Number.MIN_SAFE_INTEGER)) {
    return null;
  }
  return Number(comSinal);
}

const DTPOSTED =
  /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?)?(?:\[\s*([+-]?\d{1,2}(?:\.\d{1,2})?)\s*(?::[^\]]*)?\])?$/;

function ehDataReal(ano: number, mes: number, dia: number): boolean {
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  return d.getUTCFullYear() === ano && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
}

const FORMATADOR = new Intl.DateTimeFormat("en-CA", {
  timeZone: FUSO,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * `DTPOSTED` / `DTASOF` (§3.2.8.1) → o DIA, `YYYY-MM-DD`.
 *
 * **Sem offset o dia sai por fatia de string, jamais por `new Date()`.** Medido:
 * `"20100826"` interpretado como UTC e lido no fuso de Cuiabá volta 25/08 — o
 * lançamento muda de dia, e "o que venceu hoje" passa a mentir para o Dono.
 * O banco que não declara offset está declarando data civil, não instante.
 *
 * **Com offset há instante de verdade**, e aí sim converte-se — para
 * `America/Sao_Paulo`, não para UTC. `"20170831230000[-3:BRT]"` é 02:00Z de
 * 01/09; em UTC o dia seria 2017-09-01, e o certo é 2017-08-31. O nome do fuso
 * entre colchetes mente com frequência (bancos mandam `[-3:GMT]`); o número,
 * não — só o número é lido.
 *
 * **Meia-noite cravada é data civil, tenha offset ou não.** Medido no extrato
 * real da Cora (`Cora SCD SA`, FID 0403): todo lançamento vem
 * `"20250901000000[0:GMT]"`, e o `DTSTART`/`DTEND` do mesmo arquivo declaram a
 * janela de um dia só, 01/09 — mas convertido como instante, 00:00Z vira 21h de
 * 31/08 em Brasília e o lançamento MUDA DE MÊS. Um extrato em que os três
 * lançamentos caem no mesmo `000000` não está medindo hora nenhuma: está
 * escrevendo data e preenchendo o resto com zero. O `DTSERVER` do mesmo arquivo
 * traz `105313`, hora de verdade — é a diferença entre carimbo e data.
 *
 * O caso escapou de 169 testes porque a única fixture com offset usava
 * `[-3:BRT]` e o único `[0:GMT]` do teste era `030000` — 03:00Z é meia-noite
 * exata em Brasília, o valor em que a conversão não move o dia e portanto o
 * único que esconde o defeito.
 */
export function diaDoDtposted(raw: string): string | null {
  const m = raw.trim().match(DTPOSTED);
  if (m === null) return null;
  const ano = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  if (!ehDataReal(ano, mes, dia)) return null;

  // A hora é conferida mesmo quando não muda o dia: `20260803999999` tem a
  // forma certa e a hora não existe, e um arquivo assim está torto em algum
  // lugar que o resto do parse não vai enxergar. Falhar aberto é a regra.
  const horas = Number(m[4] ?? "0");
  const minutos = Number(m[5] ?? "0");
  const segundos = Number(m[6] ?? "0");
  if (horas > 24 || minutos > 59 || segundos > 60) return null;

  const offset = m[8];
  const meiaNoiteCravada = horas === 0 && minutos === 0 && segundos === 0 && Number(m[7] ?? "0") === 0;
  if (offset === undefined || meiaNoiteCravada) {
    return `${m[1]}-${m[2]}-${m[3]}`;
  }

  const deslocamentoMs = Number(offset) * 3_600_000;
  const instante = Date.UTC(ano, mes - 1, dia, horas, minutos, segundos) - deslocamentoMs;
  if (!Number.isFinite(instante)) return null;

  const partes = FORMATADOR.formatToParts(new Date(instante));
  const pega = (tipo: string): string => partes.find((p) => p.type === tipo)?.value ?? "";
  const y = pega("year");
  const mo = pega("month");
  const d = pega("day");
  return y === "" || mo === "" || d === "" ? null : `${y}-${mo}-${d}`;
}

const TIPOS = new Set<string>(TRN_TYPES);

/**
 * `TRNTYPE` → um dos 18 da §11.4.4.3. Valor fora da lista vira `"OTHER"` sem
 * lançar: o tipo é rótulo, e o sinal do dinheiro está no `TRNAMT`. Foi
 * classificar pelo `TRNTYPE` que fez a `ofx-data-extractor@1.5.0` reportar
 * +94,02 de crédito num extrato que soma exatamente R$ 0,00.
 */
export function tipoDeTransacao(raw: string): TrnType {
  const t = raw.trim().toUpperCase();
  return TIPOS.has(t) ? (t as TrnType) : "OTHER";
}

/**
 * A descrição que o Dono vai ler: `MEMO`, senão `NAME`, senão `EXTDNAME`.
 * Espaços colapsados — banco manda padding, e `"PIX    ENVIADO"` e
 * `"PIX ENVIADO"` são a mesma frase para quem lê.
 */
export function descricaoDe(t: No): string {
  const bruto = texto(t, "MEMO") ?? texto(t, "NAME") ?? texto(t, "EXTDNAME") ?? "";
  return bruto.replace(/\s+/g, " ").trim();
}
