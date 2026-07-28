const express = require('express');
const http = require('http');
const { spawn, exec, execSync } = require('child_process');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const PORT = 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (r, p) => { if (p.endsWith('.html')) r.setHeader('Cache-Control', 'no-cache'); } }));
app.use('/monaco', express.static(path.join(__dirname, 'node_modules/monaco-editor/min')));
app.use('/icons', express.static(path.join(__dirname, 'icons')));
app.get('/project-root', (req, res) => res.json({ root: __dirname.replace(/\\/g, '/') }));
app.get('/api/theme', (req, res) => { try { res.json(JSON.parse(fs.readFileSync(path.join(__dirname, 'theme.json'), 'utf-8'))); } catch (_) { res.json({}); } });

app.get('/api/files', (req, res) => {
  const dir = req.query.path || __dirname;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    res.json({
      dirs: entries.filter(e => e.isDirectory()).map(e => e.name),
      files: entries.filter(e => e.isFile()).map(e => e.name),
    });
  } catch (_) { res.json({ dirs: [], files: [] }); }
});

app.get('/api/file', (req, res) => {
  try { res.json({ content: fs.readFileSync(req.query.path, 'utf-8') }); }
  catch (_) { res.status(404).json({ error: 'not found' }); }
});

app.post('/api/file', (req, res) => {
  try {
    fs.mkdirSync(path.dirname(req.body.path), { recursive: true });
    fs.writeFileSync(req.body.path, req.body.content, 'utf-8');
    res.json({ ok: true });
  } catch (_) { res.status(500).json({ error: 'write failed' }); }
});

app.post('/api/file/create', (req, res) => {
  try { fs.writeFileSync(req.body.path, '', 'utf-8'); res.json({ ok: true }); }
  catch (_) { res.status(500).json({ error: 'create failed' }); }
});

app.post('/api/dir/create', (req, res) => {
  try { fs.mkdirSync(req.body.path, { recursive: true }); res.json({ ok: true }); }
  catch (_) { res.status(500).json({ error: 'create failed' }); }
});

app.delete('/api/file', (req, res) => {
  try { fs.unlinkSync(req.query.path); res.json({ ok: true }); }
  catch (_) { res.status(500).json({ error: 'delete failed' }); }
});

app.delete('/api/dir', (req, res) => {
  try { fs.rmSync(req.query.path, { recursive: true }); res.json({ ok: true }); }
  catch (_) { res.status(500).json({ error: 'delete failed' }); }
});

app.post('/api/rename', (req, res) => {
  try { fs.renameSync(req.body.oldPath, req.body.newPath); res.json({ ok: true }); }
  catch (_) { res.status(500).json({ error: 'rename failed' }); }
});

app.post('/api/reveal', (req, res) => {
  try { exec(`explorer /select,"${req.body.path}"`); res.json({ ok: true }); }
  catch (_) { res.json({ ok: false }); }
});

app.post('/api/compile', (req, res) => {
  const { path: filePath, content } = req.body;
  try {
    if (content !== undefined) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');
    }
    const exePath = filePath.replace(/\.\w+$/, '') + '.exe';
    execSync(`"g++" -std=c++17 -Wall -O2 -o "${exePath}" "${filePath}"`, { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 });
    res.json({ ok: true });
  } catch (e) {
    const err = (e.stderr || e.stdout || e.message || '').toString();
    res.json({ ok: false, error: err });
  }
});

app.post('/api/run', (req, res) => {
  const { path: filePath } = req.body;
  const exePath = filePath.replace(/\.\w+$/, '') + '.exe';
  try {
    exec(`start "" cmd /c "consolepauser 0 0 \"${exePath}\" & pause"`, { shell: 'cmd.exe' });
    res.json({ ok: true });
  } catch (_) { res.json({ ok: false }); }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function sendLsp(stream, json) {
  const data = Buffer.from(json, 'utf-8');
  const header = `Content-Length: ${data.length}\r\n\r\n`;
  stream.write(Buffer.concat([Buffer.from(header, 'ascii'), data]));
}

function createLspReader(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) break;
      const m = buf.slice(0, end).toString().match(/Content-Length: (\d+)/);
      if (!m) break;
      const len = parseInt(m[1], 10), off = end + 4;
      if (buf.length < off + len) break;
      onMessage(buf.slice(off, off + len).toString());
      buf = buf.slice(off + len);
    }
  };
}

wss.on('connection', (ws) => {
  const clangd = spawn('clangd', [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const reader = createLspReader((json) => {
    try { ws.send(json); } catch (_) {}
  });
  clangd.stdout.on('data', reader);
  clangd.stderr.on('data', (d) => { try { ws.send(JSON.stringify({ method: 'clangd/log', params: { text: d.toString() } })); } catch(_) {} });
  ws.on('message', (data) => sendLsp(clangd.stdin, data.toString()));
  ws.on('close', () => clangd.kill());
  clangd.on('exit', () => { try { ws.close(); } catch (_) {} });
});

server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
