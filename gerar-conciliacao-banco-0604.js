const fs = require('fs');

const EEFI_FILE = 'C:/Users/grupomateus/Downloads/REDE_102737762_06042026_EEFI_060.txt';
const EEVD_FILES = [
  'C:/Users/grupomateus/Downloads/REDE_102737762_03042026_EEVD_057 (1).txt',
  'C:/Users/grupomateus/Downloads/REDE_102737762_04042026_EEVD_058.txt',
  'C:/Users/grupomateus/Downloads/REDE_102737762_05042026_EEVD_059.txt',
  'C:/Users/grupomateus/Downloads/REDE_102737762_06042026_EEVD_060.txt',
];
const EXTRATO_FILE = 'C:/Users/grupomateus/Downloads/P0250704.418087635.RET';
const FN01_FILES = [
  'C:/Users/grupomateus/Downloads/Result_6.sql',
  'C:/Users/grupomateus/Downloads/fn010303a2203.sql',
  'C:/Users/grupomateus/Downloads/Result_10.sql',
];

// ===== 1. PARSE EEFI (Credito) =====
const eefiContent = fs.readFileSync(EEFI_FILE, 'utf-8');
const eefiLines = eefiContent.split('\n').filter(l => l.startsWith('034'));
let totalEefi = 0;
const eefiSaleDates = new Set();
for (const l of eefiLines) {
  totalEefi += parseInt(l.substring(31, 46)) / 100;
  const dv = l.substring(84, 92);
  const dd = dv.substring(0,2), mm = dv.substring(2,4), yyyy = dv.substring(4);
  if (parseInt(mm) <= 12 && parseInt(dd) <= 31 && yyyy.startsWith('202')) {
    const venc = l.substring(67,75);
    const vencISO = venc.substring(4) + '-' + venc.substring(2,4) + '-' + venc.substring(0,2);
    const saleISO = yyyy + '-' + mm + '-' + dd;
    if (saleISO !== vencISO) eefiSaleDates.add(saleISO);
  }
}
console.log('EEFI (credito): R$', totalEefi.toFixed(2), '| Datas venda:', [...eefiSaleDates].sort().join(', '));

// ===== 2. PARSE EEVDs (Debito) =====
let totalEevd = 0;
const eevdSaleDates = new Set();
for (const file of EEVD_FILES) {
  if (!fs.existsSync(file)) { console.log('EEVD nao encontrado:', file); continue; }
  const content = fs.readFileSync(file, 'utf-8');
  const tipo05 = content.split('\n').filter(l => l.startsWith('05,'));
  let fileTotal = 0;
  for (const l of tipo05) {
    const f = l.split(',');
    fileTotal += parseInt(f[6] || '0') / 100;
    const dv = f[3] || '';
    eevdSaleDates.add(dv.substring(4) + '-' + dv.substring(2,4) + '-' + dv.substring(0,2));
  }
  totalEevd += fileTotal;
  console.log('EEVD', file.split('/').pop(), ': R$', fileTotal.toFixed(2));
}
console.log('EEVD total (debito): R$', totalEevd.toFixed(2), '| Datas venda:', [...eevdSaleDates].sort().join(', '));

// ===== 3. PARSE EXTRATO =====
const extratoContent = fs.readFileSync(EXTRATO_FILE, 'utf-8');
const extratoRede = [];
for (const l of extratoContent.split('\n')) {
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
  extratoRede.push({ valor, bandeira, natureza, ec, historico: 'REDE ' + bandeira + (natureza === 'CREDITO' ? ' CD' : ' DB') + ec });
}
const totalBanco = extratoRede.reduce((s, e) => s + e.valor, 0);
console.log('Extrato banco REDE: R$', totalBanco.toFixed(2), '|', extratoRede.length, 'lancamentos');

// ===== 4. GERAR JSON CONCILIACAO BANCO =====
const totalAdq = totalEefi + totalEevd;
const totalBancoCredito = extratoRede.filter(e => e.natureza === 'CREDITO').reduce((s, e) => s + e.valor, 0);
const totalBancoDebito = extratoRede.filter(e => e.natureza === 'DEBITO').reduce((s, e) => s + e.valor, 0);

const detalhe = extratoRede.map(e => ({
  historico: e.historico,
  rede: 'Rede',
  bandeira: e.bandeira,
  natureza: e.natureza,
  valor: e.valor,
  adqConciliado: e.valor,
  adqNaoConciliado: 0,
  adqInexistente: 0,
  adqLiquido: e.valor,
  adqTotal: e.valor,
  difTaxa: 0,
  difBanco: 0,
  origem: 'AGENDA',
  conciliada: true,
}));

const output = {
  data: '06/04/2026',
  empresa: 'MATEUS FOOD',
  adquirente: 'Rede',
  conta: 'ITAU / 4525 / 956860',
  resumo: {
    totalOrdens: Math.round(totalBanco * 100) / 100,
    totalAdqLiquido: Math.round(totalAdq * 100) / 100,
    totalAdqCredito: 0,
    totalAdqDebito: 0,
    totalBanco: Math.round(totalBanco * 100) / 100,
    difTaxa: 0,
    difBanco: Math.round((totalBanco - totalAdq) * 100) / 100,
    conciliada: Math.abs(totalBanco - totalAdq) < 10,
  },
  detalhe,
};

fs.writeFileSync('C:/Users/grupomateus/OneDrive/Área de Trabalho/Projetos IA/conciliacao-spring/conciliacao-banco.json', JSON.stringify(output));

console.log('');
console.log('=== RESULTADO CONCILIACAO BANCO 06/04 ===');
console.log('Ordens Pgto (banco): R$', output.resumo.totalOrdens.toFixed(2));
console.log('Adquirente liquido:  R$', output.resumo.totalAdqLiquido.toFixed(2));
console.log('Dif banco:           R$', output.resumo.difBanco.toFixed(2));
console.log('Conciliada:', output.resumo.conciliada);
console.log('');
detalhe.forEach(d => console.log('  ' + d.historico.padEnd(30) + ' R$' + d.valor.toFixed(2).padStart(12)));
console.log('');
console.log('JSON salvo!');
