/**
 * Léxico do Conteúdo Clínico (ADR-0004, ADR-0012). Português do WhatsApp, sem
 * acento (o classificador normaliza antes de casar).
 *
 * Três categorias, na ordem em que o motivo é decidido: medicação (o mais
 * inequívoco), condição, sintoma. As listas são chaves de léxico, não texto do
 * Contato — e mesmo assim NUNCA são persistidas (ver `redacao.ts`).
 *
 * O que NÃO está aqui, de propósito: os catorze serviços da clínica
 * (cardiologia, psiquiatria, nutrição…), "consulta", "exame", "check-up".
 * Escolher é o que o Agente ofereceu; não é Conteúdo Clínico.
 */

export const MEDICACOES: readonly string[] = [
  "losartana", "rivotril", "clonazepam", "fluoxetina", "sertralina", "metformina",
  "insulina", "omeprazol", "dipirona", "paracetamol", "ibuprofeno", "amoxicilina",
  "azitromicina", "antibiotico", "anticoncepcional", "atenolol", "captopril",
  "enalapril", "hidroclorotiazida", "sinvastatina", "levotiroxina", "puran",
  "diazepam", "alprazolam", "escitalopram", "venlafaxina", "risperidona",
  "quetiapina", "prednisona", "corticoide", "dexametasona", "nimesulida",
  "diclofenaco", "tramadol", "codeina", "morfina", "ritalina", "metilfenidato",
  "glifage", "ozempic", "saxenda", "vitamina d", "ferro",
];

/** Palavras que, junto de um verbo de uso, denunciam medicação sem nomear. */
export const MARCADORES_DE_MEDICACAO: readonly string[] = [
  "remedio", "remedios", "medicamento", "medicamentos", "medicacao", "receita",
  "controlado", "controlados", "comprimido", "comprimidos", "dose", "doses",
  "gotas", "injecao", "antibiotico", "antidepressivo", "ansiolitico", "anti-inflamatorio",
  "antialergico", "calmante", "tarja preta",
];

export const CONDICOES: readonly string[] = [
  "diabetes", "diabetico", "diabetica", "hipertensao", "hipertenso", "hipertensa",
  "asma", "asmatico", "asmatica", "hipotireoidismo", "hipertireoidismo", "tireoide",
  "ansiedade", "panico", "depressao", "depressiva", "depressivo", "bipolar",
  "esquizofrenia", "tdah", "autismo", "epilepsia", "convulsao", "convulsoes",
  "gastrite", "refluxo", "ulcera", "alzheimer", "parkinson", "demencia",
  "infeccao", "dengue", "covid", "gripe", "pneumonia", "bronquite", "sinusite",
  "rinite", "cancer", "tumor", "avc", "derrame", "infarto", "arritmia",
  "colesterol", "anemia", "obesidade", "gravida", "gravidez", "gestante",
  "sangramento", "hemorragia", "fratura", "hernia", "artrose", "artrite",
  "fibromialgia", "enxaqueca", "labirintite", "cistite", "candidiase", "hpv",
  "hiv", "hepatite", "lupus", "psoriase", "dermatite", "alergia", "alergico", "alergica",
  "diagnosticado", "diagnosticada", "diagnostico", "suspeita de",
];

export const SINTOMAS: readonly string[] = [
  "dor", "dores", "febre", "tosse", "falta de ar", "enjoo", "nausea", "vomito",
  "vomitando", "diarreia", "inchado", "inchada", "inchaco", "vermelho", "vermelha",
  "coceira", "cocando", "tontura", "tonto", "tonta", "desmaio", "desmaiei",
  "sangrando", "vomitando sangue", "urinando sangue", "sangue na", "sangue no", "ferida", "machucado", "queimadura", "manchas",
  "mancha", "caroco", "nodulo", "cansaco", "fraqueza", "formigamento",
  "dormencia", "palpitacao", "pressao alta", "pressao baixa", "glicose",
  "azia", "queimacao", "colica", "corrimento", "ardencia", "urinar",
  "insonia", "sintoma", "sintomas", "crise", "crises", "grave", "cicatriza",
];

/** Formas que denunciam sintoma sem palavra de lista: "tô com …", "sinto …". */
export const FORMAS_DE_SINTOMA: readonly RegExp[] = [
  /\b(to|estou|esta|tá|ta|fiquei|acordei)\s+com\s+(uma?\s+|muita\s+|muito\s+)?(dor|febre|tosse|enjoo|coceira|tontura|falta de ar)/,
  /\bsinto\s+(uma?\s+)?dor/,
  /\bpressao\s+(ta|esta|estava|tá)\s+(alta|baixa)/,
  /\bdor\s+(de|no|na|nos|nas)\s+\w+/,
  /\b\w{6,}(ite|ose|algia)\b/,
];

/** Dose e frequência: "50mg", "2 comprimidos", "de 8 em 8 horas". */
export const FORMAS_DE_DOSE: readonly RegExp[] = [
  /\b\d+\s?(mg|ml|mcg|g|ui)\b/,
  /\b\d+\s+(comprimidos?|gotas|capsulas?)\b/,
  /\bde\s+\d+\s+em\s+\d+\s+horas?\b/,
  /\b(tomo|tomando|tomar|tomei|parei de tomar|esqueci de tomar|acabou (o|a|meu|minha))\s+\w+/,
];

/** Sufixos clínicos exigem palavra longa; estas são exceções comuns que casam por acaso. */
export const EXCECOES_DE_SUFIXO: readonly string[] = [
  "gratuite", "visite", "limite", "limites", "aceite", "convite", "convites",
  "elite", "site", "noite", "noites", "palmite", "palmites", "cite", "recite",
  "dose",
];
