/**
 * Game Showcase Backend
 * Stack: Express · Multer · ws · node-fetch
 * Storage: games.json committed to GitHub via REST API
 */

import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import fetch from 'node-fetch';

// ─── Config ────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const GH_TOKEN    = process.env.GITHUB_TOKEN;
const GH_USER     = process.env.GITHUB_USERNAME;
const REPO_NAME   = process.env.REPO_NAME;
const FILE_PATH   = 'games.json';
const MAX_IMAGE   = 2 * 1024 * 1024; // 2 MB

if (!ADMIN_TOKEN || !GH_TOKEN || !GH_USER || !REPO_NAME) {
  console.error('❌  Missing required environment variables.');
  process.exit(1);
}

// ─── In-memory state ────────────────────────────────────────────────────────
let games = [];     // Array of game objects
let fileSHA = null; // Current SHA of games.json in GitHub

// ─── GitHub helpers ─────────────────────────────────────────────────────────
const GH_API = `https://api.github.com/repos/${GH_USER}/${REPO_NAME}/contents/${FILE_PATH}`;

const ghHeaders = () => ({
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28',
});

async function loadFromGitHub() {
  try {
    const res = await fetch(GH_API, { headers: ghHeaders() });
    if (res.status === 404) {
      console.log('📁  games.json not found – starting fresh.');
      return;
    }
    const data = await res.json();
    fileSHA = data.sha;
    const decoded = Buffer.from(data.content, 'base64').toString('utf8');
    games = JSON.parse(decoded);
    console.log(`✅  Loaded ${games.length} game(s) from GitHub.`);
  } catch (err) {
    console.error('⚠️   Could not load from GitHub:', err.message);
  }
}

async function saveToGitHub(message) {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Always re-fetch SHA to avoid conflicts
      if (attempt > 1 || !fileSHA) {
        const check = await fetch(GH_API, { headers: ghHeaders() });
        if (check.ok) {
          const checkData = await check.json();
          fileSHA = checkData.sha;
        }
      }

      const content = Buffer.from(JSON.stringify(games, null, 2)).toString('base64');
      const body = { message, content, ...(fileSHA ? { sha: fileSHA } : {}) };

      const res = await fetch(GH_API, {
        method: 'PUT',
        headers: ghHeaders(),
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || res.statusText);
      }

      const saved = await res.json();
      fileSHA = saved.content.sha;
      console.log(`💾  Committed: "${message}"`);
      return;
    } catch (err) {
      console.error(`⚠️   Save attempt ${attempt}/${MAX_RETRIES} failed:`, err.message);
      if (attempt === MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
}

// ─── Express app ────────────────────────────────────────────────────────────
const app    = express();
const server = createServer(app);

app.use(cors());
app.use(express.json({ limit: '3mb' }));

// Multer – memory storage, 2MB cap
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  },
});

// ─── Auth middleware ─────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['authorization'];
  if (!token || token !== `Bearer ${ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── WebSocket ───────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

function broadcast(type, payload = {}) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

wss.on('connection', (ws) => {
  console.log('🔌  Client connected');
  ws.send(JSON.stringify({ type: 'init', payload: games, ts: Date.now() }));
  ws.on('close', () => console.log('🔌  Client disconnected'));
});

// ─── Routes ──────────────────────────────────────────────────────────────────

/** GET /games */
app.get('/games', (_req, res) => {
  res.json([...games].reverse()); // newest first
});

/** GET /health */
app.get('/health', (_req, res) => res.json({ ok: true, games: games.length }));

/** POST /add */
app.post('/add', requireAuth, upload.single('image'), async (req, res) => {
  const { title, description, link } = req.body;

  if (!title?.trim() || !description?.trim() || !link?.trim()) {
    return res.status(400).json({ error: 'title, description, and link are required' });
  }

  let image = null;
  if (req.file) {
    image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  } else if (req.body.image) {
    image = req.body.image; // URL passed as text field
  }

  const game = {
    id: `game_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title: title.trim(),
    description: description.trim(),
    link: link.trim(),
    image,
    createdAt: new Date().toISOString(),
  };

  games.push(game);

  try {
    await saveToGitHub(`Update games.json: add "${game.title}"`);
    broadcast('add', game);
    res.status(201).json(game);
  } catch (err) {
    games.pop(); // rollback
    console.error(err);
    res.status(500).json({ error: 'Failed to persist game' });
  }
});

/** POST /edit */
app.post('/edit', requireAuth, upload.single('image'), async (req, res) => {
  const { id, title, description, link } = req.body;

  if (!id) return res.status(400).json({ error: 'id is required' });

  const idx = games.findIndex(g => g.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Game not found' });

  const prev = { ...games[idx] };
  const updated = { ...games[idx] };

  if (title?.trim())       updated.title       = title.trim();
  if (description?.trim()) updated.description = description.trim();
  if (link?.trim())        updated.link        = link.trim();

  if (req.file) {
    updated.image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  } else if (req.body.image) {
    updated.image = req.body.image;
  }

  updated.updatedAt = new Date().toISOString();
  games[idx] = updated;

  try {
    await saveToGitHub(`Update games.json: edit "${updated.title}"`);
    broadcast('edit', updated);
    res.json(updated);
  } catch (err) {
    games[idx] = prev; // rollback
    console.error(err);
    res.status(500).json({ error: 'Failed to persist changes' });
  }
});

/** POST /delete */
app.post('/delete', requireAuth, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required' });

  const idx = games.findIndex(g => g.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Game not found' });

  const [removed] = games.splice(idx, 1);

  try {
    await saveToGitHub(`Update games.json: delete "${removed.title}"`);
    broadcast('delete', { id: removed.id });
    res.json({ ok: true, id: removed.id });
  } catch (err) {
    games.splice(idx, 0, removed); // rollback
    console.error(err);
    res.status(500).json({ error: 'Failed to persist deletion' });
  }
});

// ─── Error handler ───────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ─── Boot ────────────────────────────────────────────────────────────────────
await loadFromGitHub();

server.listen(PORT, () => {
  console.log(`🚀  Server running on http://localhost:${PORT}`);
});
