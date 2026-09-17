// Tiny static file server for previewing docs/ locally - not part of the
// published site itself, just a dev convenience.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'docs');
const port = 4173;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

http
  .createServer((req, res) => {
    let filePath = path.join(root, decodeURIComponent(req.url.split('?')[0]));
    if (filePath.endsWith(path.sep)) filePath = path.join(filePath, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  })
  .listen(port, () => console.log(`Serving docs/ at http://localhost:${port}`));
