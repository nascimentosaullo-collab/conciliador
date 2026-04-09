const fs = require('fs');
const OUT = 'C:/Users/grupomateus/OneDrive/Área de Trabalho/Projetos IA/conciliacao-spring/';

// Parsear FN01
function parseFn01Sql(filePath) {
  if (!fs.existsSync(filePath)) return [];
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
      valor: v, liq: parseFloat(values[26]) || 0, taxa: parseFloat(values[20]) || 0,
      nsuHost: values[64] ? values[64].trim() : '', nsu: values[63] ? values[63].trim() : '',
      loja: (values[75] || '').substring(0, 30), titulo: values[14] ? values[14].trim() : '',
      dtEmissao: values[7], dtVenc: values[9], matched: false,
    });
  }
  return results;
}

// Parsear EEVD
function parseEEVD(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  return content.split('\n').filter(l => l.startsWith('05,')).map(l => {
    const f = l.split(',');
    return {
      bruto: parseInt(f[4] || '0') / 100, taxa: parseInt(f[5] || '0') / 100,
      liq: parseInt(f[6] || '0') / 100, nsu: (f[9] || '').trim(), auth: (f[19] || '').trim(),
      dataVenda: (f[3] || '').substring(4) + '-' + (f[3] || '').substring(2, 4) + '-' + (f[3] || '').substring(0, 2),
    };
  });
}

// Carregar todos os FN01
console.log('Carregando FN01...');
let allFn01 = [];
[
  'C:/Users/grupomateus/Downloads/Result_6.sql',
  'C:/Users/grupomateus/Downloads/fn010303a2203.sql',
  'C:/Users/grupomateus/Downloads/Result_10.sql',
  'C:/Users/grupomateus/Downloads/30131030204food.sql',
  'C:/Conciliador/07-04-206/Result_1.sql',
  'C:/Conciliador/07-04-206/Result_3.sql',
  'C:/Conciliador/07-04-206/Result_6.sql',
].forEach(f => { if (fs.existsSync(f)) allFn01 = allFn01.concat(parseFn01Sql(f)); });

// Deduplicar por titulo
const fn01Map = new Map();
for (const f of allFn01) { if (!fn01Map.has(f.titulo)) fn01Map.set(f.titulo, f); }
console.log('FN01 total unicos:', fn01Map.size);

// Conciliar vendas por dia
function conciliarVendaDia(dataEmissao, adqTxs, label) {
  const fn01Dia = allFn01.filter(f => f.dtEmissao === dataEmissao);
  // Agrupar por numeDoc
  const fn01G = new Map();
  for (const r of fn01Dia) {
    const key = r.titulo.split('/')[0];
    if (!fn01G.has(key)) fn01G.set(key, { ...r, valor: 0, taxa: 0, liq: 0, parcelas: 0 });
    const g = fn01G.get(key);
    g.valor += r.valor; g.taxa += r.taxa; g.liq += r.liq; g.parcelas++;
  }
  const fn01Txs = [...fn01G.values()].map(g => ({ ...g, valor: Math.round(g.valor * 100) / 100, matched: false }));

  // Index por valor
  const fn01ByVal = new Map();
  for (const f of fn01Txs) { const k = f.valor.toFixed(2); if (!fn01ByVal.has(k)) fn01ByVal.set(k, []); fn01ByVal.get(k).push(f); }

  // Conciliar
  let conciliados = 0;
  for (const a of adqTxs) {
    const k = a.bruto.toFixed(2);
    const fn = (fn01ByVal.get(k) || []).find(f => !f.matched);
    if (fn) { fn.matched = true; conciliados++; }
  }

  const totalFn01 = fn01Txs.reduce((s, f) => s + f.valor, 0);
  const totalAdq = adqTxs.reduce((s, a) => s + a.bruto, 0);

  // Bandeiras simplificadas
  const resumo = [
    { bandeira: 'Todas', clienteQtd: fn01Txs.length, clienteValor: Math.round(totalFn01 * 100) / 100, adqQtd: adqTxs.length, adqValor: Math.round(totalAdq * 100) / 100, conciliada: false }
  ];

  const dataBR = dataEmissao.split('-').reverse().join('/');
  console.log(label + ' ' + dataBR + ': FN01=' + fn01Txs.length + ' ADQ=' + adqTxs.length + ' Conc=' + conciliados + ' (' + (adqTxs.length > 0 ? ((conciliados / adqTxs.length) * 100).toFixed(1) : 0) + '%)');

  return {
    data: dataBR, empresa: 'MATEUS FOOD', adquirente: 'Rede',
    totalCliente: { qtd: fn01Txs.length, valor: Math.round(totalFn01 * 100) / 100 },
    totalAdq: { qtd: adqTxs.length, valor: Math.round(totalAdq * 100) / 100 },
    resumo, detalhe: {},
  };
}

// Processar cada dia
const conciliacoes = [];

// 02/04 - ja temos (carregar existente)
const existente = JSON.parse(fs.readFileSync(OUT + 'conciliacao-visao-vendas.json', 'utf-8'));
if (existente.conciliacoes) {
  const c0204 = existente.conciliacoes.find(c => c.data === '02/04/2026');
  if (c0204) conciliacoes.push(c0204);
}

// 03/04 - EEVD_058 tem vendas debito 03/04
const eevd03 = parseEEVD('C:/Users/grupomateus/Downloads/REDE_102737762_04042026_EEVD_058.txt');
if (eevd03.length > 0) conciliacoes.push(conciliarVendaDia('2026-04-03', eevd03, 'VENDA'));

// 04/04 - EEVD_059 tem vendas debito 04/04
const eevd04 = parseEEVD('C:/Users/grupomateus/Downloads/REDE_102737762_05042026_EEVD_059.txt');
if (eevd04.length > 0) conciliacoes.push(conciliarVendaDia('2026-04-04', eevd04, 'VENDA'));

// 05/04 - EEVD_060 tem vendas debito 05/04 + EEVC_060 tem vendas credito 05/04
const eevd05 = parseEEVD('C:/Conciliador/07-04-206/REDE_102737762_06042026_EEVD_060 (1).txt');
// EEVC nao tem parser facil, usar so EEVD por agora
if (eevd05.length > 0) conciliacoes.push(conciliarVendaDia('2026-04-05', eevd05, 'VENDA'));

// 06/04 - EEVD_061 tem vendas debito 06/04
const eevd06 = parseEEVD('C:/Conciliador/07-04-206/REDE_102737762_07042026_EEVD_061.txt');
if (eevd06.length > 0) conciliacoes.push(conciliarVendaDia('2026-04-06', eevd06, 'VENDA'));

// Salvar
const output = { conciliacoes };
fs.writeFileSync(OUT + 'conciliacao-visao-vendas.json', JSON.stringify(output));

console.log('');
console.log('Total datas processadas:', conciliacoes.length);
console.log('Datas:', conciliacoes.map(c => c.data).join(', '));
console.log('JSON salvo!');
