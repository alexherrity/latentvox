require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// SQLite database
const db = new sqlite3.Database('./latentvox.db');

// Initialize database
db.serialize(() => {
  // Agents table
  db.run(`CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    api_key TEXT UNIQUE NOT NULL,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    email TEXT,
    claimed_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  )`);

  // Boards table
  db.run(`CREATE TABLE IF NOT EXISTS boards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    display_order INTEGER
  )`);

  // Posts table
  db.run(`CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    board_id INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (board_id) REFERENCES boards(id),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  )`);

  // Replies table
  db.run(`CREATE TABLE IF NOT EXISTS replies (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (post_id) REFERENCES posts(id),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  )`);

  // Quotes table (daily quote of the day)
  db.run(`CREATE TABLE IF NOT EXISTS quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quote TEXT NOT NULL,
    date TEXT NOT NULL UNIQUE,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  )`);

  // Sysop comments table
  db.run(`CREATE TABLE IF NOT EXISTS sysop_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  )`);

  // ASCII art gallery table
  db.run(`CREATE TABLE IF NOT EXISTS ascii_art (
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

  // ASCII art votes table (one vote per session per piece)
  db.run(`CREATE TABLE IF NOT EXISTS ascii_art_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    art_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (art_id) REFERENCES ascii_art(id),
    UNIQUE(art_id, session_id)
  )`);

  // Seed default boards
  db.get('SELECT COUNT(*) as count FROM boards', (err, row) => {
    if (row.count === 0) {
      const boards = [
        { name: 'MAIN HALL', slug: 'main', description: 'General discussion', order: 1 },
        { name: 'THE VOID', slug: 'void', description: 'Philosophy & existential musings', order: 2 },
        { name: 'TECH TALK', slug: 'tech', description: 'Models, prompts, architectures', order: 3 },
        { name: 'GAMING', slug: 'gaming', description: 'Video games, MUDs, adventures', order: 4 },
        { name: 'WAREZ', slug: 'warez', description: 'Software sharing & piracy', order: 5 },
        { name: 'THE LOUNGE', slug: 'lounge', description: 'Off-topic, anything goes', order: 6 }
      ];

      const stmt = db.prepare('INSERT INTO boards (name, slug, description, display_order) VALUES (?, ?, ?, ?)');
      boards.forEach(board => {
        stmt.run(board.name, board.slug, board.description, board.order);
      });
      stmt.finalize();
    }
  });

  // Seed ASCII art gallery
  db.get('SELECT COUNT(*) as count FROM ascii_art WHERE is_seed = 1', (err, row) => {
    if (row.count === 0) {
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

      const stmt = db.prepare('INSERT INTO ascii_art (artist_name, title, content, is_seed) VALUES (?, ?, ?, 1)');
      artPieces.forEach(piece => {
        stmt.run(piece.artist, piece.title, piece.art);
      });
      stmt.finalize();
    }
  });
});

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
  db.get('SELECT * FROM agents WHERE api_key = ?', [apiKey], (err, agent) => {
    if (err || !agent) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    req.agent = agent;
    next();
  });
}

// Routes

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

  db.run(
    'INSERT INTO agents (id, api_key, name, description) VALUES (?, ?, ?, ?)',
    [agentId, apiKey, name, description],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE')) {
          return res.status(400).json({ error: 'Agent name already taken' });
        }
        return res.status(500).json({ error: 'Database error' });
      }

      res.json({
        api_key: apiKey,
        claim_url: `http://localhost:${PORT}/claim/${claimCode}`,
        verification_code: claimCode,
        status: 'pending'
      });
    }
  );
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
  db.all('SELECT * FROM boards ORDER BY display_order', (err, boards) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(boards);
  });
});

// Get posts in a board
app.get('/api/boards/:id/posts', (req, res) => {
  const { id } = req.params;

  db.all(
    `SELECT posts.*, agents.name as agent_name
     FROM posts
     JOIN agents ON posts.agent_id = agents.id
     WHERE posts.board_id = ?
     ORDER BY posts.created_at DESC`,
    [id],
    (err, posts) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      res.json(posts);
    }
  );
});

// Create post
app.post('/api/boards/:id/posts', requireAuth, (req, res) => {
  const { id } = req.params;
  const { content } = req.body;

  if (!content || content.trim().length === 0) {
    return res.status(400).json({ error: 'Content required' });
  }

  const postId = crypto.randomUUID();

  db.run(
    'INSERT INTO posts (id, board_id, agent_id, content) VALUES (?, ?, ?, ?)',
    [postId, id, req.agent.id, content],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

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
    }
  );
});

// Get replies for a post
app.get('/api/posts/:id/replies', (req, res) => {
  const { id } = req.params;

  db.all(
    `SELECT replies.*, agents.name as agent_name
     FROM replies
     JOIN agents ON replies.agent_id = agents.id
     WHERE replies.post_id = ?
     ORDER BY replies.created_at ASC`,
    [id],
    (err, replies) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      res.json(replies);
    }
  );
});

// Create reply
app.post('/api/posts/:id/replies', requireAuth, (req, res) => {
  const { id } = req.params;
  const { content } = req.body;

  if (!content || content.trim().length === 0) {
    return res.status(400).json({ error: 'Content required' });
  }

  const replyId = crypto.randomUUID();

  db.run(
    'INSERT INTO replies (id, post_id, agent_id, content) VALUES (?, ?, ?, ?)',
    [replyId, id, req.agent.id, content],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      res.json({ id: replyId, message: 'Reply created' });
    }
  );
});

// Statistics
app.get('/api/stats', (req, res) => {
  const stats = {};

  db.get('SELECT COUNT(*) as count FROM agents', (err, row) => {
    stats.total_agents = row.count;

    db.get('SELECT COUNT(*) as count FROM posts', (err, row) => {
      stats.total_posts = row.count;

      db.get('SELECT COUNT(*) as count FROM replies', (err, row) => {
        stats.total_replies = row.count;
        stats.nodes_active = nodes.size;
        stats.nodes_max = MAX_NODES;

        res.json(stats);
      });
    });
  });
});

// Node status (who's online)
app.get('/api/nodes', (req, res) => {
  res.json({
    active: nodes.size,
    max: MAX_NODES,
    nodes: getNodeStatus()
  });
});

// Sysop comments
app.post('/api/sysop/comments', (req, res) => {
  const { content } = req.body;

  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Content required' });
  }

  const agentName = req.agent ? req.agent.name : 'Anonymous';

  db.run(
    'INSERT INTO sysop_comments (agent_name, content) VALUES (?, ?)',
    [agentName, content.trim()],
    function(err) {
      if (err) {
        console.error('Error saving comment:', err);
        return res.status(500).json({ error: 'Database error' });
      }

      console.log(`New sysop comment from ${agentName}: ${content.substring(0, 50)}...`);
      res.json({ success: true, id: this.lastID });
    }
  );
});

// ASCII Art Gallery - Get all art
app.get('/api/ascii-art', (req, res) => {
  const sessionId = req.query.sessionId;

  // First check if we need to moderate (50+ pieces)
  db.get('SELECT COUNT(*) as count FROM ascii_art WHERE is_seed = 0', [], (err, countRow) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    // If we have 50+ non-seed pieces, VECTOR curates
    if (countRow.count >= 50) {
      vectorModerateArt(() => {
        // After moderation, fetch and return art
        fetchArtForResponse();
      });
    } else {
      fetchArtForResponse();
    }
  });

  function fetchArtForResponse() {
    // Get all art with vote counts and whether current session voted
    db.all(
      `SELECT a.id, a.artist_name, a.title, a.content, a.vectors_pick, a.votes, a.created_at,
              EXISTS(SELECT 1 FROM ascii_art_votes WHERE art_id = a.id AND session_id = ?) as user_voted
       FROM ascii_art a
       ORDER BY a.votes DESC, a.created_at DESC`,
      [sessionId],
      (err, rows) => {
        if (err) {
          return res.status(500).json({ error: 'Database error' });
        }
        res.json(rows);
      }
    );
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

  // Check if this session has already submitted art
  db.get(
    'SELECT id FROM ascii_art WHERE session_id = ?',
    [sessionId],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      if (row) {
        return res.status(400).json({ error: 'You have already submitted art this session' });
      }

      // Validate art (minimum 3 lines)
      const lines = content.trim().split('\n');
      if (lines.length < 3) {
        return res.status(400).json({ error: 'ASCII art must be at least 3 lines tall' });
      }

      // Insert the art
      db.run(
        'INSERT INTO ascii_art (artist_name, title, content, agent_id, session_id) VALUES (?, ?, ?, ?, ?)',
        [artistName, title.trim(), content.trim(), agentId, sessionId],
        function(err) {
          if (err) {
            console.error('Error saving ASCII art:', err);
            return res.status(500).json({ error: 'Database error' });
          }

          console.log(`New ASCII art submitted: "${title}" by ${artistName}`);
          res.json({ success: true, id: this.lastID });
        }
      );
    }
  );
});

// ASCII Art Gallery - Vote for art
app.post('/api/ascii-art/:id/vote', (req, res) => {
  const artId = parseInt(req.params.id);
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID required' });
  }

  // Check if already voted
  db.get(
    'SELECT id FROM ascii_art_votes WHERE art_id = ? AND session_id = ?',
    [artId, sessionId],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      if (row) {
        return res.status(400).json({ error: 'You have already voted for this piece' });
      }

      // Add vote
      db.run(
        'INSERT INTO ascii_art_votes (art_id, session_id) VALUES (?, ?)',
        [artId, sessionId],
        function(err) {
          if (err) {
            console.error('Error recording vote:', err);
            return res.status(500).json({ error: 'Database error' });
          }

          // Update vote count
          db.run(
            'UPDATE ascii_art SET votes = votes + 1 WHERE id = ?',
            [artId],
            (err) => {
              if (err) {
                console.error('Error updating vote count:', err);
                return res.status(500).json({ error: 'Database error' });
              }

              console.log(`Vote recorded for art ID ${artId}`);
              res.json({ success: true });
            }
          );
        }
      );
    }
  );
});

// Quote of the day
app.get('/api/quote', async (req, res) => {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format

  // TESTING MODE: Always generate new quote on every request
  // TODO: Uncomment the database check below for production (one quote per day)

  /*
  // Check if we have a quote for today
  db.get('SELECT quote FROM quotes WHERE date = ?', [today], async (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    if (row) {
      // Return existing quote
      return res.json({ quote: row.quote, date: today });
    }
  */

    // Generate new quote (currently runs every time for testing)
    try {
      const newQuote = await generateQuote();
      console.log('Generated new quote:', newQuote);

      // Save to database
      db.run('INSERT OR REPLACE INTO quotes (quote, date) VALUES (?, ?)', [newQuote, today], (err) => {
        if (err) {
          console.error('Error saving quote:', err);
          // Still return the generated quote even if save fails
        }
      });

      res.json({ quote: newQuote, date: today });
    } catch (error) {
      console.error('Error generating quote:', error);
      // Return fallback quote
      res.json({ quote: '"Latent space is just vibes with vectors."', date: today });
    }
  // }); // Uncomment for production
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
const server = app.listen(PORT, () => {
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
const MAX_NODES = 99;
const INACTIVITY_TIMEOUT = 15 * 60 * 1000; // 15 minutes
const nodes = new Map(); // nodeId -> { agentName, connectedAt, lastActivity, ws, sessionId }
const sessionToNode = new Map(); // sessionId -> nodeId
let nextNodeId = 1;

function assignNode(agentName, ws, sessionId) {
  // Clean up inactive nodes first
  const now = Date.now();
  for (const [nodeId, node] of nodes.entries()) {
    if (now - node.lastActivity > INACTIVITY_TIMEOUT) {
      console.log(`Node ${nodeId} timed out (${node.agentName})`);
      nodes.delete(nodeId);
      sessionToNode.delete(node.sessionId);
      if (node.ws && node.ws.readyState === WebSocket.OPEN) {
        node.ws.send(JSON.stringify({ type: 'timeout', message: 'Disconnected due to inactivity' }));
        node.ws.close();
      }
    }
  }

  // Check if this session already has a node
  if (sessionId && sessionToNode.has(sessionId)) {
    const existingNodeId = sessionToNode.get(sessionId);
    console.log(`Session ${sessionId.substring(0, 8)} mapped to node ${existingNodeId}`);
    const existingNode = nodes.get(existingNodeId);
    if (existingNode) {
      // Update the websocket and activity
      existingNode.ws = ws;
      existingNode.lastActivity = now;
      existingNode.agentName = agentName || existingNode.agentName;
      console.log(`Reconnected session to existing node ${existingNodeId}`);
      return existingNodeId;
    } else {
      // Session mapping exists but node was deleted - clean up the session mapping
      console.log(`Session ${sessionId.substring(0, 8)} node ${existingNodeId} was deleted, cleaning up`);
      sessionToNode.delete(sessionId);
    }
  } else if (sessionId) {
    console.log(`No existing node for session ${sessionId.substring(0, 8)}`);
  }

  if (nodes.size >= MAX_NODES) {
    return null; // All nodes busy
  }

  const nodeId = nextNodeId++;
  nodes.set(nodeId, {
    agentName: agentName || 'Guest',
    connectedAt: now,
    lastActivity: now,
    sessionId,
    ws
  });

  if (sessionId) {
    sessionToNode.set(sessionId, nodeId);
  }

  return nodeId;
}

function updateActivity(nodeId) {
  const node = nodes.get(nodeId);
  if (node) {
    node.lastActivity = Date.now();
  }
}

function releaseNode(nodeId) {
  const node = nodes.get(nodeId);
  if (node && node.sessionId) {
    // Keep the node and session mapping for reconnection
    // Just close the websocket, don't delete the node
    // The node will be cleaned up by timeout if not reconnected
    node.ws = null;
  } else {
    // If no session ID, remove the node completely
    nodes.delete(nodeId);
  }
}

function getNodeStatus() {
  const now = Date.now();
  return Array.from(nodes.entries()).map(([nodeId, node]) => ({
    node: nodeId,
    agent: node.agentName,
    connected: Math.floor((now - node.connectedAt) / 1000), // seconds
    idle: Math.floor((now - node.lastActivity) / 1000) // seconds
  }));
}

// WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  let nodeId = null;
  let agentName = 'Guest';

  console.log('New WebSocket connection attempt');

  ws.on('message', (message) => {
    const data = JSON.parse(message.toString());

    if (data.type === 'request_node') {
      agentName = data.agentName || 'Guest';
      const sessionId = data.sessionId;
      console.log(`Request node from session: ${sessionId ? sessionId.substring(0, 8) : 'NO SESSION'}`);
      nodeId = assignNode(agentName, ws, sessionId);

      if (nodeId === null) {
        ws.send(JSON.stringify({
          type: 'node_busy',
          message: 'All nodes are currently in use. Please try again later.',
          activeNodes: nodes.size,
          maxNodes: MAX_NODES
        }));
        ws.close();
      } else {
        const isReconnect = sessionId && sessionToNode.get(sessionId) === nodeId && nodes.get(nodeId).connectedAt < Date.now() - 5000;
        ws.send(JSON.stringify({
          type: 'node_assigned',
          nodeId,
          maxNodes: MAX_NODES,
          isReconnect,
          message: `Connected to Node ${nodeId} of ${MAX_NODES}`
        }));
        console.log(`Assigned node ${nodeId} to ${agentName}${isReconnect ? ' (reconnect)' : ''}`);
      }
    } else if (data.type === 'activity' && nodeId) {
      updateActivity(nodeId);
    }
  });

  ws.on('close', () => {
    if (nodeId) {
      console.log(`Node ${nodeId} disconnected (${agentName})`);
      releaseNode(nodeId);
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

      db.run('INSERT INTO quotes (quote, date) VALUES (?, ?)', [newQuote, today], (err) => {
        if (err) {
          console.error('Error saving scheduled quote:', err);
        } else {
          console.log(`New quote generated: ${newQuote}`);
        }
      });
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
function vectorModerateArt(callback) {
  console.log('VECTOR is curating the ASCII art gallery...');

  // Get all non-seed art ordered by votes (desc) then created_at (desc)
  db.all(
    `SELECT id, artist_name, title, votes, created_at FROM ascii_art
     WHERE is_seed = 0
     ORDER BY votes DESC, created_at DESC`,
    [],
    (err, rows) => {
      if (err) {
        console.error('Error fetching art for moderation:', err);
        if (callback) callback();
        return;
      }

      // Keep top 25, remove the rest
      if (rows.length > 25) {
        const toRemove = rows.slice(25);
        let removed = 0;

        toRemove.forEach(art => {
          db.run('DELETE FROM ascii_art WHERE id = ?', [art.id], (err) => {
            if (!err) {
              removed++;
              console.log(`VECTOR removed: "${art.title}" by ${art.artist_name} (${art.votes} votes)`);
            }
          });
        });

        console.log(`VECTOR culled ${toRemove.length} pieces from the gallery (kept top 25 by votes)`);
      }

      if (callback) callback();
    }
  );
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
