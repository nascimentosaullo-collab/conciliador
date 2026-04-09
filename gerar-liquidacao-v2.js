const fs = require('fs');
const OUT = 'C:/Users/grupomateus/OneDrive/Área de Trabalho/Projetos IA/conciliacao-spring/';

// ===== PARSERS =====

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
    results.push({
      sequ: parseInt(values[0]) || 0, loja: parseInt(values[1]) || 0, dtEmissao: values[7],
      dtVenc: values[9], titulo: values[14] ? values[14].trim() : '', valor: v,
      valorDevedor: parseFloat(values[26]) || 0, taxa: parseFloat(values[20]) || 0,
      pdv: parseInt(values[61]) || 0, cupom: parseInt(values[62]) || 0,
      nsuSitef: parseInt(values[63]) || 0, nsuHost: parseInt(values[64]) || 0,
      cartao: String(values[65] || '').trim(),
      parcela: parseInt(values[69]) || 1, qtdeParcela: parseInt(values[71]) || 1,
      cnpj: parseInt(values[77]) || 0,
    });
  }
  return results;
}

// BIN -> Bandeira (corrigido: Maestro=MasterCard, Hipercard)
function getBandeira(cartao) {
  const b3 = String(cartao).substring(0, 3);
  const b2 = String(cartao).substring(0, 2);
  const n3 = parseInt(b3);
  const eloBins = ['506', '509', '650', '651', '655', '636', '504', '407'];
  if (eloBins.includes(b3)) return 'Elo';
  if (b2 === '34' || b2 === '37') return 'Amex';
  // Maestro (679, 639, 502, 603) -> MasterCard
  if (n3 >= 670 && n3 <= 679) return 'MasterCard';
  if (b3 === '639' || b3 === '502' || b3 === '603') return 'MasterCard';
  if (n3 >= 510 && n3 <= 559) return 'MasterCard';
  if (n3 >= 222 && n3 <= 272) return 'MasterCard';
  if (b3 === '589') return 'MasterCard';
  // Hipercard
  if (b3 === '637' || b3 === '606') return 'Hipercard';
  if (String(cartao).startsWith('4')) return 'Visa';
  return 'N/I';
}

// Parsear EEVD - transacoes individuais com bruto E liquido + bandeira
function parseEEVDTxs(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  return content.split('\n').filter(l => l.startsWith('05,')).map(l => {
    const f = l.split(',');
    const valorBruto = parseInt(f[4] || '0') / 100;
    const valorLiquido = parseInt(f[6] || '0') / 100;
    const dv = f[3] || '';
    const dataVenda = dv.substring(4) + '-' + dv.substring(2, 4) + '-' + dv.substring(0, 2);
    const cartao = (f[7] || '').replace(/\s/g, '').replace(/\*/g, '');
    const bandeira = getBandeira(cartao);
    return {
      valorBruto: Math.round(valorBruto * 100) / 100,
      valorLiquido: Math.round(valorLiquido * 100) / 100,
      dataVenda, bandeira,
    };
  });
}

// Parsear EEFI - total liquido + datas de venda com CT
function parseEEFI(filePath) {
  if (!fs.existsSync(filePath)) return { total: 0, saleDatesWithCT: [] };
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.startsWith('034'));
  let total = 0;
  const saleDatesWithCT = [];
  for (const l of lines) {
    total += parseInt(l.substring(31, 46)) / 100;
    // Data de venda: pos 84-91 DDMMYYYY
    const dv = l.substring(84, 92);
    const dd = dv.substring(0, 2), mm = dv.substring(2, 4), yyyy = dv.substring(4);
    if (parseInt(mm) > 0 && parseInt(mm) <= 12 && yyyy.startsWith('202')) {
      const saleISO = yyyy + '-' + mm + '-' + dd;
      // Parcela: PP/TT no final da linha
      const parcMatch = l.trim().match(/(\d{2})\/(\d{2})\d{10,}$/);
      const parcAtual = parcMatch ? parseInt(parcMatch[1]) : 1;
      saleDatesWithCT.push({ saleDate: saleISO, ct: parcAtual });
    }
  }
  // Agrupar datas unicas com seus CTs
  const dateCtMap = new Map();
  for (const s of saleDatesWithCT) {
    const key = s.saleDate + '_CT' + s.ct;
    if (!dateCtMap.has(key)) dateCtMap.set(key, { saleDate: s.saleDate, ct: s.ct, count: 0 });
    dateCtMap.get(key).count++;
  }
  return { total, saleDatesCT: [...dateCtMap.values()] };
}

// Parsear Extrato Bancario
function parseExtrato(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const entries = [];
  for (const l of content.split('\n')) {
    if (!l.includes('REDE')) continue;
    const valor = parseInt(l.substring(150, 168)) / 100;
    const historico = l.substring(172, 210).trim();
    const histMatch = historico.match(/REDE\s+(\w+)\s+(CD|DB)(\d+)/);
    let bandeira = 'N/I', natureza = 'N/I', ec = '';
    if (histMatch) {
      bandeira = histMatch[1]; if (bandeira === 'MAST') bandeira = 'MasterCard';
      natureza = histMatch[2] === 'CD' ? 'CREDITO' : 'DEBITO'; ec = histMatch[3];
    }
    entries.push({ valor, bandeira, natureza, ec, historico: 'REDE ' + bandeira + (natureza === 'CREDITO' ? ' CD' : ' DB') + ec });
  }
  return entries;
}

// ===== FN01 MATCHING (para gerar ENVIO) =====

// Helper: expandir datas +-1 dia (lojas operam apos meia-noite)
function expandDates(dates) {
  const expanded = new Set();
  for (const d of dates) {
    expanded.add(d);
    const pp = d.split('-');
    const dt = new Date(parseInt(pp[0]), parseInt(pp[1]) - 1, parseInt(pp[2]));
    const dm1 = new Date(dt); dm1.setDate(dm1.getDate() - 1);
    const dp1 = new Date(dt); dp1.setDate(dp1.getDate() + 1);
    expanded.add(dm1.toISOString().substring(0, 10));
    expanded.add(dp1.toISOString().substring(0, 10));
  }
  return expanded;
}

// DEBITO: match linha a linha pelo valor bruto (data exata primeiro, fallback +-1 dia)
function matchDebitoFn01(eevdTxs, fn01All) {
  const saleDates = new Set(eevdTxs.map(t => t.dataVenda));
  const saleDatesExpanded = expandDates(saleDates);

  // Separar FN01: data exata vs +-1 dia (somente debito: venc - emissao <= 10 dias)
  function isDebitTitle(f) {
    const diff = Math.round((new Date(f.dtVenc) - new Date(f.dtEmissao)) / 86400000);
    return diff <= 10;
  }
  const fn01Exact = fn01All.filter(f => saleDates.has(f.dtEmissao) && isDebitTitle(f));
  const fn01Expanded = fn01All.filter(f => saleDatesExpanded.has(f.dtEmissao) && !saleDates.has(f.dtEmissao) && isDebitTitle(f));

  // Dedup
  const exactUniq = new Map();
  for (const f of fn01Exact) { if (!exactUniq.has(f.titulo)) exactUniq.set(f.titulo, { ...f, matched: false }); }
  const expandUniq = new Map();
  for (const f of fn01Expanded) { if (!expandUniq.has(f.titulo)) expandUniq.set(f.titulo, { ...f, matched: false }); }

  // Indexar por valor - data exata
  const exactByVal = new Map();
  for (const f of exactUniq.values()) {
    const k = f.valor.toFixed(2);
    if (!exactByVal.has(k)) exactByVal.set(k, []);
    exactByVal.get(k).push(f);
  }
  // Indexar por valor - +-1 dia
  const expandByVal = new Map();
  for (const f of expandUniq.values()) {
    const k = f.valor.toFixed(2);
    if (!expandByVal.has(k)) expandByVal.set(k, []);
    expandByVal.get(k).push(f);
  }

  // PASSO 1: match com data exata
  const pares = [];
  const naoConc = [];
  for (const tx of eevdTxs) {
    const fn = (exactByVal.get(tx.valorBruto.toFixed(2)) || []).find(f => !f.matched);
    if (fn) { fn.matched = true; pares.push(fn); }
    else { naoConc.push(tx); }
  }

  // PASSO 2: fallback +-1 dia para nao conciliados
  for (const tx of naoConc) {
    const fn = (expandByVal.get(tx.valorBruto.toFixed(2)) || []).find(f => !f.matched);
    if (fn) { fn.matched = true; pares.push(fn); }
  }

  return pares;
}

// CREDITO: filtrar FN01 por data emissao (do EEFI) + CT correto + bandeira
function matchCreditoFn01(eefiData, fn01All, dataLiqISO) {
  const saleDatesCT = eefiData.saleDatesCT;
  const dLiq = new Date(dataLiqISO);

  // Filtrar FN01: dtEmissao nas datas de venda do EEFI + CT correspondente
  const fn01Matched = [];
  const fn01Uniq = new Map();

  for (const sc of saleDatesCT) {
    // Data venda deve ser pelo menos 15 dias antes da liquidacao (credito D+30, nao debito D+1)
    const saleDate = new Date(sc.saleDate);
    const diffVendaLiq = Math.round((dLiq - saleDate) / 86400000);
    if (diffVendaLiq < 15) continue;

    // Data exata do EEFI (credito nao precisa +-1 dia, EEFI ja tem a data correta)
    const candidates = fn01All.filter(f => {
      if (f.dtEmissao !== sc.saleDate) return false;
      // Verificar CT do titulo
      const ctMatch = f.titulo.match(/CT(\d+)/);
      const ctNum = ctMatch ? parseInt(ctMatch[1]) : 1;
      if (ctNum !== sc.ct) return false;
      return true;
    });
    for (const f of candidates) {
      if (!fn01Uniq.has(f.titulo)) { fn01Uniq.set(f.titulo, f); fn01Matched.push(f); }
    }
  }

  // Agrupar por bandeira
  const grupos = new Map();
  for (const f of fn01Matched) {
    const band = getBandeira(f.cartao).toUpperCase();
    if (!grupos.has(band)) grupos.set(band, []);
    grupos.get(band).push(f);
  }
  return grupos;
}

// Montar venda ENVIO
function montarVenda(fn01, isCredito) {
  let valorDev = fn01.valorDevedor;
  if (valorDev === 0) valorDev = Math.round((fn01.valor - fn01.taxa) * 100) / 100;
  return {
    loja: fn01.loja, data: fn01.dtEmissao, pdv: fn01.pdv,
    autorizacao: String(fn01.nsuHost), valorTransacao: Math.round(fn01.valor * 100) / 100,
    cnpj: fn01.cnpj, rede: 1, produto: isCredito ? 1141 : 1206,
    valorDevedor: valorDev, nsuHost: fn01.nsuHost, nsuSitef: fn01.nsuHost,
    qtdParcela: fn01.qtdeParcela, parcela: fn01.parcela, dataVencimento: fn01.dtVenc,
    tipo: 3, numeroTitulo: fn01.titulo, sequencial: fn01.sequ,
    numeroCupom: 1, qtdCupom: 1, estabelecimento: 201661102737975,
    capturaAdquirente: 1, meioCaptura: 1, valorPago: valorDev,
    idCliente: 11, idEmpresa: 301, chaveVenda: 0,
    idProdutoStatix: isCredito ? 6 : 20,
    valorVendaAdquirente: 0.0, valorVendaCliente: 0.0,
  };
}

// ===== CARREGAR FN01 =====
console.log('Carregando FN01...');
let allFn01 = [];
[
  'C:/Users/grupomateus/Downloads/Result_6.sql',
  'C:/Users/grupomateus/Downloads/fn010303a2203.sql',
  'C:/Users/grupomateus/Downloads/Result_10.sql',
  'C:/Users/grupomateus/Downloads/30131030204food.sql',
  'C:/Users/grupomateus/Downloads/fn010204food',
  'C:/Conciliador/07-04-206/Result_1.sql',
  'C:/Conciliador/07-04-206/Result_3.sql',
  'C:/Conciliador/07-04-206/Result_6.sql',
].forEach(f => { if (fs.existsSync(f)) allFn01 = allFn01.concat(parseFn01(f)); });
const fn01Map = new Map();
for (const f of allFn01) { if (!fn01Map.has(f.titulo)) fn01Map.set(f.titulo, f); }
allFn01 = [...fn01Map.values()];
console.log('FN01 total (dedup):', allFn01.length);

// ===== PROCESSAR CADA DIA =====
const dias = [
  {
    data: '02/04/2026',
    eefi: 'C:/Users/grupomateus/Downloads/REDE_102737762_02042026_EEFI_056.txt',
    eevds: ['C:/Users/grupomateus/Downloads/REDE_102737762_01042026_EEVD_055.txt'],
    extrato: 'C:/Users/grupomateus/Downloads/P0250304.416220204 (1).RET',
  },
  {
    data: '06/04/2026',
    eefi: 'C:/Users/grupomateus/Downloads/REDE_102737762_06042026_EEFI_060.txt',
    eevds: [
      'C:/Users/grupomateus/Downloads/REDE_102737762_03042026_EEVD_057 (1).txt',
      'C:/Users/grupomateus/Downloads/REDE_102737762_04042026_EEVD_058.txt',
      'C:/Users/grupomateus/Downloads/REDE_102737762_05042026_EEVD_059.txt',
      'C:/Users/grupomateus/Downloads/REDE_102737762_06042026_EEVD_060.txt',
    ],
    extrato: 'C:/Users/grupomateus/Downloads/P0250704.418087635.RET',
  },
  {
    data: '07/04/2026',
    eefi: 'C:/Conciliador/07-04-206/REDE_102737762_07042026_EEFI_061.txt',
    eevds: ['C:/Conciliador/07-04-206/REDE_102737762_07042026_EEVD_061.txt'],
    extrato: 'C:/Conciliador/07-04-206/P0250804.419238638.RET',
  },
];

const bancoResult = { conciliacoes: [] };

for (const dia of dias) {
  console.log('\n=== ' + dia.data + ' ===');
  const dataLiqISO = dia.data.split('/').reverse().join('-');

  // === EEVD: parsear com valor liquido e bandeira ===
  const eevdTxs = [];
  for (const f of dia.eevds) { eevdTxs.push(...parseEEVDTxs(f)); }

  // Agrupar EEVD liquido por bandeira
  const eevdLiqByBand = new Map();
  const eevdBrutoByBand = new Map();
  for (const tx of eevdTxs) {
    const b = tx.bandeira.toUpperCase();
    eevdLiqByBand.set(b, (eevdLiqByBand.get(b) || 0) + tx.valorLiquido);
    eevdBrutoByBand.set(b, (eevdBrutoByBand.get(b) || 0) + tx.valorBruto);
  }
  const totalEevdLiq = eevdTxs.reduce((s, t) => s + t.valorLiquido, 0);
  const totalEevdBruto = eevdTxs.reduce((s, t) => s + t.valorBruto, 0);

  // === EEFI: total liquido + datas de venda ===
  const eefiData = parseEEFI(dia.eefi);
  const eefiLiqTotal = eefiData.total;

  console.log('EEVD txs:', eevdTxs.length, '| Liquido: R$' + totalEevdLiq.toFixed(2), '| Bruto: R$' + totalEevdBruto.toFixed(2));
  console.log('EEFI liquido total: R$' + eefiLiqTotal.toFixed(2) + ' | Datas venda: ' + eefiData.saleDatesCT.map(s => s.saleDate + '/CT' + s.ct + '(' + s.count + ')').join(', '));

  // === FN01 matching (para ENVIO) ===
  const debitoFn01 = matchDebitoFn01(eevdTxs, allFn01);
  const creditoFn01Grupos = matchCreditoFn01(eefiData, allFn01, dataLiqISO);

  // Agrupar debito FN01 por bandeira
  const debitoFn01ByBand = new Map();
  for (const fn of debitoFn01) {
    const band = getBandeira(fn.cartao).toUpperCase();
    if (!debitoFn01ByBand.has(band)) debitoFn01ByBand.set(band, []);
    debitoFn01ByBand.get(band).push(fn);
  }

  // === Extrato Bancario ===
  const extratoRede = parseExtrato(dia.extrato);
  const totalBanco = extratoRede.reduce((s, e) => s + e.valor, 0);

  // Calcular totais banco por natureza
  const totalBancoCredito = extratoRede.filter(e => e.natureza === 'CREDITO').reduce((s, e) => s + e.valor, 0);
  const totalBancoDebito = extratoRede.filter(e => e.natureza === 'DEBITO').reduce((s, e) => s + e.valor, 0);
  const totalAdqLiq = eefiLiqTotal + totalEevdLiq;
  const difBancoTotal = Math.round((totalAdqLiq - totalBanco) * 100) / 100;

  console.log('Banco: R$' + totalBanco.toFixed(2) + ' (CD:' + totalBancoCredito.toFixed(2) + ' DB:' + totalBancoDebito.toFixed(2) + ')');
  console.log('Adq Liquido Total: R$' + totalAdqLiq.toFixed(2) + ' | Dif Banco: R$' + difBancoTotal.toFixed(2));

  // === Montar resultado por linha do extrato ===
  const envios = [];
  for (const ext of extratoRede) {
    const bandKey = ext.bandeira.toUpperCase();
    let vendas = [];
    let adqLiquido = 0;

    if (ext.natureza === 'DEBITO') {
      // Adq liquido = EEVD liquido por bandeira
      adqLiquido = Math.round((eevdLiqByBand.get(bandKey) || 0) * 100) / 100;
      // FN01 para ENVIO
      vendas = (debitoFn01ByBand.get(bandKey) || []).map(fn => montarVenda(fn, false));
    } else {
      // Credito: EEFI nao tem split por bandeira, adq liquido = banco (dif=0 por linha)
      adqLiquido = ext.valor;
      // FN01 para ENVIO
      vendas = (creditoFn01Grupos.get(bandKey) || []).map(fn => montarVenda(fn, true));
    }

    const difBanco = Math.round((adqLiquido - ext.valor) * 100) / 100;
    const totalDevedor = vendas.reduce((s, v) => s + v.valorDevedor, 0);
    // Conciliacao = adquirente vs banco (nao FN01 vs banco)
    const conciliada = Math.abs(difBanco) < (ext.valor * 0.01); // 1% tolerancia

    envios.push({
      bandeira: ext.bandeira, natureza: ext.natureza, valorBanco: ext.valor,
      adqLiquido, difBanco,
      valorDevedor: Math.round(totalDevedor * 100) / 100,
      qtdVendas: vendas.length, conciliada, vendas, historico: ext.historico,
    });
  }

  // Salvar JSONs e mostrar resultado
  for (const env of envios) {
    const natLabel = env.natureza === 'CREDITO' ? 'CD' : 'DB';
    const dataFile = dia.data.split('/').reverse().join('');
    const fileName = 'ENVIO_REDE_' + env.bandeira + '_' + natLabel + '_' + dataFile + '.json';

    const envioJson = {
      id: 0, data: dataLiqISO,
      descricao: env.historico, tipo: 'C', valor: env.valorBanco,
      documento: 0, rede: 2, natureza: 2, banco: 341, agencia: 4525, conta: 95686,
      digitoConta: 0, arquivo: '', idArquivo: 0,
      vendas: env.vendas, liberacao: 0, idCliente: 11,
      valorVendas: env.valorDevedor, tipoFinalizadoraBaixa: 0,
    };
    fs.writeFileSync(OUT + fileName, JSON.stringify(envioJson, null, 2));

    const status = env.conciliada ? '✔' : '✘';
    const difStr = env.difBanco >= 0 ? '+' + env.difBanco.toFixed(2) : env.difBanco.toFixed(2);
    console.log('  ' + env.historico.padEnd(35) + ' Banco:R$' + env.valorBanco.toFixed(2).padStart(12)
      + ' | AdqLiq:R$' + env.adqLiquido.toFixed(2).padStart(12)
      + ' | DifBanco:' + difStr.padStart(10)
      + ' | FN01:' + String(env.qtdVendas).padStart(4)
      + ' ' + status);
  }

  // Montar detalhe para tela banco
  const detalhe = envios.map(env => ({
    historico: env.historico, rede: 'Rede', bandeira: env.bandeira,
    natureza: env.natureza, valor: env.valorBanco,
    adqLiquido: env.adqLiquido,
    adqConciliado: env.conciliada ? env.adqLiquido : 0,
    adqNaoConciliado: env.conciliada ? 0 : env.adqLiquido,
    adqInexistente: 0, adqTotal: env.adqLiquido,
    difTaxa: 0, difBanco: env.difBanco, origem: 'AGENDA',
    conciliada: env.conciliada, qtdVendas: env.qtdVendas,
  }));

  const concCount = envios.filter(e => e.conciliada).length;
  bancoResult.conciliacoes.push({
    data: dia.data, empresa: 'MATEUS FOOD', adquirente: 'Rede',
    conta: 'ITAU / 4525 / 956860',
    resumo: {
      totalOrdens: Math.round(totalBanco * 100) / 100,
      totalAdqLiquido: Math.round(totalAdqLiq * 100) / 100,
      totalAdqCredito: Math.round(eefiLiqTotal * 100) / 100,
      totalAdqDebito: Math.round(totalEevdLiq * 100) / 100,
      totalBanco: Math.round(totalBanco * 100) / 100,
      difTaxa: 0, difBanco: difBancoTotal,
      conciliada: concCount === envios.length,
    },
    detalhe,
  });
}

fs.writeFileSync(OUT + 'conciliacao-banco.json', JSON.stringify(bancoResult));
console.log('\nBanco JSON salvo com', bancoResult.conciliacoes.length, 'datas');
