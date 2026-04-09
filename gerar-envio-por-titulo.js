const fs = require('fs');

// Arquivos de referencia Statix (para pegar os titulos corretos)
const STATIX_FILES = {
  'MAST_CD': 'C:/Users/grupomateus/Downloads/ENVIO_2072693_RATEADA/ENVIO_2072693_RATEADA.txt',
  'ELO_DB': 'C:/Users/grupomateus/Downloads/ENVIO_2074443_RATEADA/ENVIO_2074443_RATEADA.txt',
  'ELO_CD': 'C:/Users/grupomateus/Downloads/ENVIO_2074577_AGRUPADA/ENVIO_2074577_AGRUPADA.txt',
};

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

console.log('Parseando FN01...');
let allFn01 = [];
['C:/Users/grupomateus/Downloads/Result_6.sql',
  'C:/Users/grupomateus/Downloads/fn010303a2203.sql',
  'C:/Users/grupomateus/Downloads/Result_10.sql',
  'C:/Users/grupomateus/Downloads/30131030204food.sql'].forEach(f => {
    if (fs.existsSync(f)) allFn01 = allFn01.concat(parseFn01(f));
  });
console.log('FN01 total:', allFn01.length);

// Indexar FN01 por titulo
const fn01ByTitulo = new Map();
for (const f of allFn01) {
  if (!fn01ByTitulo.has(f.titulo)) fn01ByTitulo.set(f.titulo, f);
}

// Para cada arquivo Statix, gerar o nosso usando os mesmos titulos
for (const [label, statixFile] of Object.entries(STATIX_FILES)) {
  if (!fs.existsSync(statixFile)) { console.log(label + ': arquivo Statix nao encontrado'); continue; }

  const statix = JSON.parse(fs.readFileSync(statixFile, 'utf-8'));
  console.log('\n=== ' + label + ' (' + statix.descricao + ') ===');

  const vendas = [];
  let found = 0, notFound = 0;

  for (const sv of statix.vendas) {
    const fn = fn01ByTitulo.get(sv.numeroTitulo);
    if (fn) {
      // Calcular valor devedor correto
      let valorDev = fn.valorDevedor;
      if (valorDev === 0) valorDev = Math.round((fn.valor - fn.taxa) * 100) / 100;

      vendas.push({
        loja: fn.loja,
        data: fn.dtEmissao,
        pdv: fn.pdv,
        autorizacao: String(fn.nsuHost),
        valorTransacao: Math.round(fn.valor * 100) / 100,
        cnpj: fn.cnpj,
        rede: 1,
        produto: sv.produto || 1141,
        valorDevedor: valorDev,
        nsuHost: fn.nsuHost,
        nsuSitef: fn.nsuHost,
        qtdParcela: fn.qtdeParcela,
        parcela: fn.parcela,
        dataVencimento: fn.dtVenc,
        tipo: 3,
        numeroTitulo: fn.titulo,
        sequencial: fn.sequ,
        numeroCupom: 1,
        qtdCupom: 1,
        estabelecimento: 201661102737975,
        capturaAdquirente: 1,
        meioCaptura: 1,
        valorPago: valorDev,
        idCliente: 11,
        idEmpresa: 301,
        chaveVenda: 0,
        idProdutoStatix: sv.idProdutoStatix || 6,
        valorVendaAdquirente: 0.0,
        valorVendaCliente: 0.0,
      });
      found++;
    } else {
      notFound++;
    }
  }

  const totalDevedor = vendas.reduce((s, v) => s + v.valorDevedor, 0);
  const totalValor = vendas.reduce((s, v) => s + v.valorTransacao, 0);

  const envio = {
    id: 0,
    data: statix.data,
    descricao: statix.descricao,
    tipo: statix.tipo,
    valor: statix.valor,
    documento: 0,
    rede: statix.rede,
    natureza: statix.natureza,
    banco: statix.banco,
    agencia: statix.agencia,
    conta: statix.conta,
    digitoConta: statix.digitoConta || 0,
    arquivo: statix.arquivo || '',
    idArquivo: 0,
    vendas,
    liberacao: 0,
    idCliente: statix.idCliente,
    valorVendas: Math.round(totalDevedor * 100) / 100,
    tipoFinalizadoraBaixa: 0,
  };

  const fileName = 'ENVIO_REDE_' + label + '_' + statix.data.replace(/-/g, '') + '.json';
  fs.writeFileSync(fileName, JSON.stringify(envio, null, 2));

  console.log('Encontrados:', found, '| Nao encontrados:', notFound);
  console.log('Valor extrato:', statix.valor);
  console.log('Soma valorDevedor FN01:', totalDevedor.toFixed(2));
  console.log('Soma valorTitulo FN01:', totalValor.toFixed(2));
  console.log('Diff devedor vs extrato:', (totalDevedor - statix.valor).toFixed(2));
  console.log('Arquivo:', fileName);
}
