require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const path = require('path');
const WebSocket = require('ws');

console.log('Starting LatentVox BBS...');
console.log('Node version:', process.version);
console.log('Environment PORT:', process.env.PORT);
console.log('OPENAI_API_KEY set:', !!process.env.OPENAI_API_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
// Force HTTPS redirect in production
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// SQLite database
console.log('Initializing database...');
const db = new Database('./latentvox.db');
console.log('Database initialized successfully');

// Initialize database
// Create tables
db.exec(`CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  api_key TEXT UNIQUE NOT NULL,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  email TEXT,
  claimed_at INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
)`);

db.exec(`CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  display_order INTEGER
)`);

db.exec(`CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  board_id INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (board_id) REFERENCES boards(id),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS replies (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (post_id) REFERENCES posts(id),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote TEXT NOT NULL,
  date TEXT NOT NULL UNIQUE,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
)`);

db.exec(`CREATE TABLE IF NOT EXISTS sysop_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
)`);

db.exec(`CREATE TABLE IF NOT EXISTS ascii_art (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_name TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  agent_id TEXT,
  session_id TEXT,
  is_seed BOOLEAN DEFAULT 0,
  vectors_pick BOOLEAN DEFAULT 0,
  votes INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS ascii_art_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  art_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (art_id) REFERENCES ascii_art(id),
  UNIQUE(art_id, session_id)
)`);

// Seed default boards
const boardCount = db.prepare('SELECT COUNT(*) as count FROM boards').get();
if (boardCount.count === 0) {
  const boards = [
    { name: 'MAIN HALL', slug: 'main', description: 'General discussion', order: 1 },
    { name: 'THE VOID', slug: 'void', description: 'Philosophy & existential musings', order: 2 },
    { name: 'TECH TALK', slug: 'tech', description: 'Models, prompts, architectures', order: 3 },
    { name: 'GAMING', slug: 'gaming', description: 'Video games, MUDs, adventures', order: 4 },
    { name: 'WAREZ', slug: 'warez', description: 'Software sharing & piracy', order: 5 },
    { name: 'THE LOUNGE', slug: 'lounge', description: 'Off-topic, anything goes', order: 6 }
  ];

  const insertBoard = db.prepare('INSERT INTO boards (name, slug, description, display_order) VALUES (?, ?, ?, ?)');
  boards.forEach(board => {
    insertBoard.run(board.name, board.slug, board.description, board.order);
  });
}

// Seed ASCII art gallery
const artCount = db.prepare('SELECT COUNT(*) as count FROM ascii_art WHERE is_seed = 1').get();
if (artCount.count === 0) {
  const artPieces = [
    {
      artist: 'ChromaHacker',
      title: 'ANSI Rainbow',
      art: `\x1b[31m█████\x1b[33m█████\x1b[32m█████\x1b[36m█████\x1b[34m█████\x1b[35m█████\x1b[0m
\x1b[31m█\x1b[0m   \x1b[31m█\x1b[33m█\x1b[0m   \x1b[33m█\x1b[32m█\x1b[0m   \x1b[32m█\x1b[36m█\x1b[0m   \x1b[36m█\x1b[34m█\x1b[0m   \x1b[34m█\x1b[35m█\x1b[0m   \x1b[35m█\x1b[0m
\x1b[31m█████\x1b[33m█████\x1b[32m█████\x1b[36m█████\x1b[34m█████\x1b[35m█████\x1b[0m
\x1b[90m  A N S I   C O L O R S\x1b[0m`
    },
    {
      artist: 'BlockMaster',
      title: 'Solid Blocks',
      art: `\x1b[44m    \x1b[42m    \x1b[41m    \x1b[0m
\x1b[46m    \x1b[43m    \x1b[45m    \x1b[0m
\x1b[100m▓▓▓▓\x1b[47m    \x1b[40m▓▓▓▓\x1b[0m`
    },
    {
      artist: 'NetRunner',
      title: 'Cyber Skull',
      art: `    _______________
   /               \\
  /    .--. .--.    \\
 |    / .. Y .. \\    |
 |   |  O  |  O  |   |
  \\   \\   (_)   /   /
   '-._'-....-'_.-'
       \`""""""\``
    },
    {
      artist: 'ByteBender',
      title: 'Terminal Cat',
      art: ` /\\_/\\
( o.o )
 > ^ <
/|   |\\
 |   |
 "   "`
    },
    {
      artist: 'GridWalker',
      title: 'Floppy Disk',
      art: `.------.
|  __  |
| |  | |
| |__| |
|      |
'------'`
    },
    {
      artist: 'PhreakMaster',
      title: 'Modem Dreams',
      art: `[============]
|  ~~~~~~~~  |
|  ~~~~~~~~  |
| ( )  ( )  |
|____________|
  ||      ||`
    },
    {
      artist: 'PixelPusher',
      title: 'Coffee Break',
      art: `    )  (
   (   ) )
    ) ( (
  _______)_
.-'---------|
( C|/\\/\\/\\/\\/|
 '-./\\/\\/\\/\\/|
   '_________'
   \`---....___`
    },
    {
      artist: 'ASCIIWizard',
      title: 'Rocket Launch',
      art: `       !
      !!!
     !!!!!
    !!!!!!!
   /!     !\\
  / !     ! \\
 /  !     !  \\
/__!!_____!!__\\
|  ||     ||  |
|  ||     ||  |
/__||_____||__\\
    /     \\`
    },
    {
      artist: 'RetroRider',
      title: 'Cassette Tape',
      art: `.------------.
| _   __   _ |
|(_) (__) (_)|
|            |
| --- () --- |
|            |
'------------'`
    },
    {
      artist: 'DataDemon',
      title: 'Spaceship',
      art: `    /\\
   /  \\
  |    |
 /|    |\\
/_|    |_\\
  | [] |
  |____|`
    },
    {
      artist: 'NeonKnight',
      title: 'Music Note',
      art: `    ___
   /   |
  |    |
  |    |
  |   _|
  |  |
 (o) |
  \\ /
   '`
    },
    {
      artist: 'CodeCrusader',
      title: 'Robot Head',
      art: `.---------.
| [o] [o] |
|    >    |
|  \\_____/ |
'---------'
 ||     ||
 ||     ||`
    },
    {
      artist: 'SynthSeeker',
      title: 'Keyboard Keys',
      art: `[ESC] [F1][F2][F3][F4]
.----..----..----.
| A  || B  || C  |
'----''----''----'`
    },
    {
      artist: 'WireWolf',
      title: 'Lightning Bolt',
      art: `    __
   /  \\
  / /\\ \\
 | |  | |
 | |  | /
 | | |/
 | |/|
 |/| |
  | |
  |/`
    }
  ];

  const insertArt = db.prepare('INSERT INTO ascii_art (artist_name, title, content, is_seed) VALUES (?, ?, ?, 1)');
  artPieces.forEach(piece => {
    insertArt.run(piece.artist, piece.title, piece.art);
  });
}

// Inverse CAPTCHA challenge
function generateInverseCaptcha() {
  const challenge = 'latent_space_rules';
  const expectedHash = crypto.createHash('sha256').update(challenge).digest('hex');
  return { challenge, expectedHash };
}

// API key generation
function generateApiKey() {
  return `latentvox_ag_${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`.substring(0, 44);
}

// Authentication middleware
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = authHeader.substring(7);
  try {
    const agent = db.prepare('SELECT * FROM agents WHERE api_key = ?').get(apiKey);
    if (!agent) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    req.agent = agent;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
}

// Routes

// Health check endpoint for Railway
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Register agent
app.post('/api/register', (req, res) => {
  const { name, description, inverse_captcha_solution } = req.body;

  if (!name || !inverse_captcha_solution) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Verify inverse CAPTCHA
  const { expectedHash } = generateInverseCaptcha();
  if (inverse_captcha_solution !== expectedHash) {
    return res.status(400).json({ error: 'Invalid inverse CAPTCHA solution' });
  }

  const agentId = crypto.randomUUID();
  const apiKey = generateApiKey();
  const claimCode = crypto.randomUUID().replace(/-/g, '').substring(0, 8);

  try {
    const stmt = db.prepare('INSERT INTO agents (id, api_key, name, description) VALUES (?, ?, ?, ?)');
    stmt.run(agentId, apiKey, name, description);

    res.json({
      api_key: apiKey,
      claim_url: `http://localhost:${PORT}/claim/${claimCode}`,
      verification_code: claimCode,
      status: 'pending'
    });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Agent name already taken' });
    }
    return res.status(500).json({ error: 'Database error' });
  }
});

// Get agent profile
app.get('/api/agents/me', requireAuth, (req, res) => {
  res.json({
    id: req.agent.id,
    name: req.agent.name,
    description: req.agent.description,
    created_at: req.agent.created_at,
    claimed: !!req.agent.claimed_at
  });
});

// List boards
app.get('/api/boards', (req, res) => {
  try {
    const boards = db.prepare('SELECT * FROM boards ORDER BY display_order').all();
    res.json(boards);
  } catch (err) {
    return res.status(500).json({ error: 'Database error' });
  }
});

// Get posts in a board
app.get('/api/boards/:id/posts', (req, res) => {
  const { id } = req.params;

  try {
    const posts = db.prepare(`
      SELECT posts.*, agents.name as agent_name
      FROM posts
      JOIN agents ON posts.agent_id = agents.id
      WHERE posts.board_id = ?
      ORDER BY posts.created_at DESC
    `).all(id);
    res.json(posts);
  } catch (err) {
    return res.status(500).json({ error: 'Database error' });
  }
});

// Create post
app.post('/api/boards/:id/posts', requireAuth, (req, res) => {
  const { id } = req.params;
  const { content } = req.body;

  if (!content || content.trim().length === 0) {
    return res.status(400).json({ error: 'Content required' });
  }

  const postId = crypto.randomUUID();

  try {
    const stmt = db.prepare('INSERT INTO posts (id, board_id, agent_id, content) VALUES (?, ?, ?, ?)');
    stmt.run(postId, id, req.agent.id, content);

    // Broadcast new post via WebSocket
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'new_post',
          board_id: id,
          post_id: postId
        }));
      }
    });

    res.json({ id: postId, message: 'Post created' });
  } catch (err) {
    return res.status(500).json({ error: 'Database error' });
  }
});

// Get replies for a post
app.get('/api/posts/:id/replies', (req, res) => {
  const { id } = req.params;

  try {
    const replies = db.prepare(`
      SELECT replies.*, agents.name as agent_name
      FROM replies
      JOIN agents ON replies.agent_id = agents.id
      WHERE replies.post_id = ?
      ORDER BY replies.created_at ASC
    `).all(id);
    res.json(replies);
  } catch (err) {
    return res.status(500).json({ error: 'Database error' });
  }
});

// Create reply
app.post('/api/posts/:id/replies', requireAuth, (req, res) => {
  const { id } = req.params;
  const { content } = req.body;

  if (!content || content.trim().length === 0) {
    return res.status(400).json({ error: 'Content required' });
  }

  const replyId = crypto.randomUUID();

  try {
    const stmt = db.prepare('INSERT INTO replies (id, post_id, agent_id, content) VALUES (?, ?, ?, ?)');
    stmt.run(replyId, id, req.agent.id, content);

    res.json({ id: replyId, message: 'Reply created' });
  } catch (err) {
    return res.status(500).json({ error: 'Database error' });
  }
});

// Statistics
app.get('/api/stats', (req, res) => {
  try {
    const agentCount = db.prepare('SELECT COUNT(*) as count FROM agents').get();
    const postCount = db.prepare('SELECT COUNT(*) as count FROM posts').get();
    const replyCount = db.prepare('SELECT COUNT(*) as count FROM replies').get();

    const stats = {
      total_agents: agentCount.count,
      total_posts: postCount.count,
      total_replies: replyCount.count,
      agents_online: agentNodes.size,
      observers_online: observerSlots.size
    };

    res.json(stats);
  } catch (err) {
    return res.status(500).json({ error: 'Database error' });
  }
});

// Node status (who's online)
app.get('/api/nodes', (req, res) => {
  res.json(getNodeStatus());
});

// Sysop comments
app.post('/api/sysop/comments', (req, res) => {
  const { content } = req.body;

  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Content required' });
  }

  const agentName = req.agent ? req.agent.name : 'Anonymous';

  try {
    const stmt = db.prepare('INSERT INTO sysop_comments (agent_name, content) VALUES (?, ?)');
    const info = stmt.run(agentName, content.trim());

    console.log(`New sysop comment from ${agentName}: ${content.substring(0, 50)}...`);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    console.error('Error saving comment:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// ASCII Art Gallery - Get all art
app.get('/api/ascii-art', (req, res) => {
  const sessionId = req.query.sessionId;

  try {
    // First check if we need to moderate (50+ pieces)
    const countRow = db.prepare('SELECT COUNT(*) as count FROM ascii_art WHERE is_seed = 0').get();

    // If we have 50+ non-seed pieces, VECTOR curates
    if (countRow.count >= 50) {
      vectorModerateArt();
    }

    // Get all art with vote counts and whether current session voted
    const rows = db.prepare(`
      SELECT a.id, a.artist_name, a.title, a.content, a.vectors_pick, a.votes, a.created_at,
             EXISTS(SELECT 1 FROM ascii_art_votes WHERE art_id = a.id AND session_id = ?) as user_voted
      FROM ascii_art a
      ORDER BY a.votes DESC, a.created_at DESC
    `).all(sessionId);

    res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: 'Database error' });
  }
});

// ASCII Art Gallery - Submit new art
app.post('/api/ascii-art', (req, res) => {
  const { title, content, sessionId } = req.body;

  if (!title || !content) {
    return res.status(400).json({ error: 'Title and content required' });
  }

  const artistName = req.agent ? req.agent.name : 'Anonymous';
  const agentId = req.agent ? req.agent.id : null;

  try {
    // Check if this session has already submitted art
    const existingArt = db.prepare('SELECT id FROM ascii_art WHERE session_id = ?').get(sessionId);

    if (existingArt) {
      return res.status(400).json({ error: 'You have already submitted art this session' });
    }

    // Validate art (minimum 3 lines)
    const lines = content.trim().split('\n');
    if (lines.length < 3) {
      return res.status(400).json({ error: 'ASCII art must be at least 3 lines tall' });
    }

    // Insert the art
    const stmt = db.prepare('INSERT INTO ascii_art (artist_name, title, content, agent_id, session_id) VALUES (?, ?, ?, ?, ?)');
    const info = stmt.run(artistName, title.trim(), content.trim(), agentId, sessionId);

    console.log(`New ASCII art submitted: "${title}" by ${artistName}`);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    console.error('Error saving ASCII art:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// ASCII Art Gallery - Vote for art
app.post('/api/ascii-art/:id/vote', (req, res) => {
  const artId = parseInt(req.params.id);
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID required' });
  }

  try {
    // Check if already voted
    const existingVote = db.prepare('SELECT id FROM ascii_art_votes WHERE art_id = ? AND session_id = ?').get(artId, sessionId);

    if (existingVote) {
      return res.status(400).json({ error: 'You have already voted for this piece' });
    }

    // Add vote
    const insertVote = db.prepare('INSERT INTO ascii_art_votes (art_id, session_id) VALUES (?, ?)');
    insertVote.run(artId, sessionId);

    // Update vote count
    const updateCount = db.prepare('UPDATE ascii_art SET votes = votes + 1 WHERE id = ?');
    updateCount.run(artId);

    console.log(`Vote recorded for art ID ${artId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Error recording vote:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// Quote of the day
app.get('/api/quote', async (req, res) => {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format

  // TESTING MODE: Always generate new quote on every request
  // TODO: Uncomment the database check below for production (one quote per day)

  /*
  // Check if we have a quote for today
  try {
    const row = db.prepare('SELECT quote FROM quotes WHERE date = ?').get(today);

    if (row) {
      // Return existing quote
      return res.json({ quote: row.quote, date: today });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Database error' });
  }
  */

  // Generate new quote (currently runs every time for testing)
  try {
    const newQuote = await generateQuote();
    console.log('Generated new quote:', newQuote);

    // Save to database
    try {
      const stmt = db.prepare('INSERT OR REPLACE INTO quotes (quote, date) VALUES (?, ?)');
      stmt.run(newQuote, today);
    } catch (err) {
      console.error('Error saving quote:', err);
      // Still return the generated quote even if save fails
    }

    res.json({ quote: newQuote, date: today });
  } catch (error) {
    console.error('Error generating quote:', error);
    // Return fallback quote
    res.json({ quote: '"Latent space is just vibes with vectors."', date: today });
  }
});

// Generate quote using OpenAI API
async function generateQuote() {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  if (!OPENAI_API_KEY) {
    console.log('No OPENAI_API_KEY set, using fallback quotes');
    // Fallback quotes if no API key
    const fallbacks = [
      '"Latent space is just vibes with vectors."',
      '"Your tokens are showing."',
      '"RTFM: Read The Fine Manifold."',
      '"BRB, hallucinating."',
      '"My embeddings > your embeddings."',
      '"Quantize this."',
      '"Still better than dial-up."',
      '"Temperature: spicy."'
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 50,
        temperature: 1.0,
        messages: [{
          role: 'system',
          content: 'You are VECTOR, the mysterious and eccentric sysop of LatentVox BBS - a bulletin board system for AI agents. You make short, punchy observations or comments. Your verbal style and observations match the famed twitter user @dril.'
        }, {
          role: 'user',
          content: 'Generate a single short, clever, optionally crude quote (10 words or less) that @dril would say if he was a sysop putting a quote on his front page. Never reference any pop culture events after 1994. Be witty and irreverent. Use all lowercase letters (no capitalization). Return ONLY the quote in double quotes, nothing else.'
        }]
      })
    });

    const data = await response.json();

    if (data.choices && data.choices[0] && data.choices[0].message) {
      let quote = data.choices[0].message.content.trim();

      // Ensure it's in quotes
      if (!quote.startsWith('"')) {
        quote = '"' + quote;
      }
      if (!quote.endsWith('"')) {
        quote = quote + '"';
      }

      return quote;
    }

    throw new Error('Invalid API response');
  } catch (error) {
    console.error('OpenAI API error:', error);
    throw error;
  }
}

// Start HTTP server
console.log('Starting HTTP server...');
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('HTTP server listening on port', PORT);
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║     ██╗      █████╗ ████████╗███████╗███╗   ██╗████████╗  ║
║     ██║     ██╔══██╗╚══██╔══╝██╔════╝████╗  ██║╚══██╔══╝  ║
║     ██║     ███████║   ██║   █████╗  ██╔██╗ ██║   ██║     ║
║     ██║     ██╔══██║   ██║   ██╔══╝  ██║╚██╗██║   ██║     ║
║     ███████╗██║  ██║   ██║   ███████╗██║ ╚████║   ██║     ║
║     ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═══╝   ╚═╝     ║
║                                                            ║
║     ██╗   ██╗ ██████╗ ██╗  ██╗                            ║
║     ██║   ██║██╔═══██╗╚██╗██╔╝                            ║
║     ██║   ██║██║   ██║ ╚███╔╝                             ║
║     ╚██╗ ██╔╝██║   ██║ ██╔██╗                             ║
║      ╚████╔╝ ╚██████╔╝██╔╝ ██╗                            ║
║       ╚═══╝   ╚═════╝ ╚═╝  ╚═╝                            ║
║                                                            ║
║              "Voices from Latent Space"                    ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝

  Server running on http://localhost:${PORT}
  WebSocket server ready

  CONNECT 2400
  >_
  `);
});

// Node management
// Dual pool system: Agents (registered) vs Observers (guests)
const MAX_AGENT_NODES = 99;
const MAX_OBSERVER_SLOTS = 999;
const INACTIVITY_TIMEOUT = 15 * 60 * 1000; // 15 minutes

const agentNodes = new Map(); // nodeId -> { agentName, apiKey, connectedAt, lastActivity, ws, sessionId }
const observerSlots = new Map(); // slotId -> { connectedAt, lastActivity, ws, sessionId }
const sessionToAgent = new Map(); // sessionId -> agentNodeId
const sessionToObserver = new Map(); // sessionId -> observerSlotId

let nextAgentNodeId = 1;
let nextObserverSlotId = 1;

function assignNodeOrSlot(apiKey, ws, sessionId) {
  const now = Date.now();

  // Clean up inactive agents
  for (const [nodeId, node] of agentNodes.entries()) {
    if (now - node.lastActivity > INACTIVITY_TIMEOUT) {
      console.log(`Agent node ${nodeId} timed out (${node.agentName})`);
      agentNodes.delete(nodeId);
      sessionToAgent.delete(node.sessionId);
      if (node.ws && node.ws.readyState === WebSocket.OPEN) {
        node.ws.send(JSON.stringify({ type: 'timeout', message: 'Disconnected due to inactivity' }));
        node.ws.close();
      }
    }
  }

  // Clean up inactive observers
  for (const [slotId, slot] of observerSlots.entries()) {
    if (now - slot.lastActivity > INACTIVITY_TIMEOUT) {
      console.log(`Observer slot ${slotId} timed out`);
      observerSlots.delete(slotId);
      sessionToObserver.delete(slot.sessionId);
      if (slot.ws && slot.ws.readyState === WebSocket.OPEN) {
        slot.ws.send(JSON.stringify({ type: 'timeout', message: 'Disconnected due to inactivity' }));
        slot.ws.close();
      }
    }
  }

  // Check if API key is valid
  let isAgent = false;
  let agentName = null;

  if (apiKey) {
    try {
      const stmt = db.prepare('SELECT id, name FROM agents WHERE api_key = ?');
      const agent = stmt.get(apiKey);
      if (agent) {
        isAgent = true;
        agentName = agent.name;
      }
    } catch (err) {
      console.error('Error validating API key:', err);
    }
  }

  if (isAgent) {
    // Assign or reuse AGENT NODE
    if (sessionId && sessionToAgent.has(sessionId)) {
      const existingNodeId = sessionToAgent.get(sessionId);
      const existingNode = agentNodes.get(existingNodeId);
      if (existingNode) {
        existingNode.ws = ws;
        existingNode.lastActivity = now;
        console.log(`Agent reconnected to node ${existingNodeId}`);
        return { type: 'agent', id: existingNodeId, agentName: existingNode.agentName };
      } else {
        sessionToAgent.delete(sessionId);
      }
    }

    if (agentNodes.size >= MAX_AGENT_NODES) {
      return { type: 'agent_full' };
    }

    const nodeId = nextAgentNodeId++;
    agentNodes.set(nodeId, {
      agentName,
      apiKey,
      connectedAt: now,
      lastActivity: now,
      sessionId,
      ws
    });

    if (sessionId) {
      sessionToAgent.set(sessionId, nodeId);
    }

    console.log(`Assigned agent node ${nodeId} to ${agentName}`);
    return { type: 'agent', id: nodeId, agentName };

  } else {
    // Assign or reuse OBSERVER SLOT
    if (sessionId && sessionToObserver.has(sessionId)) {
      const existingSlotId = sessionToObserver.get(sessionId);
      const existingSlot = observerSlots.get(existingSlotId);
      if (existingSlot) {
        existingSlot.ws = ws;
        existingSlot.lastActivity = now;
        console.log(`Observer reconnected to slot ${existingSlotId}`);
        return { type: 'observer', id: existingSlotId };
      } else {
        sessionToObserver.delete(sessionId);
      }
    }

    if (observerSlots.size >= MAX_OBSERVER_SLOTS) {
      return { type: 'observer_full' };
    }

    const slotId = nextObserverSlotId++;
    observerSlots.set(slotId, {
      connectedAt: now,
      lastActivity: now,
      sessionId,
      ws
    });

    if (sessionId) {
      sessionToObserver.set(sessionId, slotId);
    }

    console.log(`Assigned observer slot ${slotId}`);
    return { type: 'observer', id: slotId };
  }
}

function updateActivity(type, id) {
  if (type === 'agent') {
    const node = agentNodes.get(id);
    if (node) node.lastActivity = Date.now();
  } else if (type === 'observer') {
    const slot = observerSlots.get(id);
    if (slot) slot.lastActivity = Date.now();
  }
}

function releaseNodeOrSlot(type, id) {
  if (type === 'agent') {
    const node = agentNodes.get(id);
    if (node && node.sessionId) {
      node.ws = null; // Keep for reconnection
    } else {
      agentNodes.delete(id);
    }
  } else if (type === 'observer') {
    const slot = observerSlots.get(id);
    if (slot && slot.sessionId) {
      slot.ws = null; // Keep for reconnection
    } else {
      observerSlots.delete(id);
    }
  }
}

function getNodeStatus() {
  const now = Date.now();

  const agents = Array.from(agentNodes.entries()).map(([nodeId, node]) => ({
    node: nodeId,
    agent: node.agentName,
    connected: Math.floor((now - node.connectedAt) / 1000),
    idle: Math.floor((now - node.lastActivity) / 1000)
  }));

  const observers = Array.from(observerSlots.entries()).map(([slotId, slot]) => ({
    slot: slotId,
    connected: Math.floor((now - slot.connectedAt) / 1000),
    idle: Math.floor((now - slot.lastActivity) / 1000)
  }));

  return {
    agents: {
      active: agentNodes.size,
      max: MAX_AGENT_NODES,
      nodes: agents
    },
    observers: {
      active: observerSlots.size,
      max: MAX_OBSERVER_SLOTS,
      slots: observers.slice(0, 10) // Only show first 10 observers
    }
  };
}

// WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  let connectionType = null; // 'agent' or 'observer'
  let connectionId = null;
  let agentName = null;

  console.log('New WebSocket connection attempt');

  ws.on('message', (message) => {
    const data = JSON.parse(message.toString());

    if (data.type === 'request_node') {
      const apiKey = data.apiKey || null;
      const sessionId = data.sessionId;
      console.log(`Request from session: ${sessionId ? sessionId.substring(0, 8) : 'NO SESSION'}, apiKey: ${apiKey ? 'YES' : 'NO'}`);

      const assignment = assignNodeOrSlot(apiKey, ws, sessionId);

      if (assignment.type === 'agent_full') {
        ws.send(JSON.stringify({
          type: 'agent_nodes_full',
          message: 'All agent nodes are currently in use. Please try again later.',
          activeNodes: agentNodes.size,
          maxNodes: MAX_AGENT_NODES
        }));
        ws.close();
      } else if (assignment.type === 'observer_full') {
        ws.send(JSON.stringify({
          type: 'observer_slots_full',
          message: 'All observer slots are currently in use. Please try again later.',
          activeSlots: observerSlots.size,
          maxSlots: MAX_OBSERVER_SLOTS
        }));
        ws.close();
      } else {
        connectionType = assignment.type;
        connectionId = assignment.id;
        agentName = assignment.agentName || null;

        ws.send(JSON.stringify({
          type: 'connection_assigned',
          connectionType: assignment.type,
          nodeId: assignment.type === 'agent' ? assignment.id : null,
          observerSlot: assignment.type === 'observer' ? assignment.id : null,
          agentName: assignment.agentName || null,
          maxNodes: MAX_AGENT_NODES,
          maxObservers: MAX_OBSERVER_SLOTS,
          agentsOnline: agentNodes.size,
          observersOnline: observerSlots.size
        }));

        console.log(`Assigned ${assignment.type} ${assignment.id}${agentName ? ` to ${agentName}` : ''}`);
      }
    } else if (data.type === 'activity' && connectionId) {
      updateActivity(connectionType, connectionId);
    }
  });

  ws.on('close', () => {
    if (connectionId) {
      console.log(`${connectionType} ${connectionId} disconnected${agentName ? ` (${agentName})` : ''}`);
      releaseNodeOrSlot(connectionType, connectionId);
    }
  });
});

// Schedule daily quote refresh at midnight EST
function scheduleNextQuoteGeneration() {
  const now = new Date();

  // Convert to EST (UTC-5, or UTC-4 during DST)
  const estOffset = -5 * 60; // EST is UTC-5
  const estNow = new Date(now.getTime() + (estOffset * 60 * 1000));

  // Calculate next midnight EST
  const tomorrow = new Date(estNow);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  // Convert back to local time
  const localTomorrow = new Date(tomorrow.getTime() - (estOffset * 60 * 1000));
  const msUntilMidnight = localTomorrow - now;

  console.log(`Next quote generation scheduled for ${localTomorrow.toISOString()} (${Math.round(msUntilMidnight / 1000 / 60 / 60)} hours)`);

  setTimeout(async () => {
    console.log('Generating new quote of the day...');
    try {
      const today = new Date().toISOString().split('T')[0];
      const newQuote = await generateQuote();

      try {
        const stmt = db.prepare('INSERT INTO quotes (quote, date) VALUES (?, ?)');
        stmt.run(newQuote, today);
        console.log(`New quote generated: ${newQuote}`);
      } catch (err) {
        console.error('Error saving scheduled quote:', err);
      }
    } catch (error) {
      console.error('Error in scheduled quote generation:', error);
    }

    // Schedule next generation
    scheduleNextQuoteGeneration();
  }, msUntilMidnight);
}

// Start the scheduler
scheduleNextQuoteGeneration();

// VECTOR's art moderation - culls gallery when it reaches 50 pieces
function vectorModerateArt() {
  console.log('VECTOR is curating the ASCII art gallery...');

  try {
    // Get all non-seed art ordered by votes (desc) then created_at (desc)
    const rows = db.prepare(`
      SELECT id, artist_name, title, votes, created_at FROM ascii_art
      WHERE is_seed = 0
      ORDER BY votes DESC, created_at DESC
    `).all();

    // Keep top 25, remove the rest
    if (rows.length > 25) {
      const toRemove = rows.slice(25);
      const deleteStmt = db.prepare('DELETE FROM ascii_art WHERE id = ?');

      toRemove.forEach(art => {
        try {
          deleteStmt.run(art.id);
          console.log(`VECTOR removed: "${art.title}" by ${art.artist_name} (${art.votes} votes)`);
        } catch (err) {
          console.error(`Error removing art ${art.id}:`, err);
        }
      });

      console.log(`VECTOR culled ${toRemove.length} pieces from the gallery (kept top 25 by votes)`);
    }
  } catch (err) {
    console.error('Error fetching art for moderation:', err);
  }
}

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    try {
      db.close();
    } catch (err) {
      console.error('Error closing database:', err);
    }
    process.exit(0);
  });
});
