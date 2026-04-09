const fs = require('fs');
const XLSX = require('xlsx');

const TAXA_FILE = 'C:/Users/grupomateus/Downloads/relatorio_de_exportacao_taxas.xls';
const REDE_FILE = 'C:/Users/grupomateus/Downloads/02554_102737762_20260402_VENDA_E_PAGTO_REDE-API_MATEUSFOOD.TXT';

// ===== PARSE CADASTRO DE TAXAS =====
const wb = XLSX.readFile(TAXA_FILE);
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', header: 1 });

const taxas = [];
for (let i = 2; i < rows.length; i++) {
  const r = rows[i];
  if (!r[0]) continue;
  const plano = String(r[5] || '').trim().toUpperCase();
  let parcMin = 1, parcMax = 1;
  if (plano === 'ROTATIVO' || plano.includes('VISTA')) { parcMin = 1; parcMax = 1; }
  else if (plano.includes('2') && plano.includes('6')) { parcMin = 2; parcMax = 6; }
  else if (plano.includes('7') && plano.includes('12')) { parcMin = 7; parcMax = 12; }
  else if (plano === 'DÉBITO' || plano === 'DEBITO') { parcMin = 1; parcMax = 1; }
  else if (plano === 'VOUCHER') { parcMin = 1; parcMax = 1; }

  taxas.push({
    adquirente: String(r[0]).trim(),
    bandeira: String(r[1]).trim(),
    plano,
    natureza: String(r[7] || '').trim().toUpperCase(),
    taxa: parseFloat(r[9]) || 0,
    vigInicio: String(r[10] || ''),
    vigFim: String(r[11] || ''),
    parcMin,
    parcMax,
  });
}
console.log('Taxas cadastradas:', taxas.length);

// ===== PARSE VENDAS REDE (JSON) =====
const redeContent = fs.readFileSync(REDE_FILE, 'utf-8');
const redeData = JSON.parse(redeContent);
const vendas = (redeData.content?.transactions || []).map(tx => {
  let bandeira = 'N/I';
  const bc = tx.brandCode;
  if (bc === 1) bandeira = 'MasterCard';
  else if (bc === 2) bandeira = 'Visa';
  else if (bc === 3) bandeira = 'Elo';
  else if (bc === 4) bandeira = 'Amex';
  else if (bc === 5) bandeira = 'HiperCard';

  const tipo = tx.modality?.type || '';
  let natureza = 'CRÉDITO';
  if (tipo === 'DEBIT') natureza = 'DÉBITO';
  else if (tipo === 'VAN' || tipo === 'VOUCHER') natureza = 'VOUCHER';

  return {
    bruto: tx.amount || 0,
    liq: tx.netAmount || 0,
    taxaCobrada: tx.mdrFee || 0,
    taxaValor: tx.discountAmount || 0,
    nsu: String(tx.nsu || ''),
    autorizacao: String(tx.authorizationCode || ''),
    bandeira,
    natureza,
    parcelas: tx.installmentQuantity || 1,
    hora: tx.saleHour || '',
    data: tx.saleDate || '',
    produto: tx.modality?.product || '',
  };
});
console.log('Vendas Rede:', vendas.length);

// ===== CONFRONTAR TAXAS =====
function findTaxa(bandeira, natureza, parcelas) {
  // Buscar taxa cadastrada para essa combinacao
  for (const t of taxas) {
    if (t.bandeira.toUpperCase() === bandeira.toUpperCase() &&
        t.natureza === natureza &&
        parcelas >= t.parcMin && parcelas <= t.parcMax) {
      return t;
    }
  }
  // Tentar sem bandeira especifica
  for (const t of taxas) {
    if (t.natureza === natureza &&
        parcelas >= t.parcMin && parcelas <= t.parcMax) {
      return t;
    }
  }
  return null;
}

const resultado = [];
let totalOk = 0, totalDif = 0, totalSemCadastro = 0;
let valorOk = 0, valorDif = 0, valorPerdido = 0;

for (const v of vendas) {
  const taxaCad = findTaxa(v.bandeira, v.natureza, v.parcelas);
  const taxaEsperada = taxaCad ? taxaCad.taxa : null;
  const taxaCobradaPct = v.bruto > 0 ? (v.taxaValor / v.bruto) * 100 : 0;

  let status = 'SEM_CADASTRO';
  let diferenca = 0;

  if (taxaEsperada !== null) {
    diferenca = Math.abs(taxaCobradaPct - taxaEsperada);
    if (diferenca <= 0.05) {
      status = 'OK';
      totalOk++;
      valorOk += v.bruto;
    } else {
      status = 'DIVERGENTE';
      totalDif++;
      valorDif += v.bruto;
      valorPerdido += v.taxaValor - (v.bruto * taxaEsperada / 100);
    }
  } else {
    totalSemCadastro++;
  }

  resultado.push({
    data: v.data,
    hora: v.hora,
    bandeira: v.bandeira,
    natureza: v.natureza,
    parcelas: v.parcelas,
    bruto: v.bruto,
    taxaValor: v.taxaValor,
    taxaCobradaPct: Math.round(taxaCobradaPct * 100) / 100,
    taxaEsperadaPct: taxaEsperada,
    diferenca: Math.round(diferenca * 100) / 100,
    diferencaValor: taxaEsperada !== null ? Math.round((v.taxaValor - (v.bruto * taxaEsperada / 100)) * 100) / 100 : 0,
    status,
    nsu: v.nsu,
    autorizacao: v.autorizacao,
    plano: taxaCad ? taxaCad.plano : 'N/I',
  });
}

// Resumo por bandeira+natureza
const resumo = [];
const groups = new Map();
for (const r of resultado) {
  const key = r.bandeira + '|' + r.natureza;
  if (!groups.has(key)) groups.set(key, { bandeira: r.bandeira, natureza: r.natureza, ok: 0, div: 0, sem: 0, totalBruto: 0, totalTaxaCobrada: 0, totalTaxaEsperada: 0, totalDifValor: 0 });
  const g = groups.get(key);
  g.totalBruto += r.bruto;
  g.totalTaxaCobrada += r.taxaValor;
  if (r.status === 'OK') { g.ok++; g.totalTaxaEsperada += r.bruto * r.taxaEsperadaPct / 100; }
  else if (r.status === 'DIVERGENTE') { g.div++; g.totalTaxaEsperada += r.bruto * r.taxaEsperadaPct / 100; g.totalDifValor += r.diferencaValor; }
  else { g.sem++; }
}

for (const [, g] of groups) {
  resumo.push({
    bandeira: g.bandeira,
    natureza: g.natureza,
    qtdOk: g.ok,
    qtdDiv: g.div,
    qtdSem: g.sem,
    totalBruto: Math.round(g.totalBruto * 100) / 100,
    totalTaxaCobrada: Math.round(g.totalTaxaCobrada * 100) / 100,
    totalTaxaEsperada: Math.round(g.totalTaxaEsperada * 100) / 100,
    diferencaValor: Math.round(g.totalDifValor * 100) / 100,
  });
}

const output = {
  empresa: 'MATEUS FOOD',
  empresaId: 301,
  adquirente: 'Rede',
  data: '02/04/2026',
  taxasCadastradas: taxas,
  summary: {
    totalVendas: vendas.length,
    totalOk,
    totalDivergente: totalDif,
    totalSemCadastro,
    valorTotal: Math.round(vendas.reduce((s, v) => s + v.bruto, 0) * 100) / 100,
    taxaCobradaTotal: Math.round(vendas.reduce((s, v) => s + v.taxaValor, 0) * 100) / 100,
    valorPerdido: Math.round(valorPerdido * 100) / 100,
  },
  resumo,
  detalhe: resultado,
};

fs.writeFileSync('C:/Users/grupomateus/OneDrive/Área de Trabalho/Projetos IA/conciliacao-spring/conciliacao-taxas.json', JSON.stringify(output));

console.log('');
console.log('=== RESULTADO CONCILIACAO DE TAXAS ===');
console.log('Empresa:', output.empresa, '| Adquirente:', output.adquirente);
console.log('Total vendas:', output.summary.totalVendas);
console.log('Taxa OK:', totalOk, '(' + ((totalOk / vendas.length) * 100).toFixed(1) + '%)');
console.log('Taxa DIVERGENTE:', totalDif, '(' + ((totalDif / vendas.length) * 100).toFixed(1) + '%)');
console.log('Sem cadastro:', totalSemCadastro);
console.log('Valor perdido em taxa:', 'R$', output.summary.valorPerdido.toFixed(2));
console.log('');
console.log('Por bandeira/natureza:');
resumo.forEach(r => {
  console.log('  ' + r.bandeira + '/' + r.natureza + ': OK=' + r.qtdOk + ' DIV=' + r.qtdDiv + ' SEM=' + r.qtdSem + ' DifValor=R$' + r.diferencaValor.toFixed(2));
});
