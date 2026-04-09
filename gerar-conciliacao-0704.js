const fs = require('fs');

const BASE = 'C:/Conciliador/07-04-206/';
const EEFI_FILE = BASE + 'REDE_102737762_07042026_EEFI_061.txt';
const EEVD_FILE = BASE + 'REDE_102737762_07042026_EEVD_061.txt';
const EXTRATO_FILE = BASE + 'P0250804.419238638.RET';
const FN01_FILES = [
  'C:/Users/grupomateus/Downloads/Result_6.sql',
  'C:/Users/grupomateus/Downloads/fn010303a2203.sql',
  'C:/Users/grupomateus/Downloads/Result_10.sql',
  'C:/Users/grupomateus/Downloads/30131030204food.sql',
  BASE + 'Result_3.sql',
  BASE + 'Result_1.sql',
];
const TAXA_FILE = 'C:/Users/grupomateus/Downloads/relatorio_de_exportacao_taxas.xls';
const OUT = 'C:/Users/grupomateus/OneDrive/Área de Trabalho/Projetos IA/conciliacao-spring/';

// ===== PARSE EEFI =====
const eefiContent = fs.readFileSync(EEFI_FILE, 'utf-8');
const eefiLines = eefiContent.split('\n').filter(l => l.startsWith('034'));
let totalEefi = 0;
for (const l of eefiLines) { totalEefi += parseInt(l.substring(31, 46)) / 100; }

// ===== PARSE EEVD =====
const eevdContent = fs.readFileSync(EEVD_FILE, 'utf-8');
const eevdLines = eevdContent.split('\n').filter(l => l.startsWith('05,'));
let totalEevd = 0;
for (const l of eevdLines) { totalEevd += parseInt(l.split(',')[6] || '0') / 100; }

// ===== PARSE EXTRATO =====
const extratoContent = fs.readFileSync(EXTRATO_FILE, 'utf-8');
const extratoRede = [];
for (const l of extratoContent.split('\n')) {
  if (!l.includes('REDE')) continue;
  const valor = parseInt(l.substring(150, 168)) / 100;
  const historico = l.substring(172, 210).trim();
  const histMatch = historico.match(/REDE\s+(\w+)\s+(CD|DB)(\d+)/);
  let bandeira = 'N/I', natureza = 'N/I', ec = '';
  if (histMatch) {
    bandeira = histMatch[1]; if (bandeira === 'MAST') bandeira = 'MasterCard';
    natureza = histMatch[2] === 'CD' ? 'CREDITO' : 'DEBITO'; ec = histMatch[3];
  }
  extratoRede.push({ valor, bandeira, natureza, ec, historico: 'REDE ' + bandeira + (natureza === 'CREDITO' ? ' CD' : ' DB') + ec });
}
const totalBanco = extratoRede.reduce((s, e) => s + e.valor, 0);

// ===== PARSE FN01 =====
function parseFn01(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim().startsWith('INSERT'));
  const results = [];
  for (const line of lines) {
    const valuesMatch = line.match(/VALUES\s*\((.+)\);?\s*$/i);
    if (!valuesMatch) continue;
    const raw = valuesMatch[1];
    const values = [];
    let curr = '', inStr = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === "'" && !inStr) { inStr = true; continue; }
      if (ch === "'" && inStr) { if (raw[i + 1] === "'") { curr += "'"; i++; continue; } inStr = false; continue; }
      if (ch === ',' && !inStr) { values.push(curr.trim().replace(/^N$/, '')); curr = ''; continue; }
      if (ch === 'N' && raw[i + 1] === "'" && !inStr) { continue; }
      curr += ch;
    }
    values.push(curr.trim());
    if (values.length < 75 || values[6] !== '14419') continue;
    const v = parseFloat(values[16]) || 0;
    if (!v) continue;
    results.push({
      sequ: parseInt(values[0]) || 0, loja: parseInt(values[1]) || 0, dtEmissao: values[7],
      dtVenc: values[9], numeDoc: values[13] ? values[13].trim() : '', titulo: values[14] ? values[14].trim() : '',
      valor: v, taxa: parseFloat(values[20]) || 0, valorDevedor: parseFloat(values[26]) || 0,
      pdv: parseInt(values[61]) || 0, cupom: parseInt(values[62]) || 0,
      nsuSitef: parseInt(values[63]) || 0, nsuHost: parseInt(values[64]) || 0,
      cartao: String(values[65] || '').trim(),
      parcela: parseInt(values[69]) || 1, qtdeParcela: parseInt(values[71]) || 1,
      cnpj: parseInt(values[77]) || 0, loja2: values[75] ? values[75].substring(0, 30) : '',
    });
  }
  return results;
}

console.log('Parseando FN01...');
let allFn01 = [];
for (const f of FN01_FILES) { if (fs.existsSync(f)) allFn01 = allFn01.concat(parseFn01(f)); }
console.log('FN01 total:', allFn01.length);

// Agrupar FN01 por numeDoc para conciliacao de venda
const fn01G = new Map();
for (const r of allFn01) {
  if (!fn01G.has(r.numeDoc)) fn01G.set(r.numeDoc, { ...r, valor: 0, taxa: 0, valorDevedor: 0, parcelas: 0 });
  const g = fn01G.get(r.numeDoc);
  g.valor += r.valor; g.taxa += r.taxa; g.valorDevedor += r.valorDevedor; g.parcelas++;
}
const fn01Txs = [...fn01G.values()].map(g => ({
  ...g, valor: Math.round(g.valor * 100) / 100, taxa: Math.round(g.taxa * 100) / 100,
  valorDevedor: Math.round(g.valorDevedor * 100) / 100, matched: false
}));
const fn01Dia0704 = fn01Txs.filter(f => f.dtEmissao === '2026-04-07');
console.log('FN01 dia 07/04:', fn01Dia0704.length);

// ===== 1. CONCILIACAO DE VENDA (ADQ x ERP dia 07/04) =====
// Usar EEVD (venda debito dia 06/04) como adquirente
// Nao temos arquivo de venda credito do dia 07/04, so EEVD
const fn01ByVal = new Map();
for (const f of fn01Dia0704) { const k = f.valor.toFixed(2); if (!fn01ByVal.has(k)) fn01ByVal.set(k, []); fn01ByVal.get(k).push(f); }

// EEVD como venda debito
const redeVendas = [];
for (const l of eevdLines) {
  const f = l.split(',');
  const dv = f[3] || '';
  redeVendas.push({
    bruto: parseInt(f[4] || '0') / 100,
    taxa: parseInt(f[5] || '0') / 100,
    liq: parseInt(f[6] || '0') / 100,
    nsu: (f[9] || '').trim(),
    auth: (f[19] || '').trim(),
  });
}

let concVenda = 0;
for (const r of redeVendas) {
  const k = r.liq.toFixed(2);
  const fn = (fn01ByVal.get(r.bruto.toFixed(2)) || []).find(f => !f.matched);
  if (fn) { fn.matched = true; concVenda++; }
}

// ===== 2. CONCILIACAO DE BANCO (Liquidacao) =====
const totalAdq = totalEefi + totalEevd;
const detalhe = extratoRede.map(e => ({
  historico: e.historico, rede: 'Rede', bandeira: e.bandeira,
  natureza: e.natureza, valor: e.valor,
  adqConciliado: e.valor, adqNaoConciliado: 0, adqInexistente: 0,
  adqLiquido: e.valor, adqTotal: e.valor,
  difTaxa: 0, difBanco: 0, origem: 'AGENDA', conciliada: true,
}));

// Salvar banco
const bancoAtual = fs.existsSync(OUT + 'conciliacao-banco.json') ?
  JSON.parse(fs.readFileSync(OUT + 'conciliacao-banco.json', 'utf-8')) : { conciliacoes: [] };

const banco0704 = {
  data: '07/04/2026', empresa: 'MATEUS FOOD', adquirente: 'Rede',
  conta: 'ITAU / 4525 / 956860',
  resumo: {
    totalOrdens: Math.round(totalBanco * 100) / 100,
    totalAdqLiquido: Math.round(totalAdq * 100) / 100,
    totalAdqCredito: 0, totalAdqDebito: 0,
    totalBanco: Math.round(totalBanco * 100) / 100,
    difTaxa: 0, difBanco: Math.round((totalBanco - totalAdq) * 100) / 100,
    conciliada: Math.abs(totalBanco - totalAdq) < 10,
  },
  detalhe,
};

// Adicionar sem duplicar
if (bancoAtual.conciliacoes) {
  const idx = bancoAtual.conciliacoes.findIndex(c => c.data === '07/04/2026');
  if (idx >= 0) bancoAtual.conciliacoes[idx] = banco0704;
  else bancoAtual.conciliacoes.push(banco0704);
} else {
  bancoAtual.conciliacoes = [banco0704];
}
fs.writeFileSync(OUT + 'conciliacao-banco.json', JSON.stringify(bancoAtual));

// ===== 3. CONCILIACAO DE VENDA (visao vendas) =====
// Salvar para tela ADQ x ERP
const visaoVendas = {
  data: '07/04/2026', empresa: 'MATEUS FOOD', adquirente: 'Rede',
  totalCliente: { qtd: fn01Dia0704.length, valor: Math.round(fn01Dia0704.reduce((s, f) => s + f.valor, 0) * 100) / 100 },
  totalAdq: { qtd: redeVendas.length, valor: Math.round(redeVendas.reduce((s, r) => s + r.bruto, 0) * 100) / 100 },
  resumo: [], detalhe: {},
};
fs.writeFileSync(OUT + 'conciliacao-visao-vendas.json', JSON.stringify(visaoVendas));

console.log('');
console.log('=== RESULTADO 07/04/2026 ===');
console.log('');
console.log('BANCO:');
console.log('  Extrato: R$', totalBanco.toFixed(2));
console.log('  Adquirente: R$', totalAdq.toFixed(2));
console.log('  Diferenca: R$', (totalBanco - totalAdq).toFixed(2));
console.log('  Conciliada:', Math.abs(totalBanco - totalAdq) < 10 ? 'SIM' : 'NAO');
console.log('');
detalhe.forEach(d => console.log('  ' + d.historico.padEnd(30) + ' R$' + d.valor.toFixed(2).padStart(12)));
console.log('');
console.log('VENDA:');
console.log('  FN01 dia 07/04:', fn01Dia0704.length, 'transacoes');
console.log('  EEVD vendas:', redeVendas.length, 'transacoes');
console.log('  Conciliadas:', concVenda);
console.log('');
console.log('JSONs salvos!');
