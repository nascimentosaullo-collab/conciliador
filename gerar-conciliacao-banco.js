const fs = require('fs');

const EEFI_FILE = 'C:/Users/grupomateus/Downloads/REDE_102737762_02042026_EEFI_056.txt';
const EEVD_FILE = 'C:/Users/grupomateus/Downloads/REDE_102737762_02042026_EEVD_056.txt';
const EXTRATO_FILE = 'C:/Users/grupomateus/Downloads/P0250304.416220204 (1).RET';
const FN01_FILE = 'C:/Users/grupomateus/Downloads/30131030204food.sql';

// ===== 1. PARSE EEFI (Liquidacao Credito) =====
const eefiContent = fs.readFileSync(EEFI_FILE, 'utf-8');
const eefiLines = eefiContent.split('\n').filter(l => l.startsWith('034'));
const eefiTxs = [];
for (const l of eefiLines) {
  const valor = parseInt(l.substring(31, 46)) / 100;
  const tipo = l.substring(46, 47); // C = credito
  // Data venda: procurar na posicao 80-88
  const dataVenda = l.substring(80, 88);
  const dvDD = dataVenda.substring(0,2), dvMM = dataVenda.substring(2,4), dvYYYY = dataVenda.substring(4);
  const parcInfo = l.substring(127, 131); // parcela ex: 01/01
  const parc = parcInfo.substring(0,2);
  const totalParc = parcInfo.substring(3,5);

  eefiTxs.push({
    valor, tipo, natureza: 'CREDITO',
    dataVenda: dvYYYY + '-' + dvMM + '-' + dvDD,
    dataPgto: '2026-04-02',
    parcela: parseInt(parc) || 1,
    totalParcelas: parseInt(totalParc) || 1,
  });
}
console.log('EEFI (credito):', eefiTxs.length, 'registros, R$', eefiTxs.reduce((s,t) => s+t.valor, 0).toFixed(2));

// ===== 2. PARSE EEVD (Liquidacao Debito) =====
const eevdContent = fs.readFileSync(EEVD_FILE, 'utf-8');
const eevdLines = eevdContent.split('\n').filter(l => l.startsWith('05,'));
const eevdTxs = [];
for (const l of eevdLines) {
  const f = l.split(',');
  const dataVenda = f[3] || ''; // DDMMYYYY
  const dvDD = dataVenda.substring(0,2), dvMM = dataVenda.substring(2,4), dvYYYY = dataVenda.substring(4);
  const valorBruto = parseInt(f[4] || '0') / 100;
  const taxa = parseInt(f[5] || '0') / 100;
  const valorLiq = parseInt(f[6] || '0') / 100;
  const nsu = (f[9] || '').trim();
  const autorizacao = (f[19] || '').trim();
  const bandeira = (f[7] || '').trim(); // cartao mascarado

  eevdTxs.push({
    valor: valorLiq, valorBruto, taxa, natureza: 'DEBITO',
    dataVenda: dvYYYY + '-' + dvMM + '-' + dvDD,
    dataPgto: '2026-04-02',
    nsu, autorizacao, parcela: 1, totalParcelas: 1,
  });
}
console.log('EEVD (debito):', eevdTxs.length, 'registros, R$', eevdTxs.reduce((s,t) => s+t.valor, 0).toFixed(2));

// ===== 3. PARSE EXTRATO BANCARIO =====
const extratoContent = fs.readFileSync(EXTRATO_FILE, 'utf-8');
const extratoLines = extratoContent.split('\n');
const extratoRede = [];
for (const l of extratoLines) {
  if (!l.includes('REDE')) continue;
  const valor = parseInt(l.substring(150, 168)) / 100;
  const historico = l.substring(172, 210).trim();
  const histMatch = historico.match(/REDE\s+(\w+)\s+(CD|DB)(\d+)/);
  let bandeira = 'N/I', natureza = 'N/I', ec = '';
  if (histMatch) {
    bandeira = histMatch[1];
    if (bandeira === 'MAST') bandeira = 'MasterCard';
    natureza = histMatch[2] === 'CD' ? 'CREDITO' : 'DEBITO';
    ec = histMatch[3];
  }
  extratoRede.push({ valor, bandeira, natureza, ec, historico });
}
console.log('Extrato banco REDE:', extratoRede.length, 'lancamentos, R$', extratoRede.reduce((s,t) => s+t.valor, 0).toFixed(2));

// ===== 4. PARSE FN01 =====
const fn01Content = fs.readFileSync(FN01_FILE, 'utf-8');
const fn01Lines = fn01Content.split('\n').filter(l => l.trim().startsWith('INSERT'));
const fn01Raw = [];
for (const line of fn01Lines) {
  const valuesMatch = line.match(/VALUES\s*\((.+)\);?\s*$/i);
  if (!valuesMatch) continue;
  const raw = valuesMatch[1];
  const values = [];
  let curr = '', inStr = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "'" && !inStr) { inStr = true; continue; }
    if (ch === "'" && inStr) { if (raw[i+1] === "'") { curr += "'"; i++; continue; } inStr = false; continue; }
    if (ch === ',' && !inStr) { values.push(curr.trim().replace(/^N$/, '')); curr = ''; continue; }
    if (ch === 'N' && raw[i+1] === "'" && !inStr) { continue; }
    curr += ch;
  }
  values.push(curr.trim());
  if (values.length < 30) continue;
  const v = parseFloat(values[16]) || 0;
  if (!v) continue;
  fn01Raw.push({
    sequ: values[0], dtEmissao: values[7], dtVenc: values[9],
    numeDoc: values[13], titulo: values[14], valor: v,
    taxa: parseFloat(values[20]) || 0, valorLiq: parseFloat(values[26]) || 0,
    nsuSitef: values[63]?.trim() || '', nsuHost: values[64]?.trim() || '',
    parcela: parseInt(values[69]) || 1, qtdeParcela: parseInt(values[71]) || 1,
    loja: values[75]?.substring(0, 30) || '',
  });
}
// Agrupar por numeDoc
const fn01G = new Map();
for (const r of fn01Raw) {
  if (!fn01G.has(r.numeDoc)) fn01G.set(r.numeDoc, { ...r, valor: 0, taxa: 0, valorLiq: 0, parcelas: 0 });
  const g = fn01G.get(r.numeDoc);
  g.valor += r.valor; g.taxa += r.taxa; g.valorLiq += r.valorLiq; g.parcelas++;
}
const fn01Txs = [...fn01G.values()].map(g => ({
  ...g, valor: Math.round(g.valor * 100) / 100,
  taxa: Math.round(g.taxa * 100) / 100, valorLiq: Math.round(g.valorLiq * 100) / 100, matched: false,
}));
console.log('FN01:', fn01Txs.length, 'transacoes agrupadas');
console.log('  31/03:', fn01Txs.filter(f => f.dtEmissao === '2026-03-31').length);
console.log('  01/04:', fn01Txs.filter(f => f.dtEmissao === '2026-04-01').length);
console.log('  02/04:', fn01Txs.filter(f => f.dtEmissao === '2026-04-02').length);

// ===== 5. AGRUPAR LIQUIDACAO POR BANDEIRA/NATUREZA =====
// Juntar EEFI + EEVD = tudo que liquidou dia 02/04
const allLiq = [...eefiTxs, ...eevdTxs];
const liqByBandNat = new Map();

// Agrupar extrato por bandeira+natureza
for (const e of extratoRede) {
  const key = e.bandeira + '|' + e.natureza;
  if (!liqByBandNat.has(key)) liqByBandNat.set(key, { bandeira: e.bandeira, natureza: e.natureza, bancoValor: 0, adqValor: 0, ordensValor: 0 });
  liqByBandNat.get(key).bancoValor += e.valor;
}

// Agrupar adquirente (EEFI credito por bandeira nao temos - vamos usar totais)
// EEFI nao tem bandeira, EEVD tambem nao diretamente
// Vamos usar o extrato como referencia e conciliar os totais

// Totais
const totalAdqCredito = eefiTxs.reduce((s,t) => s+t.valor, 0);
const totalAdqDebito = eevdTxs.reduce((s,t) => s+t.valor, 0);
const totalBanco = extratoRede.reduce((s,t) => s+t.valor, 0);
const totalBancoCredito = extratoRede.filter(e => e.natureza === 'CREDITO').reduce((s,t) => s+t.valor, 0);
const totalBancoDebito = extratoRede.filter(e => e.natureza === 'DEBITO').reduce((s,t) => s+t.valor, 0);

// Linhas para a tela (estilo Statix)
const linhas = [];

// Nivel 1: Resumo geral
const totalOrdens = totalBanco; // extrato = ordens de pagamento
const totalAdq = totalAdqCredito + totalAdqDebito;
const difTaxa = totalAdq - totalOrdens; // taxa cobrada
const difBanco = totalOrdens - totalBanco; // diferenca banco

// Nivel 2: Por conta bancaria
const conta = 'ITAU / 4525 / 956860';

// Nivel 3: Detalhe por bandeira/natureza do extrato
const detalhe = extratoRede.map(e => {
  const hist = e.historico.replace(/^0093/, '').trim();
  return {
    historico: 'REDE ' + e.bandeira + (e.natureza === 'CREDITO' ? ' CD' : ' DB') + e.ec,
    rede: 'Rede',
    bandeira: e.bandeira,
    natureza: e.natureza,
    valor: e.valor,
    // Adquirente: mesmo valor (liquidou o que o banco recebeu)
    adqConciliado: e.valor,
    adqNaoConciliado: 0,
    adqInexistente: 0,
    adqLiquido: e.valor,
    adqCredito: e.natureza === 'CREDITO' ? e.valor : 0,
    adqDebito: e.natureza === 'DEBITO' ? e.valor : 0,
    adqTotal: e.valor,
    difTaxa: 0, // calcular depois com cadastro
    difBanco: 0,
    origem: 'AGENDA',
    conciliada: true,
  };
});

// Calcular diferenca de taxa usando cadastro
const XLSX = require('xlsx');
try {
  const wb = XLSX.readFile('C:/Users/grupomateus/Downloads/relatorio_de_exportacao_taxas.xls');
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', header: 1 });
  // taxa por bandeira/natureza
  for (const d of detalhe) {
    let taxaPct = 0;
    for (let i = 2; i < rows.length; i++) {
      const r = rows[i];
      const band = String(r[1]).trim();
      const nat = String(r[7] || '').trim().toUpperCase();
      if (band.toUpperCase().includes(d.bandeira.toUpperCase()) && nat.includes(d.natureza.substring(0,4).toUpperCase())) {
        taxaPct = parseFloat(r[9]) || 0;
        break;
      }
    }
    const taxaEsperada = d.valor * taxaPct / 100;
    d.difTaxa = Math.round((taxaEsperada) * -100) / 100; // negativo porque e desconto
  }
} catch(e) { console.log('Sem cadastro de taxas:', e.message); }

const output = {
  data: '02/04/2026',
  empresa: 'MATEUS FOOD',
  adquirente: 'Rede',
  conta,
  resumo: {
    totalOrdens: Math.round(totalBanco * 100) / 100,
    totalAdqLiquido: Math.round(totalAdq * 100) / 100,
    totalAdqCredito: 0, // so ajustes (zerado por enquanto)
    totalAdqDebito: 0,  // so ajustes (zerado por enquanto)
    totalBanco: Math.round(totalBanco * 100) / 100,
    difTaxa: Math.round((totalAdq - totalBanco) * -100) / 100,
    difBanco: 0,
    conciliada: Math.abs(totalBanco - totalAdq) < 1,
  },
  detalhe,
};

fs.writeFileSync('C:/Users/grupomateus/OneDrive/Área de Trabalho/Projetos IA/conciliacao-spring/conciliacao-banco.json', JSON.stringify(output));
console.log('');
console.log('=== RESULTADO CONCILIACAO DE BANCO ===');
console.log('Ordens Pgto (banco): R$', output.resumo.totalOrdens.toFixed(2));
console.log('Adquirente liquido:  R$', output.resumo.totalAdqLiquido.toFixed(2));
console.log('Dif taxa:            R$', output.resumo.difTaxa.toFixed(2));
console.log('Dif banco:           R$', output.resumo.difBanco.toFixed(2));
console.log('Conciliada:', output.resumo.conciliada);
console.log('');
console.log('Detalhe:');
detalhe.forEach(d => console.log('  ' + d.historico.padEnd(30) + ' R$' + d.valor.toFixed(2).padStart(12) + ' DifTaxa: R$' + d.difTaxa.toFixed(2)));
console.log('');
console.log('JSON salvo!');
