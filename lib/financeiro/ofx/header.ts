/**
 * Cabeçalho do OFX: versão, encoding e onde começa o corpo.
 *
 * Este arquivo existe porque as duas bibliotecas de OFX do npm recebem
 * `string`, não `Buffer` — quer dizer que quem chama já decidiu o encoding
 * antes de o arquivo dizer qual é. Extrato de banco brasileiro declara
 * `CHARSET:1252` e manda `CARTÃO` como UM byte (0xC3); lido como UTF-8, esse
 * byte vira lixo na tela do Dono. O codec tem de sair do cabeçalho do próprio
 * arquivo, e para isso é preciso ler os bytes.
 */
import { OFX_MAX_BYTES } from "./tipos";

export interface CabecalhoOfx {
  versao: "1" | "2";
  /** O codec resolvido (`windows-1252`, `iso-8859-1`, `utf-8`, `utf-16le`…). */
  charset: string;
  /** O documento a partir de `<OFX>`, já decodificado. */
  corpo: string;
}

/**
 * `CHARSET` do OFX 1.x → label de `TextDecoder`. Medido no Node v22.22.0: os
 * encodings legados existem sem build full-icu, então não é preciso trazer
 * `iconv-lite` para dentro de um self-host.
 */
const CODEC_POR_CHARSET: Record<string, string> = {
  "1252": "windows-1252",
  CP1252: "windows-1252",
  "WINDOWS-1252": "windows-1252",
  "ISO-8859-1": "iso-8859-1",
  "8859-1": "iso-8859-1",
  LATIN1: "iso-8859-1",
  "ISO-8859-15": "iso-8859-15",
};

/**
 * `ENCODING` do OFX 1.x. `USASCII` é subconjunto de utf-8, então decodificar
 * como utf-8 é sempre seguro quando não há `CHARSET` dizendo outra coisa.
 */
const CODEC_POR_ENCODING: Record<string, string> = {
  "UTF-8": "utf-8",
  UTF8: "utf-8",
  UNICODE: "utf-8",
  USASCII: "utf-8",
};

interface Bom {
  offset: number;
  /** Codec que o BOM IMPÕE — o cabeçalho não pode contrariá-lo. */
  forcado: string | null;
}

function comeBom(buf: Buffer): Bom {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { offset: 3, forcado: "utf-8" };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { offset: 2, forcado: "utf-16le" };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { offset: 2, forcado: "utf-16be" };
  }
  return { offset: 0, forcado: null };
}

/** Pares `CHAVE:VALOR` do cabeçalho SGML, lidos em ASCII (o cabeçalho é ASCII). */
function paresDoCabecalho(ascii: string): Record<string, string> {
  const pares: Record<string, string> = {};
  for (const linha of ascii.split(/\r\n|\r|\n/)) {
    const t = linha.trim();
    if (t === "") continue;
    if (t.startsWith("<")) break; // chegou ao corpo
    const i = t.indexOf(":");
    if (i <= 0) continue;
    pares[t.slice(0, i).trim().toUpperCase()] = t.slice(i + 1).trim().toUpperCase();
  }
  return pares;
}

function codecDeclarado(ascii: string, versao: "1" | "2"): string {
  if (versao === "2") {
    // OFX 2.x é XML: o encoding mora na declaração XML e o default é utf-8.
    const m = ascii.match(/<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i);
    const label = (m?.[1] ?? "UTF-8").toUpperCase();
    return CODEC_POR_CHARSET[label] ?? CODEC_POR_ENCODING[label] ?? "utf-8";
  }
  const pares = paresDoCabecalho(ascii);
  const charset = pares.CHARSET ?? "";
  const encoding = pares.ENCODING ?? "";
  // `CHARSET:NONE` não é encoding nenhum — cai para o que o ENCODING disser.
  if (charset !== "" && charset !== "NONE") {
    const porCharset = CODEC_POR_CHARSET[charset];
    if (porCharset !== undefined) return porCharset;
  }
  return CODEC_POR_ENCODING[encoding] ?? "utf-8";
}

function versaoDe(texto: string): "1" | "2" {
  for (const linha of texto.split(/\r\n|\r|\n/)) {
    const t = linha.trim();
    if (t === "") continue;
    // A primeira linha NÃO VAZIA decide — extrato do Bradesco começa com uma
    // linha em branco antes do `OFXHEADER`, e isso não pode virar "versão 1?".
    if (/^<\?(xml|OFX)/i.test(t)) return "2";
    return "1";
  }
  return "1";
}

function indiceDoOfx(texto: string): number {
  const m = texto.match(/<OFX>/i);
  if (m?.index === undefined) {
    throw new Error(
      "arquivo não parece um extrato OFX: não há a tag <OFX>. " +
        "No site do banco, escolha exportar em OFX (Money/Quicken), não em PDF nem CSV.",
    );
  }
  return m.index;
}

/**
 * Lê o cabeçalho e devolve o corpo já decodificado com o codec que o arquivo
 * declara. Lança — em vez de devolver meia leitura — quando o arquivo é grande
 * demais ou quando não há `<OFX>`: as duas são recusas de borda, e a mensagem
 * ensina o que fazer.
 */
export function lerCabecalho(buf: Buffer): CabecalhoOfx {
  if (buf.length > OFX_MAX_BYTES) {
    const mb = (n: number): string => (n / 1024 / 1024).toFixed(1).replace(".", ",");
    throw new Error(
      `arquivo OFX de ${mb(buf.length)} MB excede o teto de ${mb(OFX_MAX_BYTES)} MB: ` +
        "exporte um período menor no site do banco (um mês por vez) e importe em partes.",
    );
  }

  const bom = comeBom(buf);
  const semBom = buf.subarray(bom.offset);

  // UTF-16 não tem cabeçalho legível byte a byte: decodifica tudo de uma vez.
  if (bom.forcado === "utf-16le" || bom.forcado === "utf-16be") {
    const texto = new TextDecoder(bom.forcado, { fatal: false }).decode(semBom);
    return {
      versao: versaoDe(texto),
      charset: bom.forcado,
      corpo: texto.slice(indiceDoOfx(texto)),
    };
  }

  // `latin1` é a leitura byte-a-byte: 1 caractere = 1 byte, então o índice de
  // `<OFX>` aqui É o offset em bytes. O cabeçalho é ASCII nas duas versões.
  const ascii = semBom.toString("latin1");
  const versao = versaoDe(ascii);
  const charset = bom.forcado ?? codecDeclarado(ascii, versao);

  const inicio = indiceDoOfx(ascii);
  const corpo = new TextDecoder(charset, { fatal: false }).decode(semBom.subarray(inicio));
  return { versao, charset, corpo };
}
