const fs = require('fs');
const OUT = 'C:/Users/grupomateus/OneDrive/Área de Trabalho/Projetos IA/conciliacao-spring/';

// Classificar bandeira pelo BIN do cartao (campo 65 FN01)
function getBandeira(cartao) {
  const bin = String(cartao).substring(0, 6);
  const b3 = bin.substring(0, 3);
  const b2 = bin.substring(0, 2);
  const b1 = bin.substring(0, 1);
  const n3 = parseInt(b3);

  // Elo: ranges especificos
  const eloBins = ['506', '509', '650', '651', '655', '636', '504', '627', '628', '629'];
  if (eloBins.includes(b3)) return 'Elo';
  // Elo range 407 (407xxx)
  if (b3 === '407') return 'Elo';
  // Elo range 627-629
  if (n3 >= 627 && n3 <= 629) return 'Elo';

  // Amex: 34x, 37x
  if (b2 === '34' || b2 === '37') return 'Amex';

  // MasterCard: 51-55, 222100-272099, 2x range
  if (n3 >= 510 && n3 <= 559) return 'MasterCard';
  if (n3 >= 222 && n3 <= 272) return 'MasterCard';
  if (b3 === '589') return 'MasterCard';

  // Visa: 4xxx
  if (b1 === '4') return 'Visa';

  return 'N/I';
}

// Parsear FN01 SQL
function parseFn01(filePath) {
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
    const cartao = String(values[65] || '').trim();
    results.push({
      valor: v, liq: parseFloat(values[26]) || 0, taxa: parseFloat(values[20]) || 0,
      nsuHost: values[64] ? values[64].trim() : '', nsu: values[63] ? values[63].trim() : '',
      loja: (values[75] || '').substring(0, 30), titulo: values[14] ? values[14].trim() : '',
      dtEmissao: values[7], dtVenc: values[9], cartao,
      bandeira: getBandeira(cartao), matched: false,
    });
  }
  return results;
}

// Parsear Rede API JSON
function parseRedeAPI(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(content);
  return (data.content?.transactions || []).map(tx => {
    let bandeira = 'N/I';
    const bc = tx.brandCode;
    if (bc === 1) bandeira = 'MasterCard';
    else if (bc === 2) bandeira = 'Visa';
    else if (bc === 3 || bc === 14 || bc === 20) bandeira = 'Elo';
    else if (bc === 4 || bc === 13) bandeira = 'Amex';
    else if (bc === 5) bandeira = 'Hipercard';
    else if (bc === 16 || bc === 52) bandeira = 'Voucher';
    return {
      bruto: tx.amount || 0, liq: tx.netAmount || 0, taxa: tx.discountAmount || 0,
      bandeira, nsu: String(tx.nsu || ''), autorizacao: String(tx.authorizationCode || ''),
      parcelas: tx.installmentQuantity || 1, data: tx.saleDate || '', matched: false,
    };
  });
}

// Carregar FN01
console.log('Carregando FN01...');
let allFn01 = [];
[
  'C:/Users/grupomateus/Downloads/fn010204food',
].forEach(f => { if (fs.existsSync(f)) allFn01 = allFn01.concat(parseFn01(f)); });
console.log('FN01 total:', allFn01.length);

// Verificar bandeiras
const bandCount = new Map();
allFn01.filter(f => f.dtEmissao === '2026-04-02').forEach(f => bandCount.set(f.bandeira, (bandCount.get(f.bandeira) || 0) + 1));
console.log('FN01 02/04 por bandeira:', [...bandCount.entries()].sort().map(([b, c]) => b + ':' + c).join(', '));

// Carregar Rede API 02/04
const redeTxs = parseRedeAPI('C:/Users/grupomateus/Downloads/02554_102737762_20260402_VENDA_E_PAGTO_REDE-API_MATEUSFOOD.TXT');
console.log('Rede API 02/04:', redeTxs.length);

// Conciliar dia 02/04
function conciliarDia(dataEmissao, fn01All, adqTxs) {
  // Deduplicar FN01 por titulo (evitar duplicatas de multiplos arquivos)
  const fn01Uniq = new Map();
  fn01All.filter(f => f.dtEmissao === dataEmissao).forEach(f => {
    if (!fn01Uniq.has(f.titulo)) fn01Uniq.set(f.titulo, f);
  });
  const fn01Dia = [...fn01Uniq.values()];

  // Agrupar FN01 por numeDoc (somar parcelas)
  const fn01G = new Map();
  for (const r of fn01Dia) {
    const key = r.titulo.split('/')[0];
    if (!fn01G.has(key)) fn01G.set(key, { ...r, valor: 0, taxa: 0, liq: 0, parcelas: 0 });
    const g = fn01G.get(key);
    g.valor += r.valor; g.taxa += r.taxa; g.liq += r.liq; g.parcelas++;
  }
  const fn01Txs = [...fn01G.values()].map(g => ({ ...g, valor: Math.round(g.valor * 100) / 100, matched: false }));

  // Index FN01 por valor
  const fn01ByVal = new Map();
  for (const f of fn01Txs) { const k = f.valor.toFixed(2); if (!fn01ByVal.has(k)) fn01ByVal.set(k, []); fn01ByVal.get(k).push(f); }

  // Conciliar adquirente com FN01 por valor
  const pares = [];
  for (const a of adqTxs) {
    const k = a.bruto.toFixed(2);
    const fn = (fn01ByVal.get(k) || []).find(f => !f.matched);
    if (fn) {
      fn.matched = true;
      a.matched = true;
      pares.push({ adq: a, fn01: fn });
    }
  }

  // Resumo por bandeira - usar bandeira do ADQUIRENTE (mais confiavel)
  const bandList = ['Amex', 'Elo', 'MasterCard', 'Visa'];
  const resumo = [];
  for (const band of bandList) {
    const paresBand = pares.filter(p => p.adq.bandeira === band);
    const fn01Band = fn01Txs.filter(f => f.bandeira === band);
    const adqBand = adqTxs.filter(a => a.bandeira === band);

    // Cliente = TODOS FN01 dessa bandeira
    const cliVal = fn01Band.reduce((s, f) => s + f.valor, 0);

    // Adquirente = TODOS dessa bandeira
    const adqVal = adqBand.reduce((s, a) => s + a.bruto, 0);

    if (fn01Band.length === 0 && adqBand.length === 0) continue;

    const conciliada = fn01Band.length === adqBand.length && fn01Band.length > 0 && Math.abs(cliVal - adqVal) < 1;

    resumo.push({
      bandeira: band,
      clienteQtd: fn01Band.length,
      clienteValor: Math.round(cliVal * 100) / 100,
      adqQtd: adqBand.length,
      adqValor: Math.round(adqVal * 100) / 100,
      conciliada,
    });
  }

  // Totais: mostrar TUDO (conciliado + nao conciliado)
  const totalCliQtd = fn01Txs.length;
  const totalCliVal = fn01Txs.reduce((s, f) => s + f.valor, 0);
  const totalAdqQtd = adqTxs.length;
  const totalAdqVal = adqTxs.reduce((s, a) => s + a.bruto, 0);

  const dataBR = dataEmissao.split('-').reverse().join('/');

  // Detalhe por bandeira: pares conciliados + nao conciliados
  const detalhe = {};
  for (const band of bandList) {
    const paresBand = pares.filter(p => p.adq.bandeira === band);
    const adqSem = adqTxs.filter(a => a.bandeira === band && !a.matched);
    const fn01Sem = fn01Txs.filter(f => f.bandeira === band && !f.matched);

    const conciliados = paresBand.map(p => ({
      cTitulo: p.fn01.titulo, cData: dataBR, cNsu: p.fn01.nsu, cAuth: p.fn01.nsuHost,
      cPlano: p.fn01.parcelas || 1, cValor: Math.round(p.fn01.valor * 100) / 100,
      aData: dataBR, aNsu: p.adq.nsu || '', aAuth: p.adq.autorizacao || '',
      aPlano: p.adq.parcelas || 1, aValor: p.adq.bruto, aMeio: 'TEF', sit: true,
    }));

    const naoConciliados = [];
    adqSem.forEach(a => {
      naoConciliados.push({
        cTitulo: '', cData: '', cNsu: '', cAuth: '', cPlano: '', cValor: '',
        aData: dataBR, aNsu: a.nsu || '', aAuth: a.autorizacao || '',
        aPlano: a.parcelas || 1, aValor: a.bruto, aMeio: 'TEF', sit: false, tipo: 'adq',
      });
    });
    fn01Sem.forEach(f => {
      naoConciliados.push({
        cTitulo: f.titulo, cData: dataBR, cNsu: f.nsu, cAuth: f.nsuHost,
        cPlano: f.parcelas || 1, cValor: Math.round(f.valor * 100) / 100,
        aData: '', aNsu: '', aAuth: '', aPlano: '', aValor: '', aMeio: '', sit: false, tipo: 'erp',
      });
    });

    if (conciliados.length > 0 || naoConciliados.length > 0) {
      detalhe[band] = { conciliados, naoConciliados };
    }
  }

  // Adicionar bandeira "Debito" e "Voucher" para EEVD
  const debPares = pares.filter(p => p.adq.bandeira === 'Debito');
  const debAdqSem = adqTxs.filter(a => a.bandeira === 'Debito' && !a.matched);
  if (debPares.length > 0 || debAdqSem.length > 0) {
    detalhe['Debito'] = {
      conciliados: debPares.map(p => ({
        cTitulo: p.fn01.titulo, cData: dataBR, cNsu: p.fn01.nsu, cAuth: p.fn01.nsuHost,
        cPlano: p.fn01.parcelas || 1, cValor: Math.round(p.fn01.valor * 100) / 100,
        aData: dataBR, aNsu: p.adq.nsu || '', aAuth: p.adq.autorizacao || '',
        aPlano: p.adq.parcelas || 1, aValor: p.adq.bruto, aMeio: 'TEF', sit: true,
      })),
      naoConciliados: debAdqSem.map(a => ({
        cTitulo: '', cData: '', cNsu: '', cAuth: '', cPlano: '', cValor: '',
        aData: dataBR, aNsu: a.nsu || '', aAuth: a.autorizacao || '',
        aPlano: 1, aValor: a.bruto, aMeio: 'TEF', sit: false, tipo: 'adq',
      })),
    };
  }

  return {
    data: dataBR, empresa: 'MATEUS FOOD', adquirente: 'Rede',
    totalCliente: { qtd: totalCliQtd, valor: Math.round(totalCliVal * 100) / 100 },
    totalAdq: { qtd: totalAdqQtd, valor: Math.round(totalAdqVal * 100) / 100 },
    totalConciliados: pares.length,
    totalNaoConciliados: totalAdqQtd - pares.length,
    resumo,
    detalhe,
  };
}

// Processar dia 02/04
const conc0204 = conciliarDia('2026-04-02', allFn01, redeTxs);

console.log('');
console.log('=== DIA 02/04 ===');
console.log('Cliente:', conc0204.totalCliente.qtd, 'R$', conc0204.totalCliente.valor);
console.log('Adquirente:', conc0204.totalAdq.qtd, 'R$', conc0204.totalAdq.valor);
conc0204.resumo.forEach(r => {
  console.log('  ' + r.bandeira.padEnd(12) + ' CLI:' + String(r.clienteQtd).padStart(4) + ' R$' + r.clienteValor.toFixed(2).padStart(12) + ' | ADQ:' + String(r.adqQtd).padStart(4) + ' R$' + r.adqValor.toFixed(2).padStart(12) + (r.conciliada ? ' ✔' : ' ✘'));
});

console.log('');
console.log('STATIX referencia:');
console.log('  Amex:       CLI:   2 R$      481.18 | ADQ:   2 R$      481.18');
console.log('  Elo:        CLI:  55 R$    4501.78 | ADQ:  55 R$    4501.78');
console.log('  MasterCard: CLI: 289 R$   41533.99 | ADQ: 289 R$   41533.99');
console.log('  Visa:       CLI: 255 R$   55400.00 | ADQ: 255 R$   55400.00');

// Salvar
const output = { conciliacoes: [conc0204] };
fs.writeFileSync(OUT + 'conciliacao-visao-vendas.json', JSON.stringify(output));
console.log('\nJSON salvo!');
