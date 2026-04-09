const fs = require('fs');

// Extrato bancario 06/04 - lancamentos REDE
const extratoRede = [
  {bandeira:'AMEX', natureza:'CD', valor:7.59, desc:'REDE AMEX CD0102737975'},
  {bandeira:'ELO', natureza:'DB', valor:9301.45, desc:'REDE ELO  DB0102737975'},
  {bandeira:'ELO', natureza:'CD', valor:8338.04, desc:'REDE ELO  CD0102737975'},
  {bandeira:'MAST', natureza:'CD', valor:82852.70, desc:'REDE MAST CD0102737975'},
  {bandeira:'MAST', natureza:'DB', valor:55194.23, desc:'REDE MAST DB0102737975'},
  {bandeira:'VISA', natureza:'CD', valor:57909.66, desc:'REDE VISA CD0102737975'},
  {bandeira:'VISA', natureza:'DB', valor:43949.93, desc:'REDE VISA DB0102737975'},
  {bandeira:'VISA', natureza:'CD2', valor:48.65, desc:'REDE VISA CD0102737975'},
];

// EEFI datas de venda (credito)
const eefiContent = fs.readFileSync('C:/Users/grupomateus/Downloads/REDE_102737762_06042026_EEFI_060.txt','utf-8');
const eefiSaleDates = new Set();
for (const l of eefiContent.split('\n')) {
  if (!l.startsWith('034')) continue;
  const dv = l.substring(84, 92);
  const dd = dv.substring(0,2), mm = dv.substring(2,4), yyyy = dv.substring(4);
  if (parseInt(mm) <= 12 && parseInt(dd) <= 31 && yyyy.startsWith('202')) {
    const venc = l.substring(67,75);
    const vencISO = venc.substring(4)+'-'+venc.substring(2,4)+'-'+venc.substring(0,2);
    const saleISO = yyyy+'-'+mm+'-'+dd;
    if (saleISO !== vencISO) eefiSaleDates.add(saleISO);
  }
}
// EEVD datas (debito)
const eevdSaleDates = new Set(['2026-04-02','2026-04-03','2026-04-04','2026-04-05']);

// Parsear FN01
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
      if (ch === "'" && inStr) { if (raw[i+1] === "'") { curr += "'"; i++; continue; } inStr = false; continue; }
      if (ch === ',' && !inStr) { values.push(curr.trim().replace(/^N$/, '')); curr = ''; continue; }
      if (ch === 'N' && raw[i+1] === "'" && !inStr) { continue; }
      curr += ch;
    }
    values.push(curr.trim());
    if (values.length < 75) continue;
    const v = parseFloat(values[16]) || 0;
    if (!v || values[6] !== '14419') continue;
    results.push({
      sequ: parseInt(values[0])||0, loja: parseInt(values[1])||0, dtEmissao: values[7],
      dtVenc: values[9], titulo: values[14] ? values[14].trim() : '', valor: v,
      valorDevedor: parseFloat(values[26])||0, pdv: parseInt(values[61])||0,
      cupom: parseInt(values[62])||0, nsuSitef: parseInt(values[63])||0,
      nsuHost: parseInt(values[64])||0, cartao: String(values[65]||'').trim(),
      parcela: parseInt(values[69])||1, qtdeParcela: parseInt(values[71])||1,
      cnpj: parseInt(values[77])||0,
    });
  }
  return results;
}

console.log('Parseando FN01...');
let allFn01 = [];
['C:/Users/grupomateus/Downloads/Result_6.sql',
 'C:/Users/grupomateus/Downloads/fn010303a2203.sql',
 'C:/Users/grupomateus/Downloads/Result_10.sql',
 'C:/Users/grupomateus/Downloads/30131030204food.sql'].forEach(f => {
  if (fs.existsSync(f)) { allFn01 = allFn01.concat(parseFn01(f)); console.log('  ' + f.split('/').pop() + ': ok'); }
});
console.log('FN01 total:', allFn01.length);

// BINs por bandeira
function getBandeira(cartao) {
  const bin = cartao.substring(0,3);
  const bin2 = cartao.substring(0,2);
  // Elo
  if (['407','506','509','516','539','552','650','651','655','636','504'].includes(bin)) return 'ELO';
  // Amex
  if (bin2 === '34' || bin2 === '37') return 'AMEX';
  // Visa
  if (bin.startsWith('4')) return 'VISA';
  // MasterCard
  if (bin.startsWith('5') || bin2 === '22' || bin2 === '23') return 'MAST';
  return 'N/I';
}

// Gerar ENVIO para cada lancamento do extrato
const envios = [];
for (const ext of extratoRede) {
  const isCredito = ext.natureza.startsWith('CD');
  const isDebito = ext.natureza === 'DB';
  const saleDates = isCredito ? eefiSaleDates : eevdSaleDates;

  const candidatos = allFn01.filter(f => {
    if (!saleDates.has(f.dtEmissao)) return false;
    const band = getBandeira(f.cartao);
    if (band !== ext.bandeira) return false;
    if (isDebito && (f.parcela !== 1 || f.qtdeParcela !== 1)) return false;
    // Credito: vencimento proximo da liquidacao
    if (isCredito && f.dtVenc !== '2026-04-01' && f.dtVenc !== '2026-03-31' && f.dtVenc !== '2026-04-06') return false;
    return true;
  });

  // Agrupar por titulo
  const grouped = new Map();
  for (const f of candidatos) {
    if (!grouped.has(f.titulo)) grouped.set(f.titulo, {...f, valor: 0, valorDevedor: 0});
    const g = grouped.get(f.titulo);
    g.valor += f.valor; g.valorDevedor += f.valorDevedor;
  }

  const vendas = [...grouped.values()].map(f => ({
    loja: f.loja, data: f.dtEmissao, pdv: f.pdv,
    autorizacao: String(f.nsuHost),
    valorTransacao: Math.round(f.valor * 100) / 100,
    cnpj: f.cnpj, rede: 1, produto: isDebito ? 1206 : 1141,
    valorDevedor: Math.round(f.valorDevedor * 100) / 100,
    nsuHost: f.nsuHost, nsuSitef: f.nsuHost,
    qtdParcela: f.qtdeParcela, parcela: f.parcela,
    dataVencimento: f.dtVenc, tipo: 3,
    numeroTitulo: f.titulo, sequencial: f.sequ,
    numeroCupom: 1, qtdCupom: 1,
    estabelecimento: 201661102737975,
    capturaAdquirente: 1, meioCaptura: 1,
    valorPago: Math.round(f.valor * 100) / 100,
    idCliente: 11, idEmpresa: 301, chaveVenda: 0,
    idProdutoStatix: isDebito ? 20 : 6,
    valorVendaAdquirente: 0.0, valorVendaCliente: 0.0,
  }));

  const natLabel = isDebito ? 'DB' : 'CD';
  const bandLabel = ext.bandeira === 'MAST' ? 'MasterCard' : ext.bandeira === 'VISA' ? 'Visa' : ext.bandeira;
  const fileName = 'ENVIO_REDE_' + bandLabel + '_' + natLabel + '_06042026.json';

  const envio = {
    id: 0, data: '2026-04-06', descricao: ext.desc,
    tipo: 'C', valor: ext.valor, documento: 0, rede: 2, natureza: 2,
    banco: 341, agencia: 4525, conta: 95686, digitoConta: 0,
    arquivo: 'P0250704.418087635.RET', idArquivo: 0,
    vendas, liberacao: 0, idCliente: 11,
    valorVendas: ext.valor, tipoFinalizadoraBaixa: 0,
  };

  fs.writeFileSync(fileName, JSON.stringify(envio, null, 2));
  console.log(fileName.padEnd(45) + ' | Vendas: ' + String(vendas.length).padStart(4) + ' | Valor: R$' + ext.valor.toFixed(2).padStart(12));
  envios.push({fileName, vendas: vendas.length, valor: ext.valor, desc: ext.desc});
}

// Salvar lista para botoes de download
fs.writeFileSync('envios-06042026.json', JSON.stringify(envios));
console.log('\nTotal:', envios.length, 'arquivos gerados!');
