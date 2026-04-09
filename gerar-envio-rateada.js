const fs = require('fs');

// Arquivo referencia da Statix
const STATIX_FILE = 'C:/Users/grupomateus/Downloads/ENVIO_2072693_RATEADA/ENVIO_2072693_RATEADA.txt';
const FN01_BIG = 'C:/Users/grupomateus/Downloads/Result_6.sql';
const FN01_RECENT = 'C:/Users/grupomateus/Downloads/30131030204food.sql';
const EEFI_FILE = 'C:/Users/grupomateus/Downloads/REDE_102737762_02042026_EEFI_056.txt';
const EXTRATO_FILE = 'C:/Users/grupomateus/Downloads/P0250304.416220204 (1).RET';

// Referencia Statix para comparar
const statix = JSON.parse(fs.readFileSync(STATIX_FILE, 'utf-8'));
console.log('Statix referencia:', statix.vendas.length, 'vendas, R$', statix.valor);
console.log('Datas venda Statix:', [...new Set(statix.vendas.map(v => v.data))].sort().join(', '));

// Parsear FN01 (todos os arquivos)
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
    if (values.length < 75) continue;
    const v = parseFloat(values[16]) || 0;
    if (!v) continue;
    results.push({
      sequ: parseInt(values[0]) || 0,
      filial: parseInt(values[1]) || 0,
      idCliente: values[6],
      dtEmissao: values[7],
      dtVenc: values[9],
      numeDoc: values[13]?.trim() || '',
      titulo: values[14]?.trim() || '',
      valor: v,
      taxa: parseFloat(values[20]) || 0,
      valorDevedor: parseFloat(values[26]) || 0,
      pdv: parseInt(values[61]) || 0,
      cupom: parseInt(values[62]) || 0,
      nsuSitef: parseInt(values[63]) || 0,
      nsuHost: parseInt(values[64]) || 0,
      cartao: parseInt(values[65]) || 0,
      parcela: parseInt(values[69]) || 1,
      qtdeParcela: parseInt(values[71]) || 1,
      cnpj: parseInt(values[77]) || 0,
      loja: parseInt(values[1]) || 0,
    });
  }
  return results;
}

console.log('Parseando FN01...');
const fn01Big = parseFn01(FN01_BIG);
const fn01Recent = parseFn01(FN01_RECENT);
const allFn01 = [...fn01Big, ...fn01Recent];
console.log('FN01 total:', allFn01.length, 'linhas');

// Filtrar so Rede (14419)
const fn01Rede = allFn01.filter(f => f.idCliente === '14419');
console.log('FN01 Rede:', fn01Rede.length);

// Datas disponiveis
const fn01Dates = new Map();
fn01Rede.forEach(f => fn01Dates.set(f.dtEmissao, (fn01Dates.get(f.dtEmissao) || 0) + 1));
console.log('Datas:', [...fn01Dates.entries()].sort().map(([d, c]) => d + ':' + c).join(', '));

// Agora preciso selecionar as vendas que compoem a liquidacao MasterCard Credito
// A Statix tem vendas de 30/01 e 02/03 com vencimento 31/03 e 01/04
// Essas sao vendas cujo vencimento cai no periodo da liquidacao

// Parsear EEFI para descobrir as datas de venda originais da liquidacao
const eefiContent2 = fs.readFileSync(EEFI_FILE, 'utf-8');
const eefiSaleDates = new Set();
for (const l of eefiContent2.split('\n')) {
  if (!l.startsWith('034')) continue;
  // Pos 84-92: data de venda original (DDMMYYYY)
  const dv = l.substring(84, 92);
  const dd = dv.substring(0,2), mm = dv.substring(2,4), yyyy = dv.substring(4);
  if (parseInt(mm) <= 12 && parseInt(dd) <= 31 && yyyy.startsWith('202')) {
    const dateISO = yyyy + '-' + mm + '-' + dd;
    // Excluir data de vencimento (31/03) - so datas de venda real
    if (dateISO !== '2026-03-31') {
      eefiSaleDates.add(dateISO);
    }
  }
}
console.log('Datas de venda no EEFI:', [...eefiSaleDates].sort().join(', '));

// Filtrar FN01 por:
// 1. Data de emissao que esta no EEFI (30/01 e 02/03)
// 2. MasterCard (cartao comeca com 5 ou 2)
// 3. Vencimento 31/03 ou 01/04
const fn01MastCred = fn01Rede.filter(f => {
  const emissaoMatch = eefiSaleDates.has(f.dtEmissao);
  const vencMatch = f.dtVenc === '2026-03-31' || f.dtVenc === '2026-04-01';
  const cartaoStr = String(f.cartao);
  const isMast = cartaoStr.startsWith('5') || cartaoStr.startsWith('2');
  return emissaoMatch && vencMatch && isMast;
});

console.log('FN01 MasterCard Credito (venc 31/03 e 01/04):', fn01MastCred.length);

// Agrupar por numeDoc (parcelas)
const fn01G = new Map();
for (const f of fn01MastCred) {
  if (!fn01G.has(f.numeDoc)) fn01G.set(f.numeDoc, { ...f, valor: 0, valorDevedor: 0 });
  const g = fn01G.get(f.numeDoc);
  g.valor += f.valor;
  g.valorDevedor += f.valorDevedor;
}
const fn01Agrupado = [...fn01G.values()];
console.log('FN01 agrupado:', fn01Agrupado.length);
const totalValor = fn01Agrupado.reduce((s, f) => s + f.valor, 0);
console.log('Total valor:', totalValor.toFixed(2));
console.log('Statix valor:', statix.valor);

// Montar as vendas no formato identico ao Statix
const vendas = fn01Agrupado.map(f => ({
  loja: f.loja,
  data: f.dtEmissao,
  pdv: f.pdv,
  autorizacao: String(f.nsuHost),
  valorTransacao: Math.round(f.valor * 100) / 100,
  cnpj: f.cnpj,
  rede: 1,
  produto: 1141,
  valorDevedor: Math.round(f.valorDevedor * 100) / 100,
  nsuHost: f.nsuHost,
  nsuSitef: f.nsuSitef,
  qtdParcela: f.qtdeParcela,
  parcela: f.parcela,
  dataVencimento: f.dtVenc,
  tipo: 3,
  numeroTitulo: f.titulo,
  sequencial: f.sequ,
  numeroCupom: f.cupom,
  qtdCupom: 1,
  estabelecimento: 201661102737975,
  capturaAdquirente: 1,
  meioCaptura: 1,
  valorPago: Math.round(f.valor * 100) / 100,
  idCliente: 11,
  idEmpresa: 301,
  chaveVenda: 0,
  idProdutoStatix: 6,
  valorVendaAdquirente: 0.0,
  valorVendaCliente: 0.0,
}));

// Valor do banco para MasterCard Credito
const bancoValor = 26088.79;

const envio = {
  id: 0,
  data: '2026-04-02',
  descricao: 'REDE MAST CD0102737975',
  tipo: 'C',
  valor: bancoValor,
  documento: 0,
  rede: 2,
  natureza: 2,
  banco: 341,
  agencia: 4525,
  conta: 95686,
  digitoConta: 0,
  arquivo: 'P0250304.416220204.RET',
  idArquivo: 0,
  vendas: vendas,
  liberacao: 0,
  idCliente: 11,
  valorVendas: Math.round(vendas.reduce((s, v) => s + v.valorTransacao, 0) * 100) / 100,
  tipoFinalizadoraBaixa: 0,
};

const outputPath = 'C:/Users/grupomateus/OneDrive/Área de Trabalho/Projetos IA/conciliacao-spring/ENVIO_REDE_MAST_CD_02042026.json';
fs.writeFileSync(outputPath, JSON.stringify(envio, null, 2));

console.log('');
console.log('=== RESULTADO ===');
console.log('Vendas:', envio.vendas.length, '(Statix:', statix.vendas.length + ')');
console.log('Valor vendas:', envio.valorVendas, '(Statix:', statix.valorVendas?.toFixed(2) + ')');
console.log('Valor banco:', envio.valor, '(Statix:', statix.valor + ')');
console.log('');

// Comparar datas
const nossoDates = new Map();
vendas.forEach(v => nossoDates.set(v.data, (nossoDates.get(v.data) || 0) + 1));
console.log('Datas NOSSO:', [...nossoDates.entries()].sort().map(([d, c]) => d + ':' + c).join(', '));
const statixDates = new Map();
statix.vendas.forEach(v => statixDates.set(v.data, (statixDates.get(v.data) || 0) + 1));
console.log('Datas STATIX:', [...statixDates.entries()].sort().map(([d, c]) => d + ':' + c).join(', '));

// Comparar parcelas
const nossoParcelas = new Map();
vendas.forEach(v => { const k = v.parcela + '/' + v.qtdParcela; nossoParcelas.set(k, (nossoParcelas.get(k) || 0) + 1); });
const statixParcelas = new Map();
statix.vendas.forEach(v => { const k = v.parcela + '/' + v.qtdParcela; statixParcelas.set(k, (statixParcelas.get(k) || 0) + 1); });
console.log('Parcelas NOSSO:', [...nossoParcelas.entries()].sort().map(([p, c]) => p + '(' + c + ')').join(', '));
console.log('Parcelas STATIX:', [...statixParcelas.entries()].sort().map(([p, c]) => p + '(' + c + ')').join(', '));

console.log('');
console.log('Arquivo salvo:', outputPath);
