#!/usr/bin/env node
/**
 * Gerador das fixtures de OFX — `node tests/fixtures/ofx/gerar.mjs`.
 *
 * Por que um script, e não editar os `.ofx` à mão: toda ferramenta de edição
 * (a do editor, a do agente, `cat > arquivo`) grava UTF-8 com LF. As duas
 * coisas que estas fixtures existem para provar são exatamente as duas que
 * essas ferramentas destroem em silêncio:
 *
 *   - o fim de linha CRLF do SGML que os bancos exportam;
 *   - o byte único de cp1252 (`Ã` = 0xC3, `Ç` = 0xC7) do `CHARSET:1252`.
 *
 * Fixture escrita em UTF-8 faz a asserção de acento passar por acaso (o
 * TextDecoder de utf-8 leria certo mesmo com o parser errado) ou falhar sem
 * explicação. Aqui cada arquivo v1 sai por `Buffer.from(texto, "latin1")`,
 * com `\r\n` explícito; só a fixture OFX 2.x sai em UTF-8, que é o que a
 * própria versão 2 manda.
 *
 * O `.gitattributes` da raiz tem a entrada que impede o git de normalizar
 * estes bytes de volta — as duas providências andam juntas.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const AQUI = dirname(fileURLToPath(import.meta.url));

/** Junta linhas com CRLF explícito e termina o arquivo com CRLF. */
const crlf = (linhas) => linhas.join("\r\n") + "\r\n";

/** Cabeçalho OFX 1.x (SGML) — o que BB, Bradesco, Santander e Caixa mandam. */
const CABECALHO_V1 = [
  "OFXHEADER:100",
  "DATA:OFXSGML",
  "VERSION:102",
  "SECURITY:NONE",
  "ENCODING:USASCII",
  "CHARSET:1252",
  "COMPRESSION:NONE",
  "OLDFILEUID:NONE",
  "NEWFILEUID:NONE",
  "",
];

// ---------------------------------------------------------------------------
// bradesco-like.ofx
// ---------------------------------------------------------------------------
// Prova, num arquivo só, tudo o que um extrato de banco brasileiro faz de
// errado e o parser tem de atravessar: linha em branco ANTES do cabeçalho,
// `DTSERVER` zerado, fechamento de tag misto (o primeiro `<STATUS>` com filhos
// abertos, o segundo com filhos fechados), `TRNAMT` com vírgula decimal e
// padding de espaços, `MEMO` com acento cp1252 e `&` cru, `FITID` igual ao
// `CHECKNUM`, `ACCTID` com espaço sobrando, e os dois saldos.
const BRADESCO = crlf([
  "",
  ...CABECALHO_V1,
  "<OFX>",
  "<SIGNONMSGSRSV1>",
  "<SONRS>",
  "<STATUS>",
  "<CODE>0",
  "<SEVERITY>INFO",
  "</STATUS>",
  "<DTSERVER>00000000000000",
  "<LANGUAGE>POR",
  "</SONRS>",
  "</SIGNONMSGSRSV1>",
  "<BANKMSGSRSV1>",
  "<STMTTRNRS>",
  "<TRNUID>1001",
  "<STATUS>",
  "<CODE>0</CODE>",
  "<SEVERITY>INFO</SEVERITY>",
  "</STATUS>",
  "<STMTRS>",
  "<CURDEF>BRL",
  "<BANKACCTFROM>",
  "<BANKID>237",
  "<ACCTID>00012345-6 ",
  "<ACCTTYPE>CHECKING",
  "</BANKACCTFROM>",
  "<BANKTRANLIST>",
  "<DTSTART>20260801",
  "<DTEND>20260831",
  "<STMTTRN>",
  "<TRNTYPE>DEBIT",
  "<DTPOSTED>20260803",
  "<TRNAMT>          -530,86",
  "<FITID>000000000001",
  "<CHECKNUM>000000000001",
  "<MEMO>PAGTO CARTÃO & COBRANÇA",
  "</STMTTRN>",
  "<STMTTRN>",
  "<TRNTYPE>CREDIT",
  "<DTPOSTED>20260805120000[-3:BRT]",
  "<TRNAMT>           847,10",
  "<FITID>000000000002",
  "<CHECKNUM>000000000002",
  "<MEMO>CRÉDITO EM CONTA",
  "</STMTTRN>",
  "</BANKTRANLIST>",
  "<LEDGERBAL>",
  "<BALAMT>          1316,24",
  "<DTASOF>20260831",
  "</LEDGERBAL>",
  "<AVAILBAL>",
  "<BALAMT>          1200,00",
  "<DTASOF>20260831",
  "</AVAILBAL>",
  "</STMTRS>",
  "</STMTTRNRS>",
  "</BANKMSGSRSV1>",
  "</OFX>",
]);

// ---------------------------------------------------------------------------
// duas-contas.ofx
// ---------------------------------------------------------------------------
// Dois `STMTTRNRS` no mesmo arquivo, e a segunda conta com UM `STMTTRN` só.
// Em SGML sem fechamento, um filho vira objeto e vários viram array: esta
// fixture trava o `asArray()` nos dois sentidos ao mesmo tempo.
const DUAS_CONTAS = crlf([
  ...CABECALHO_V1,
  "<OFX>",
  "<BANKMSGSRSV1>",
  "<STMTTRNRS>",
  "<TRNUID>1",
  "<STMTRS>",
  "<CURDEF>BRL",
  "<BANKACCTFROM>",
  "<BANKID>001",
  "<ACCTID>11111-1",
  "<ACCTTYPE>CHECKING",
  "</BANKACCTFROM>",
  "<BANKTRANLIST>",
  "<STMTTRN>",
  "<TRNTYPE>DEBIT",
  "<DTPOSTED>20260901",
  "<TRNAMT>-10,00",
  "<FITID>A1",
  "<MEMO>TARIFA",
  "</STMTTRN>",
  "<STMTTRN>",
  "<TRNTYPE>CREDIT",
  "<DTPOSTED>20260902",
  "<TRNAMT>25,50",
  "<FITID>A2",
  "<MEMO>DEPOSITO",
  "</STMTTRN>",
  "</BANKTRANLIST>",
  "<LEDGERBAL>",
  "<BALAMT>15,50",
  "<DTASOF>20260902",
  "</LEDGERBAL>",
  "</STMTRS>",
  "</STMTTRNRS>",
  "<STMTTRNRS>",
  "<TRNUID>2",
  "<STMTRS>",
  "<CURDEF>BRL",
  "<BANKACCTFROM>",
  "<BANKID>001",
  "<ACCTID>22222-2",
  "<ACCTTYPE>SAVINGS",
  "</BANKACCTFROM>",
  "<BANKTRANLIST>",
  "<STMTTRN>",
  "<TRNTYPE>INT",
  "<DTPOSTED>20260902",
  "<TRNAMT>1,07",
  "<FITID>B1",
  "<MEMO>RENDIMENTO",
  "</STMTTRN>",
  "</BANKTRANLIST>",
  "<LEDGERBAL>",
  "<BALAMT>1001,07",
  "<DTASOF>20260902",
  "</LEDGERBAL>",
  "</STMTRS>",
  "</STMTTRNRS>",
  "</BANKMSGSRSV1>",
  "</OFX>",
]);

// ---------------------------------------------------------------------------
// caixa-decimal-quebrado.ofx
// ---------------------------------------------------------------------------
// A Caixa manda `            .  ` no lugar do valor, e uma linha sintética de
// saldo com `FITID:0`. As duas coisas são armadilhas de dinheiro: `.` NÃO pode
// virar 0 (entraria no livro-caixa como lançamento válido) e `FITID:0` derruba
// a conta inteira para a chave por conteúdo. O `LEDGERBAL` também vem quebrado
// aqui — a conta fica SEM saldo, nunca com saldo zero.
const CAIXA = crlf([
  ...CABECALHO_V1,
  "<OFX>",
  "<BANKMSGSRSV1>",
  "<STMTTRNRS>",
  "<STMTRS>",
  "<CURDEF>BRL",
  "<BANKACCTFROM>",
  "<BANKID>104",
  "<ACCTID>0001300099",
  "<ACCTTYPE>CHECKING",
  "</BANKACCTFROM>",
  "<BANKTRANLIST>",
  "<STMTTRN>",
  "<TRNTYPE>OTHER",
  "<DTPOSTED>20260810",
  "<TRNAMT>            .  ",
  "<FITID>202608100001",
  "<MEMO>LANCAMENTO SEM VALOR",
  "</STMTTRN>",
  "<STMTTRN>",
  "<TRNTYPE>OTHER",
  "<DTPOSTED>20260810",
  "<TRNAMT>           250,00",
  "<FITID>0",
  "<MEMO>SALDO DIA",
  "</STMTTRN>",
  "<STMTTRN>",
  "<TRNTYPE>DEBIT",
  "<DTPOSTED>20260811",
  "<TRNAMT>           -33,02",
  "<FITID>0",
  "<MEMO>COMPRA CARTAO",
  "</STMTTRN>",
  "</BANKTRANLIST>",
  "<LEDGERBAL>",
  "<BALAMT>            .  ",
  "<DTASOF>20260811",
  "</LEDGERBAL>",
  "</STMTRS>",
  "</STMTTRNRS>",
  "</BANKMSGSRSV1>",
  "</OFX>",
]);

// ---------------------------------------------------------------------------
// fitid-repetido.ofx
// ---------------------------------------------------------------------------
// Duas transações da MESMA conta com o mesmo `FITID`. O `FITID` deixa de ser
// identificador e a conta inteira cai para a chave por conteúdo. As duas
// últimas linhas repetem (dia, valor) de propósito: é o par que só o ordinal
// distingue.
const FITID_REPETIDO = crlf([
  ...CABECALHO_V1,
  "<OFX>",
  "<BANKMSGSRSV1>",
  "<STMTTRNRS>",
  "<STMTRS>",
  "<CURDEF>BRL",
  "<BANKACCTFROM>",
  "<BANKID>033",
  "<ACCTID>13000123456",
  "<ACCTTYPE>CHECKING",
  "</BANKACCTFROM>",
  "<BANKTRANLIST>",
  "<STMTTRN>",
  "<TRNTYPE>OTHER",
  "<DTPOSTED>20260915",
  "<TRNAMT>            -11,76",
  "<FITID>779966",
  "<MEMO>TARIFA PACOTE SERVICOS",
  "</STMTTRN>",
  "<STMTTRN>",
  "<TRNTYPE>OTHER",
  "<DTPOSTED>20260915",
  "<TRNAMT>             -2,23",
  "<FITID>779966",
  "<MEMO>IOF",
  "</STMTTRN>",
  "<STMTTRN>",
  "<TRNTYPE>OTHER",
  "<DTPOSTED>20260916",
  "<TRNAMT>            -50,00",
  "<FITID>779967",
  "<MEMO>SAQUE TERMINAL 1",
  "</STMTTRN>",
  "<STMTTRN>",
  "<TRNTYPE>OTHER",
  "<DTPOSTED>20260916",
  "<TRNAMT>            -50,00",
  "<FITID>779968",
  "<MEMO>SAQUE TERMINAL 2",
  "</STMTTRN>",
  "</BANKTRANLIST>",
  "<LEDGERBAL>",
  "<BALAMT>           1885,99",
  "<DTASOF>20260916",
  "</LEDGERBAL>",
  "</STMTRS>",
  "</STMTTRNRS>",
  "</BANKMSGSRSV1>",
  "</OFX>",
]);

// ---------------------------------------------------------------------------
// memo-com-sinal.ofx
// ---------------------------------------------------------------------------
// O `<` dentro do `MEMO` é o caractere que faz a `ofx-js@1.1.1` LANÇAR — o
// arquivo inteiro do Dono se perde por causa de um sinal de menor. Aqui ele é
// texto, porque só é tag o que casa `<TAG>` / `</TAG>`.
const MEMO_COM_SINAL = crlf([
  ...CABECALHO_V1,
  "<OFX>",
  "<BANKMSGSRSV1>",
  "<STMTTRNRS>",
  "<STMTRS>",
  "<CURDEF>BRL",
  "<BANKACCTFROM>",
  "<BANKID>341",
  "<ACCTID>98765-4",
  "<ACCTTYPE>CHECKING",
  "</BANKACCTFROM>",
  "<BANKTRANLIST>",
  "<STMTTRN>",
  "<TRNTYPE>FEE",
  "<DTPOSTED>20260920",
  "<TRNAMT>-4,90",
  "<FITID>C1",
  "<MEMO>TARIFA < 5 REAIS & SEM IOF",
  "</STMTTRN>",
  "<STMTTRN>",
  "<TRNTYPE>PAYMENT",
  "<DTPOSTED>20260921",
  "<TRNAMT>-120,00",
  "<FITID>C2",
  "<MEMO>PIX ENVIADO 10 < 20 > 5",
  "</STMTTRN>",
  "</BANKTRANLIST>",
  "<LEDGERBAL>",
  "<BALAMT>300,00",
  "<DTASOF>20260921",
  "</LEDGERBAL>",
  "</STMTRS>",
  "</STMTTRNRS>",
  "</BANKMSGSRSV1>",
  "</OFX>",
]);

// ---------------------------------------------------------------------------
// cartao.ofx
// ---------------------------------------------------------------------------
// Fatura de cartão: outro ramo da árvore (`CREDITCARDMSGSRSV1`) e um
// `CCACCTFROM` que só tem `ACCTID` — não existe `BANKID`. É por isso que
// `bank_id` é `''` e não NULL: a chave e o `unique` do banco precisam dedupar.
const CARTAO = crlf([
  ...CABECALHO_V1,
  "<OFX>",
  "<CREDITCARDMSGSRSV1>",
  "<CCSTMTTRNRS>",
  "<TRNUID>9",
  "<CCSTMTRS>",
  "<CURDEF>BRL",
  "<CCACCTFROM>",
  "<ACCTID>XXXXXXXXXXXX4321",
  "</CCACCTFROM>",
  "<BANKTRANLIST>",
  "<STMTTRN>",
  "<TRNTYPE>DEBIT",
  "<DTPOSTED>20260905",
  "<TRNAMT>-89,90",
  "<FITID>CC0001",
  "<MEMO>FARMÁCIA CENTRO",
  "</STMTTRN>",
  "<STMTTRN>",
  "<TRNTYPE>CREDIT",
  "<DTPOSTED>20260910",
  "<TRNAMT>89,90",
  "<FITID>CC0002",
  "<MEMO>ESTORNO FARMÁCIA CENTRO",
  "</STMTTRN>",
  "</BANKTRANLIST>",
  "<LEDGERBAL>",
  "<BALAMT>-1240,55",
  "<DTASOF>20260930",
  "</LEDGERBAL>",
  "</CCSTMTRS>",
  "</CCSTMTTRNRS>",
  "</CREDITCARDMSGSRSV1>",
  "</OFX>",
]);

// ---------------------------------------------------------------------------
// ofx2.xml.ofx
// ---------------------------------------------------------------------------
// O MESMO conteúdo do `bradesco-like.ofx`, agora em OFX 2.x: XML de verdade,
// tudo fechado, UTF-8, `&` escapado como `&amp;`. O teste afirma que os dois
// arquivos produzem lançamentos IDÊNTICOS — é a prova de que um tokenizer só
// lê as duas versões, sem `if (versao === 2)` em lugar nenhum.
const OFX2 = crlf([
  '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
  '<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>',
  "<OFX>",
  "  <SIGNONMSGSRSV1>",
  "    <SONRS>",
  "      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>",
  "      <DTSERVER>00000000000000</DTSERVER>",
  "      <LANGUAGE>POR</LANGUAGE>",
  "    </SONRS>",
  "  </SIGNONMSGSRSV1>",
  "  <BANKMSGSRSV1>",
  "    <STMTTRNRS>",
  "      <TRNUID>1001</TRNUID>",
  "      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>",
  "      <STMTRS>",
  "        <CURDEF>BRL</CURDEF>",
  "        <BANKACCTFROM>",
  "          <BANKID>237</BANKID>",
  "          <ACCTID>00012345-6 </ACCTID>",
  "          <ACCTTYPE>CHECKING</ACCTTYPE>",
  "        </BANKACCTFROM>",
  "        <BANKTRANLIST>",
  "          <DTSTART>20260801</DTSTART>",
  "          <DTEND>20260831</DTEND>",
  "          <STMTTRN>",
  "            <TRNTYPE>DEBIT</TRNTYPE>",
  "            <DTPOSTED>20260803</DTPOSTED>",
  "            <TRNAMT>-530.86</TRNAMT>",
  "            <FITID>000000000001</FITID>",
  "            <CHECKNUM>000000000001</CHECKNUM>",
  "            <MEMO>PAGTO CARTÃO &amp; COBRANÇA</MEMO>",
  "          </STMTTRN>",
  "          <STMTTRN>",
  "            <TRNTYPE>CREDIT</TRNTYPE>",
  "            <DTPOSTED>20260805120000[-3:BRT]</DTPOSTED>",
  "            <TRNAMT>847.10</TRNAMT>",
  "            <FITID>000000000002</FITID>",
  "            <CHECKNUM>000000000002</CHECKNUM>",
  "            <MEMO>CRÉDITO EM CONTA</MEMO>",
  "          </STMTTRN>",
  "        </BANKTRANLIST>",
  "        <LEDGERBAL>",
  "          <BALAMT>1316.24</BALAMT>",
  "          <DTASOF>20260831</DTASOF>",
  "        </LEDGERBAL>",
  "        <AVAILBAL>",
  "          <BALAMT>1200.00</BALAMT>",
  "          <DTASOF>20260831</DTASOF>",
  "        </AVAILBAL>",
  "      </STMTRS>",
  "    </STMTTRNRS>",
  "  </BANKMSGSRSV1>",
  "</OFX>",
]);

/** `latin1` é o apelido do Node para o byte-a-byte de cp1252 na faixa alta. */
const V1 = [
  ["bradesco-like.ofx", BRADESCO],
  ["duas-contas.ofx", DUAS_CONTAS],
  ["caixa-decimal-quebrado.ofx", CAIXA],
  ["fitid-repetido.ofx", FITID_REPETIDO],
  ["memo-com-sinal.ofx", MEMO_COM_SINAL],
  ["cartao.ofx", CARTAO],
];

for (const [nome, texto] of V1) {
  writeFileSync(join(AQUI, nome), Buffer.from(texto, "latin1"));
  console.info(`escrito ${nome} (cp1252, CRLF)`);
}
writeFileSync(join(AQUI, "ofx2.xml.ofx"), Buffer.from(OFX2, "utf8"));
console.info("escrito ofx2.xml.ofx (utf-8, CRLF)");
