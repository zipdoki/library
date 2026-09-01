const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;
const BASE = '/library';
const CONTENT_DIR = path.join(__dirname, '..', 'pages-worktree');

function collectMdFiles(dir, root) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs);
    if (entry.isDirectory()) {
      results.push({ type: 'tree', path: rel, sha: '' });
      results.push(...collectMdFiles(abs, root));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push({ type: 'blob', path: rel, sha: '' });
    }
  }
  return results;
}

app.get('/api/tree', (req, res) => {
  try {
    res.json({ tree: collectMdFiles(CONTENT_DIR, CONTENT_DIR) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/file/*', (req, res) => {
  const rel = req.params[0];
  const abs = path.resolve(CONTENT_DIR, rel);
  if (!abs.startsWith(CONTENT_DIR + path.sep) && abs !== CONTENT_DIR) {
    return res.status(403).send('Forbidden');
  }
  res.sendFile(abs, (err) => { if (err) res.status(404).send('Not found'); });
});

app.use('/images', express.static(path.join(CONTENT_DIR, 'images')));
const DOCS_DIR = path.join(__dirname, '..', 'docs');
const EDITS_HTML = path.join(DOCS_DIR, 'edits', 'index.html');

app.get([`${BASE}/edits`, `${BASE}/edits/*`], (req, res) => {
  res.sendFile(EDITS_HTML);
});

app.use(BASE, express.static(DOCS_DIR));

app.get(`${BASE}/*`, (req, res) => {
  res.sendFile(path.join(DOCS_DIR, 'index.html'));
});

app.get('/', (req, res) => res.redirect(BASE + '/'));

app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}${BASE}/`);
});
