const http = require('http');
const port = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/html'});
  res.end(`<h1>Hello from Node ${process.version} inside LiteBox</h1><p>${process.arch} ${new Date().toISOString()}</p>`);
}).listen(port, '0.0.0.0', () => console.log('listening on ' + port));
