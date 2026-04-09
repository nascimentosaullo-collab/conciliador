const fs = require('fs');

const REDE_FILE = 'C:/Users/grupomateus/Downloads/02554_102737762_20260402_VENDA_E_PAGTO_REDE-API_MATEUSFOOD.TXT';
const FN01_FILE = 'C:/Users/grupomateus/Downloads/fn010204food';

// ===== PARSE REDE (JSON API) =====
const redeContent = fs.readFileSync(REDE_FILE, 'utf-8');
const redeData = JSON.parse(redeContent);
const redeTxs = (redeData.content?.transactions || []).map(tx => {
  let bandeira = 'N/I';
  const bc = tx.brandCode;
  if (bc === 1) bandeira = 'MasterCard';
  else if (bc === 2) bandeira = 'Visa';
  else if (bc === 3) bandeira = 'Elo';
  else if (bc === 4) bandeira = 'Amex';
  else if (bc === 5) bandeira = 'Hipercard';
  else if (bc === 6) bandeira = 'Hiper';
  // Tambem verificar pelo nome se disponivel
  if (tx.brandName) {
    if (tx.brandName.includes('MASTER')) bandeira = 'MasterCard';
    else if (tx.brandName.includes('VISA')) bandeira = 'Visa';
    else if (tx.brandName.includes('ELO')) bandeira = 'Elo';
  }

  return {
    bruto: tx.amount || 0,
    liq: tx.netAmount || 0,
    taxa: tx.discountAmount || 0,
    mdrFee: tx.mdrFee || 0,
    nsu: String(tx.nsu || ''),
    autorizacao: String(tx.authorizationCode || ''),
    bandeira,
    tipo: tx.modality?.type || '',
    produto: tx.modality?.product || '',
    parcelas: tx.installmentQuantity || 1,
    cartao: tx.cardNumber || '',
    hora: tx.saleHour || '',
    data: tx.saleDate || '',
    device: tx.device || '',
    matched: false,
  };
});
console.log('REDE:', redeTxs.length, 'transacoes');

// ===== PARSE FN01 (SQL INSERT) =====
const fn01Content = fs.readFileSync(FN01_FILE, 'utf-8');
const fn01Lines = fn01Content.split('\n').filter(l => l.trim().startsWith('INSERT'));

// Extrair valores dos INSERTs
const fn01Raw = [];
for (const line of fn01Lines) {
  const valuesMatch = line.match(/VALUES\s*\((.+)\);?\s*$/i);
  if (!valuesMatch) continue;
  const raw = valuesMatch[1];

  const values = [];
  let curr = '';
  let inStr = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "'" && !inStr) { inStr = true; continue; }
    if (ch === "'" && inStr) {
      if (raw[i+1] === "'") { curr += "'"; i++; continue; }
      inStr = false; continue;
    }
    if (ch === ',' && !inStr) {
      values.push(curr.trim().replace(/^N$/, ''));
      curr = '';
      continue;
    }
    if (ch === 'N' && raw[i+1] === "'" && !inStr) { continue; }
    curr += ch;
  }
  values.push(curr.trim());

  // Mapear campos pelo INSERT que ja conhecemos
  // FN01_VALOR_TITULO = campo 16 (indice 16)
  // FN01_DT_EMISSAO = campo 7
  // FN01_NUMERO_TITULO = campo 14
  // FN01_NUMERO_NSU_SITEF = campo 63 (FN01_NUMERO_NSU_SITEF)
  // FN01_NUMERO_NSU_HOST = campo 64 (FN01_NUMERO_NSU_HOST)
  // FN01_NUMERO_CUPOM = campo 62
  // FN01_PARCELA = campo 69
  // FN01_QTDE_PARCELA = campo 71
  // FN01_VALOR_DESCONTO_GERENCIAL = campo 20 (taxa)
  // FN01_VALOR_DEVEDOR = campo 26 (valor liquido)
  // FN01_NUMERO_CARTAO = campo 65
  // FN01_NUME_DOCUMENTO = campo 13

  if (values.length < 30) continue;

  const valorTitulo = parseFloat(values[16]) || 0;
  if (valorTitulo === 0) continue;

  fn01Raw.push({
    sequ: values[0],
    filial: values[1],
    dtEmissao: values[7]?.replace(/N?'?/g, '') || '',
    numeDocumento: values[13]?.replace(/N?'?/g, '') || '',
    titulo: values[14]?.replace(/N?'?/g, '') || '',
    valor: valorTitulo,
    taxa: parseFloat(values[20]) || 0,
    valorLiq: parseFloat(values[26]) || 0,
    nsuSitef: values[63]?.replace(/N?'?/g, '').trim() || '',
    nsuHost: values[64]?.replace(/N?'?/g, '').trim() || '',
    cupom: values[62]?.replace(/N?'?/g, '').trim() || '',
    cartao: values[65]?.replace(/N?'?/g, '').trim() || '',
    parcela: parseInt(values[69]) || 1,
    qtdeParcela: parseInt(values[71]) || 1,
    cnpj: values[77]?.replace(/N?'?/g, '') || '',
    loja: values[75]?.replace(/N?'?/g, '') || '',
  });
}
console.log('FN01 linhas INSERT:', fn01Raw.length);

// Agrupar FN01 por numeDocumento (parcelas)
const fn01G = new Map();
for (const r of fn01Raw) {
  if (!fn01G.has(r.numeDocumento)) {
    fn01G.set(r.numeDocumento, { ...r, valor: 0, taxa: 0, valorLiq: 0, parcelas: 0 });
  }
  const g = fn01G.get(r.numeDocumento);
  g.valor += r.valor;
  g.taxa += r.taxa;
  g.valorLiq += r.valorLiq;
  g.parcelas++;
}
const fn01Txs = [...fn01G.values()].map(g => ({
  ...g,
  valor: Math.round(g.valor * 100) / 100,
  taxa: Math.round(g.taxa * 100) / 100,
  valorLiq: Math.round(g.valorLiq * 100) / 100,
  matched: false,
}));
console.log('FN01 agrupado:', fn01Txs.length, 'transacoes');

// ===== CONCILIACAO Rede x FN01 =====
// Chave principal: NSU Host (Rede.autorizacao = FN01.nsuHost) - TESTAR
const fn01ByNsuHost = new Map();
for (const f of fn01Txs) {
  if (f.nsuHost) {
    if (!fn01ByNsuHost.has(f.nsuHost)) fn01ByNsuHost.set(f.nsuHost, []);
    fn01ByNsuHost.get(f.nsuHost).push(f);
  }
}

// Testar match por NSU Host
let matchNsu = 0;
for (const r of redeTxs) {
  const fn = (fn01ByNsuHost.get(r.autorizacao) || []).find(f => !f.matched);
  if (fn) matchNsu++;
}
console.log('Teste match Rede.autorizacao -> FN01.nsuHost:', matchNsu);

// Testar match por NSU
const fn01ByNsuSitef = new Map();
for (const f of fn01Txs) {
  if (f.nsuSitef) {
    if (!fn01ByNsuSitef.has(f.nsuSitef)) fn01ByNsuSitef.set(f.nsuSitef, []);
    fn01ByNsuSitef.get(f.nsuSitef).push(f);
  }
}
let matchNsuSitef = 0;
for (const r of redeTxs) {
  const fn = (fn01ByNsuSitef.get(r.nsu) || []).find(f => !f.matched);
  if (fn) matchNsuSitef++;
}
console.log('Teste match Rede.nsu -> FN01.nsuSitef:', matchNsuSitef);

// Conciliacao real: NSU Host primeiro, depois valor
const fn01ByVal = new Map();
for (const f of fn01Txs) {
  const k = f.valor.toFixed(2);
  if (!fn01ByVal.has(k)) fn01ByVal.set(k, []);
  fn01ByVal.get(k).push(f);
}

const pares = [];
let countNsu = 0, countVal = 0;

for (const r of redeTxs) {
  let fn = null;

  // Prioridade 1: Rede.autorizacao = FN01.nsuHost
  if (r.autorizacao) {
    fn = (fn01ByNsuHost.get(r.autorizacao) || []).find(f => !f.matched);
    if (fn) countNsu++;
  }

  // Prioridade 2: Valor bruto
  if (!fn) {
    const k = r.bruto.toFixed(2);
    fn = (fn01ByVal.get(k) || []).find(f => !f.matched);
    if (fn) countVal++;
  }

  if (fn) {
    fn.matched = true;
    r.matched = true;
    pares.push({ adquirente: r, cliente: fn });
  }
}

console.log('');
console.log('=== RESULTADO ===');
console.log('Match por NSU Host:', countNsu);
console.log('Match por Valor:', countVal);
console.log('Total conciliado:', pares.length, '(' + ((pares.length / redeTxs.length) * 100).toFixed(1) + '%)');
console.log('Somente Adquirente:', redeTxs.filter(r => !r.matched).length);
console.log('Somente ERP:', fn01Txs.filter(f => !f.matched).length);

// Gerar resumo por bandeira
const bandList = ['Visa', 'MasterCard', 'Elo', 'Amex', 'Hipercard', 'N/I'];
const resumo = [];
for (const band of bandList) {
  const rB = redeTxs.filter(r => r.bandeira === band);
  const paresBand = pares.filter(p => p.adquirente.bandeira === band);
  // FN01 nao tem bandeira, usar dos pares
  const fMatchedBand = paresBand.map(p => p.cliente);
  const fUnmatched = fn01Txs.filter(f => !f.matched);

  if (rB.length === 0 && paresBand.length === 0) continue;

  const rVal = rB.reduce((s, r) => s + r.bruto, 0);
  const fVal = fMatchedBand.reduce((s, f) => s + f.valor, 0);

  resumo.push({
    bandeira: band,
    clienteQtd: fMatchedBand.length,
    clienteValor: Math.round(fVal * 100) / 100,
    adqQtd: rB.length,
    adqValor: Math.round(rVal * 100) / 100,
    conciliada: paresBand.length > 0 && Math.abs(fVal - rVal) / Math.max(rVal, 1) < 0.05,
  });
}

// Adicionar N/I para FN01 nao conciliados
const fn01Unmatched = fn01Txs.filter(f => !f.matched);
if (fn01Unmatched.length > 0) {
  const existing = resumo.find(r => r.bandeira === 'N/I');
  if (existing) {
    existing.clienteQtd += fn01Unmatched.length;
    existing.clienteValor += Math.round(fn01Unmatched.reduce((s, f) => s + f.valor, 0) * 100) / 100;
  } else {
    resumo.push({
      bandeira: 'N/I',
      clienteQtd: fn01Unmatched.length,
      clienteValor: Math.round(fn01Unmatched.reduce((s, f) => s + f.valor, 0) * 100) / 100,
      adqQtd: 0,
      adqValor: 0,
      conciliada: false,
    });
  }
}

// Detalhe por bandeira
const detalhe = {};
for (const band of bandList) {
  const paresBand = pares.filter(p => p.adquirente.bandeira === band);
  const adqSem = redeTxs.filter(r => r.bandeira === band && !r.matched);

  const conciliados = paresBand.map(p => ({
    cTitulo: p.cliente.titulo, cData: '02/04/2026', cNsu: p.cliente.nsuSitef, cAuth: p.cliente.nsuHost, cPlano: p.cliente.parcelas, cValor: p.cliente.valor,
    aData: '02/04/2026', aNsu: p.adquirente.nsu, aAuth: p.adquirente.autorizacao, aPlano: p.adquirente.parcelas, aValor: p.adquirente.bruto, aMeio: 'TEF',
    sit: true
  }));

  const naoConciliados = [];
  adqSem.forEach(r => {
    naoConciliados.push({
      cTitulo: '', cData: '', cNsu: '', cAuth: '', cPlano: '', cValor: '',
      aData: '02/04/2026', aNsu: r.nsu, aAuth: r.autorizacao, aPlano: r.parcelas, aValor: r.bruto, aMeio: 'TEF',
      sit: false, tipo: 'adq'
    });
  });

  if (conciliados.length > 0 || naoConciliados.length > 0) {
    detalhe[band] = { conciliados, naoConciliados };
  }
}

// FN01 nao conciliados no detalhe N/I
if (fn01Unmatched.length > 0) {
  if (!detalhe['N/I']) detalhe['N/I'] = { conciliados: [], naoConciliados: [] };
  fn01Unmatched.forEach(f => {
    detalhe['N/I'].naoConciliados.push({
      cTitulo: f.titulo, cData: '02/04/2026', cNsu: f.nsuSitef, cAuth: f.nsuHost, cPlano: f.parcelas, cValor: f.valor,
      aData: '', aNsu: '', aAuth: '', aPlano: '', aValor: '', aMeio: '',
      sit: false, tipo: 'erp'
    });
  });
}

const output = {
  data: '02/04/2026',
  empresa: 'MATEUS FOOD',
  adquirente: 'Rede',
  totalCliente: { qtd: fn01Txs.length, valor: Math.round(fn01Txs.reduce((s, f) => s + f.valor, 0) * 100) / 100 },
  totalAdq: { qtd: redeTxs.length, valor: Math.round(redeTxs.reduce((s, r) => s + r.bruto, 0) * 100) / 100 },
  resumo,
  detalhe,
};

fs.writeFileSync('C:/Users/grupomateus/OneDrive/Área de Trabalho/Projetos IA/conciliacao-spring/conciliacao-visao-vendas.json', JSON.stringify(output));
console.log('');
console.log('JSON salvo!');
resumo.forEach(r => console.log(r.bandeira, '- Cliente:', r.clienteQtd, 'R$' + r.clienteValor, '| Adq:', r.adqQtd, 'R$' + r.adqValor));
