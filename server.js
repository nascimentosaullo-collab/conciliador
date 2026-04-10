const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5500;
const DIR = __dirname;

http.createServer((req, res) => {
  let url = req.url === '/' ? '/conciliacao-resultado.html' : req.url;
  url = decodeURIComponent(url.split('?')[0]);
  const fp = path.join(DIR, url);
  const ext = path.extname(fp);
  const types = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.css': 'text/css',
  };
  const ct = types[ext] || 'text/plain';
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); }
    else { res.writeHead(200, { 'Content-Type': ct + ';charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(data); }
  });
}).listen(PORT, () => {
  console.log('Server running on http://localhost:' + PORT);
});
