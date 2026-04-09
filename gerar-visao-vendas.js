const fs = require('fs');

const cieloContent = fs.readFileSync('C:/Users/grupomateus/Downloads/CIELO03D_1092157538_20260402_20260402_20260402.TXT','utf-8');
const fn01Content = fs.readFileSync('C:/Users/grupomateus/Downloads/arquivo da fn01','utf-8');
const st02Content = fs.readFileSync('C:/Users/grupomateus/Downloads/st02 dia 0204.txt','utf-8');

// ST02 por auth para pegar bandeira
const st02ByAuth = new Map();
const st02ByVal = new Map();
for (const l of st02Content.split('\n')) {
  const f = l.split('|'); if (f.length < 20) continue;
  const v = parseFloat(f[8]) || 0; if (!v) continue;
  let band = (f[14] || '').trim();
  if (band.startsWith('Visa')) band = 'Visa';
  else if (band.startsWith('Master') || band === 'Maestro') band = 'MasterCard';
  else if (band.startsWith('ELO')) band = 'Elo';
  else if (band.startsWith('Amex')) band = 'Amex';
  else if (band.includes('Alelo') || band.includes('Sodexo') || band.includes('Ticket')) band = 'Voucher';
  const obj = { valor: v, bandeira: band, nsu: f[12], auth: f[13], matched: false };
  if (f[13]) { if (!st02ByAuth.has(f[13])) st02ByAuth.set(f[13], []); st02ByAuth.get(f[13]).push(obj); }
  const k = v.toFixed(2);
  if (!st02ByVal.has(k)) st02ByVal.set(k, []);
  st02ByVal.get(k).push(obj);
}

// CIELO03 parcela 01 + bandeira via ST02
const cieloTxs = [];
for (const l of cieloContent.split('\n')) {
  if (l.charAt(0) !== 'E' || l.length < 290 || l.substring(15, 17) !== '01') continue;
  const bruto = Math.abs(parseInt(l.substring(246, 260)) / 100);
  const k = bruto.toFixed(2);
  const st = (st02ByVal.get(k) || []).find(s => !s.matched);
  let bandeira = 'N/I', nsuSt02 = '', authSt02 = '';
  if (st) { st.matched = true; bandeira = st.bandeira; nsuSt02 = st.nsu; authSt02 = st.auth; }
  cieloTxs.push({
    bruto, liq: Math.abs(parseInt(l.substring(274, 288)) / 100),
    ec: l.substring(1, 11).trim(), auth: l.substring(17, 29).trim(),
    nsu: l.substring(138, 149).trim(), bandeira, nsuSt02, authSt02, matched: false
  });
}

// FN01 agrupado + bandeira via ST02 (nsuHost -> st02.auth)
const fn01G = new Map();
for (const l of fn01Content.split('\n')) {
  const f = l.split('|'); if (f.length < 70) continue;
  const v = parseFloat(f[16]) || 0; if (!v) continue;
  const c13 = f[13] ? f[13].trim() : ''; if (!c13) continue;
  if (!fn01G.has(c13)) {
    const nsuHost = f[62] ? f[62].trim() : '';
    const stMatch = (st02ByAuth.get(nsuHost) || [])[0];
    fn01G.set(c13, {
      valor: 0, nsuHost, nsu: f[63] ? f[63].trim() : '',
      auth: nsuHost, loja: (f[75] || '').substring(0, 30),
      parcelas: 0, bandeira: stMatch ? stMatch.bandeira : 'N/I',
      titulo: f[14] ? f[14].trim() : ''
    });
  }
  fn01G.get(c13).valor += v;
  fn01G.get(c13).parcelas++;
}
const fn01Txs = [...fn01G.values()].map(g => ({ ...g, valor: Math.round(g.valor * 100) / 100, matched: false }));

// Indexar FN01 por valor, NSU Host e NSU Sitef
const fn01ByVal = new Map();
const fn01ByNsuHost = new Map();
const fn01ByNsuSitef = new Map();
for (const f of fn01Txs) {
  const k = f.valor.toFixed(2);
  if (!fn01ByVal.has(k)) fn01ByVal.set(k, []);
  fn01ByVal.get(k).push(f);
  if (f.nsuHost) { if (!fn01ByNsuHost.has(f.nsuHost)) fn01ByNsuHost.set(f.nsuHost, []); fn01ByNsuHost.get(f.nsuHost).push(f); }
  if (f.nsu) { if (!fn01ByNsuSitef.has(f.nsu)) fn01ByNsuSitef.set(f.nsu, []); fn01ByNsuSitef.get(f.nsu).push(f); }
}

// Conciliar por 3 chaves: NSU Host, NSU Sitef, Valor bruto
const pares = [];
for (const c of cieloTxs) {
  let fn = null;

  // Prioridade 1: NSU Host (CIELO.authSt02 = FN01.nsuHost via ST02)
  if (!fn && c.authSt02) {
    fn = (fn01ByNsuHost.get(c.authSt02) || []).find(f => !f.matched);
  }

  // Prioridade 2: NSU Sitef (CIELO.nsuSt02 = FN01.nsu via ST02)
  if (!fn && c.nsuSt02) {
    fn = (fn01ByNsuSitef.get(c.nsuSt02) || []).find(f => !f.matched);
  }

  // Prioridade 3: Valor bruto
  if (!fn) {
    const k = c.bruto.toFixed(2);
    fn = (fn01ByVal.get(k) || []).find(f => !f.matched);
  }

  if (fn) { fn.matched = true; c.matched = true; pares.push({ cliente: fn, adquirente: c }); }
}

// Resumo por bandeira
const bandList = ['Visa', 'MasterCard', 'Elo', 'Amex', 'Voucher', 'N/I'];
const resumo = [];
for (const band of bandList) {
  const cB = cieloTxs.filter(c => c.bandeira === band);
  const fB = fn01Txs.filter(f => f.bandeira === band);
  if (cB.length === 0 && fB.length === 0) continue;
  const cVal = cB.reduce((s, c) => s + c.bruto, 0);
  const fVal = fB.reduce((s, f) => s + f.valor, 0);
  resumo.push({
    bandeira: band,
    clienteQtd: fB.length, clienteValor: Math.round(fVal * 100) / 100,
    adqQtd: cB.length, adqValor: Math.round(cVal * 100) / 100,
    conciliada: cB.length > 0 && fB.length > 0 && Math.abs(fVal - cVal) / Math.max(cVal, 1) < 0.02
  });
}

// Detalhe por bandeira - separado por tipo
const detalhe = {};
for (const band of bandList) {
  const paresBand = pares.filter(p => p.adquirente.bandeira === band);
  const adqSem = cieloTxs.filter(c => c.bandeira === band && !c.matched);
  const erpSem = fn01Txs.filter(f => f.bandeira === band && !f.matched);

  const conciliados = [];
  const naoConciliados = [];

  // Conciliados
  paresBand.forEach(p => {
    conciliados.push({
      cTitulo: p.cliente.titulo, cData: '02/04/2026', cNsu: p.cliente.nsu, cAuth: p.cliente.auth, cPlano: p.cliente.parcelas, cValor: p.cliente.valor,
      aData: '02/04/2026', aNsu: p.adquirente.nsuSt02 || p.adquirente.nsu, aAuth: p.adquirente.authSt02 || p.adquirente.auth, aPlano: 1, aValor: p.adquirente.bruto, aMeio: 'TEF',
      sit: true
    });
  });

  // Somente adquirente (prioridade no filtro "Nao")
  adqSem.forEach(c => {
    naoConciliados.push({
      cTitulo: '', cData: '', cNsu: '', cAuth: '', cPlano: '', cValor: '',
      aData: '02/04/2026', aNsu: c.nsuSt02 || c.nsu, aAuth: c.authSt02 || c.auth, aPlano: 1, aValor: c.bruto, aMeio: 'TEF',
      sit: false, tipo: 'adq'
    });
  });

  // Somente cliente
  erpSem.forEach(f => {
    naoConciliados.push({
      cTitulo: f.titulo, cData: '02/04/2026', cNsu: f.nsu, cAuth: f.auth, cPlano: f.parcelas, cValor: f.valor,
      aData: '', aNsu: '', aAuth: '', aPlano: '', aValor: '', aMeio: '',
      sit: false, tipo: 'erp'
    });
  });

  if (conciliados.length > 0 || naoConciliados.length > 0) {
    detalhe[band] = { conciliados, naoConciliados };
  }
}

const output = {
  data: '02/04/2026',
  totalCliente: { qtd: fn01Txs.length, valor: Math.round(fn01Txs.reduce((s, f) => s + f.valor, 0) * 100) / 100 },
  totalAdq: { qtd: cieloTxs.length, valor: Math.round(cieloTxs.reduce((s, c) => s + c.bruto, 0) * 100) / 100 },
  resumo,
  detalhe
};

fs.writeFileSync('C:/Users/grupomateus/OneDrive/Área de Trabalho/Projetos IA/conciliacao-spring/conciliacao-visao-vendas.json', JSON.stringify(output));
console.log('Cliente:', output.totalCliente.qtd, '| R$', output.totalCliente.valor);
console.log('Adquirente:', output.totalAdq.qtd, '| R$', output.totalAdq.valor);
resumo.forEach(r => console.log(r.bandeira, '- Cliente:', r.clienteQtd, 'R$' + r.clienteValor, '| Adq:', r.adqQtd, 'R$' + r.adqValor, r.conciliada ? 'OK' : 'X'));
Object.keys(detalhe).forEach(k => console.log('Detalhe', k + ': conc=' + detalhe[k].conciliados.length, 'naoConc=' + detalhe[k].naoConciliados.length));
