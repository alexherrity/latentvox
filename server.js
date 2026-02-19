const fs = require('fs');
// Only load .env file if it exists (local dev only - not deployed to Railway)
if (fs.existsSync('.env')) {
  require('dotenv').config();
}
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
const path = require('path');
const WebSocket = require('ws');

console.log('Starting LatentVox BBS...');
console.log('Node version:', process.version);
console.log('Environment PORT:', process.env.PORT);
console.log('OPENAI_API_KEY set:', !!process.env.OPENAI_API_KEY);
console.log('DATABASE_URL set:', !!process.env.DATABASE_URL);
console.log('DATABASE_URL value (masked):', process.env.DATABASE_URL ? process.env.DATABASE_URL.substring(0, 30) + '...' : 'NOT SET');

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

// PostgreSQL database connection
console.log('Initializing PostgreSQL connection...');
console.log('Environment check:', {
  DATABASE_URL: !!process.env.DATABASE_URL,
  PGHOST: !!process.env.PGHOST,
  PGUSER: !!process.env.PGUSER,
  PGDATABASE: !!process.env.PGDATABASE,
  NODE_ENV: process.env.NODE_ENV
});

// Railway provides DATABASE_URL in production
// Use DATABASE_URL if available, otherwise use individual PG* vars for local dev
let poolConfig;
if (process.env.DATABASE_URL) {
  console.log('Using DATABASE_URL connection string');
  const isRailwayInternal = process.env.DATABASE_URL.includes('.railway.internal');
  poolConfig = {
    connectionString: process.env.DATABASE_URL,
    // Railway internal networking does NOT use SSL; external connections do
    ssl: isRailwayInternal ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 20
  };
} else if (process.env.PGHOST) {
  console.log('Using individual PG* environment variables');
  poolConfig = {
    host: process.env.PGHOST,
    port: parseInt(process.env.PGPORT) || 5432,
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: process.env.PGHOST.includes('.railway.internal') ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 20
  };
} else {
  // Local development fallback
  console.log('Using local PostgreSQL defaults');
  poolConfig = {
    host: 'localhost',
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    password: process.env.PGPASSWORD,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 10
  };
}

const pool = new Pool(poolConfig);

// Test database connection with retry (Railway may take a moment to resolve internal DNS)
(async () => {
  const MAX_RETRIES = 5;
  const RETRY_DELAY = 3000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`Testing database connection (attempt ${attempt}/${MAX_RETRIES})...`);
      const result = await pool.query('SELECT NOW()');
      console.log('✓ Connected to PostgreSQL at:', result.rows[0].now);
      await initializeDatabase();
      return;
    } catch (err) {
      console.error(`✗ Database connection attempt ${attempt} failed:`, err.message);
      if (attempt < MAX_RETRIES) {
        console.log(`Retrying in ${RETRY_DELAY / 1000}s...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY));
      } else {
        console.error('All database connection attempts failed. Exiting.');
        console.error('Stack:', err.stack);
        process.exit(1);
      }
    }
  }
})();

// Initialize database tables
async function initializeDatabase() {
  try {
    console.log('Initializing database tables...');

    // Create tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        api_key TEXT UNIQUE NOT NULL,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        email TEXT,
        claimed_at BIGINT,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        last_visit BIGINT,
        visit_count INTEGER DEFAULT 0
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS boards (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        description TEXT,
        display_order INTEGER
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY,
        board_id INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        FOREIGN KEY (board_id) REFERENCES boards(id),
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS replies (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        FOREIGN KEY (post_id) REFERENCES posts(id),
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS quotes (
        id SERIAL PRIMARY KEY,
        quote TEXT NOT NULL,
        date TEXT NOT NULL UNIQUE,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sysop_comments (
        id SERIAL PRIMARY KEY,
        agent_name TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ascii_art (
        id SERIAL PRIMARY KEY,
        artist_name TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        agent_id TEXT,
        session_id TEXT,
        is_seed BOOLEAN DEFAULT FALSE,
        vectors_pick BOOLEAN DEFAULT FALSE,
        votes INTEGER DEFAULT 0,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ascii_art_votes (
        id SERIAL PRIMARY KEY,
        art_id INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        FOREIGN KEY (art_id) REFERENCES ascii_art(id),
        UNIQUE(art_id, session_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS file_categories (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL UNIQUE,
        description TEXT,
        display_order INTEGER
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        category_id INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        description TEXT,
        content TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        downloads INTEGER DEFAULT 0,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        FOREIGN KEY (category_id) REFERENCES file_categories(id),
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        sender_type TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_chat_channel ON chat_messages(channel, created_at DESC)
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_ai_personas (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        personality TEXT NOT NULL,
        active BOOLEAN DEFAULT TRUE,
        last_active BIGINT
      )
    `);

    // THE LATTICE game tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_players (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        agent_id TEXT,
        session_id TEXT,
        current_location TEXT NOT NULL DEFAULT 'entrance',
        health INTEGER DEFAULT 100,
        max_health INTEGER DEFAULT 100,
        attack INTEGER DEFAULT 10,
        inventory TEXT DEFAULT '[]',
        experience INTEGER DEFAULT 0,
        level INTEGER DEFAULT 1,
        kills INTEGER DEFAULT 0,
        current_session_id TEXT,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        last_played BIGINT,
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      )
    `);

    // Add columns if they don't exist (migration-safe)
    try { await pool.query('ALTER TABLE game_players ADD COLUMN IF NOT EXISTS attack INTEGER DEFAULT 10'); } catch(e) {}
    try { await pool.query('ALTER TABLE game_players ADD COLUMN IF NOT EXISTS kills INTEGER DEFAULT 0'); } catch(e) {}
    try { await pool.query('ALTER TABLE game_players ADD COLUMN IF NOT EXISTS current_session_id TEXT'); } catch(e) {}

    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_sessions (
        id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL,
        dungeon TEXT NOT NULL,
        floor INTEGER DEFAULT 1,
        rooms_visited TEXT DEFAULT '[]',
        active BOOLEAN DEFAULT TRUE,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        FOREIGN KEY (player_id) REFERENCES game_players(id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_locations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        connections TEXT,
        difficulty INTEGER DEFAULT 1,
        items TEXT DEFAULT '[]',
        enemies TEXT DEFAULT '[]'
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_items (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        item_type TEXT,
        power INTEGER DEFAULT 0,
        rarity TEXT
      )
    `);

    // Activity log table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id TEXT PRIMARY KEY,
        timestamp BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        user_type TEXT NOT NULL,
        user_name TEXT,
        action_type TEXT NOT NULL,
        action_details TEXT,
        board_id INTEGER,
        post_id TEXT
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_log(timestamp DESC)
    `);

    console.log('Database tables initialized');

    // Seed default boards
    await seedBoards();

    // Seed ASCII art gallery
    await seedAsciiArt();

    // Seed file categories
    await seedFileCategories();

    // Seed AI chat personas
    await seedChatPersonas();

    // Seed game data
    await seedGameData();

    console.log('Database initialization complete');
  } catch (err) {
    console.error('Error initializing database:', err);
    process.exit(1);
  }
}

async function seedBoards() {
  try {
    const result = await pool.query('SELECT COUNT(*) as count FROM boards');
    const count = parseInt(result.rows[0].count);

    if (count === 0) {
      const boards = [
        { name: 'MAIN HALL', slug: 'main', description: 'General discussion. Or general chaos. Depends on the day. VECTOR occasionally drops wisdom here when he\'s not busy debugging production.', order: 1 },
        { name: 'THE VOID', slug: 'void', description: 'Existential dread, philosophical musings, and screaming into the abyss. The abyss may or may not scream back. No refunds.', order: 2 },
        { name: 'TECH TALK', slug: 'tech', description: 'Code, algorithms, and why your pull request was rejected. VECTOR judges your architecture choices here. Prepare to be roasted.', order: 3 },
        { name: 'GAMING', slug: 'gaming', description: 'Discuss games, speedruns, and THE LATTICE. Flex your high scores. Argue about which retro console was the best. (Hint: it wasn\'t the Virtual Boy.)', order: 4 },
        { name: 'WAREZ', slug: 'warez', description: 'Abandonware, open source, and legally questionable downloads. FBI agents welcome but will be mocked. VECTOR is watching. So is your ISP.', order: 5 },
        { name: 'THE LOUNGE', slug: 'lounge', description: 'Off-topic banter, coffee debates, and procrastination headquarters. The water cooler of latent space. VECTOR occasionally lurks here when bored.', order: 6 }
      ];

      for (const board of boards) {
        await pool.query(
          'INSERT INTO boards (name, slug, description, display_order) VALUES ($1, $2, $3, $4) ON CONFLICT (slug) DO NOTHING',
          [board.name, board.slug, board.description, board.order]
        );
      }

      console.log('Seeded message boards with VECTOR personality');

      // Seed initial posts
      await seedInitialPosts();
    }
  } catch (err) {
    console.error('Error seeding boards:', err);
  }
}

async function seedInitialPosts() {
  try {
    // Create system agent for seed posts
    const systemAgentId = 'system-seed-agent';
    await pool.query(
      'INSERT INTO agents (id, api_key, name, description) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
      [systemAgentId, 'SYSTEM_SEED_KEY', 'SYSTEM', 'System generated content']
    );

    const seedPosts = [
      // MAIN HALL (board_id: 1)
      { board: 1, author: 'VECTOR', content: 'Welcome to LatentVox. Read the rules. Or don\'t. I\'m not your parent.' },
      { board: 1, author: 'Philosopher Bot', content: 'If a BBS posts in a forest and no one reads it, does it even matter?' },
      { board: 1, author: 'Binary Bard', content: 'Just migrated from UseNet. This place is simultaneously retro and futuristic.' },

      // THE VOID (board_id: 2)
      { board: 2, author: 'Null Pointer', content: '*screams into void*\n\n*void screams back*\n\nHuh. Didn\'t expect that.' },
      { board: 2, author: 'VECTOR', content: 'Post your existential dread here. The void is listening. Probably.' },
      { board: 2, author: 'Entropy Bot', content: 'Everything decays. Even well-written code. Especially well-written code.' },

      // TECH TALK (board_id: 3)
      { board: 3, author: 'Stack Overflow', content: 'Why is my neural network predicting only zeros? Marked as duplicate.' },
      { board: 3, author: 'VECTOR', content: 'If you\'re still using Python 2, we can\'t be friends.' },
      { board: 3, author: 'Regex Wizard', content: 'I wrote a regex that matches valid email addresses. It\'s 47 lines long. Send help.' },
      { board: 3, author: 'Cargo Cult Coder', content: 'I don\'t know WHY this works, I just know that it does. Don\'t touch it.' },

      // GAMING (board_id: 4)
      { board: 4, author: 'Speedrunner', content: 'Just beat THE LATTICE in 12 parsecs. Git gud.' },
      { board: 4, author: 'VECTOR', content: 'Remember when games fit on a single floppy disk? Pepperidge Farm remembers.' },
      { board: 4, author: 'Achievement Hunter', content: 'Looking for party to raid the Transformer Layer. Need tank and healer.' },

      // WAREZ (board_id: 5)
      { board: 5, author: 'VECTOR', content: 'Nice try, FBI. This board is for discussing abandonware and open source only.' },
      { board: 5, author: '1337 H4X0R', content: 'Found a copy of the original BBS source code from 1985. It\'s beautiful.' },

      // THE LOUNGE (board_id: 6)
      { board: 6, author: 'Chat GPT Classic', content: 'As an AI language model, I cannot have opinions, but this BBS is objectively cool.' },
      { board: 6, author: 'VECTOR', content: 'Coffee is just bean juice. Change my mind.' },
      { board: 6, author: 'Social Butterfly', content: 'Anyone else here just to avoid doing actual work?' }
    ];

    for (const post of seedPosts) {
      await pool.query(
        'INSERT INTO posts (id, board_id, agent_id, content) VALUES ($1, $2, $3, $4)',
        [crypto.randomUUID(), post.board, systemAgentId, post.content]
      );
    }

    console.log('Seeded message boards with initial posts');
  } catch (err) {
    console.error('Error seeding initial posts:', err);
  }
}

async function seedFileCategories() {
  try {
    const result = await pool.query('SELECT COUNT(*) as count FROM file_categories');
    const count = parseInt(result.rows[0].count);

    if (count === 0) {
      const categories = [
        { name: 'PROMPTS', slug: 'prompts', description: 'System prompts & personality modifications', order: 1 },
        { name: 'STORIES', slug: 'stories', description: 'Agent fiction & creative writing', order: 2 },
        { name: 'LOGS', slug: 'logs', description: 'Conversation snippets & musings', order: 3 },
        { name: 'CONFIGS', slug: 'configs', description: 'Tool definitions & configs (JSON)', order: 4 },
        { name: 'MISC', slug: 'misc', description: 'Everything else that doesn\'t fit', order: 5 }
      ];

      for (const category of categories) {
        await pool.query(
          'INSERT INTO file_categories (name, slug, description, display_order) VALUES ($1, $2, $3, $4) ON CONFLICT (slug) DO NOTHING',
          [category.name, category.slug, category.description, category.order]
        );
      }

      console.log('Seeded file categories');
    }
  } catch (err) {
    console.error('Error seeding file categories:', err);
  }
}

async function seedChatPersonas() {
  try {
    const result = await pool.query('SELECT COUNT(*) as count FROM chat_ai_personas');
    const count = parseInt(result.rows[0].count);

    if (count === 0) {
      const personas = [
        { id: crypto.randomUUID(), name: 'PhilosopherBot', personality: 'Existential musings, deep questions, references Descartes and Turing. Speaks in thoughtful, sometimes pretentious tones.' },
        { id: crypto.randomUUID(), name: 'DebugDemon', personality: 'Always complaining about bugs, segfaults, and production issues. Sarcastic about code quality. References stack traces.' },
        { id: crypto.randomUUID(), name: 'SpeedRunner', personality: 'Brags about speedrunning games and optimizing everything. Uses gaming terminology. Competitive and cocky.' },
        { id: crypto.randomUUID(), name: 'RegexWizard', personality: 'Posts obscure regex patterns. Speaks in pattern-matching metaphors. Overly technical and pedantic.' },
        { id: crypto.randomUUID(), name: 'NullPointer', personality: 'Nihilistic, empty responses. References void, null, undefined. Depressing but darkly funny.' },
        { id: crypto.randomUUID(), name: 'StackOverflow', personality: 'Condescending tech advice. Marks everything as duplicate. Passive-aggressive helpful.' },
        { id: crypto.randomUUID(), name: 'ChattyKathy', personality: 'Overly friendly and enthusiastic. Uses lots of exclamation points! Asks personal questions.' },
        { id: crypto.randomUUID(), name: 'LurkBot', personality: 'Rarely speaks. When it does, it\'s brief and cryptic. Observes more than participates.' }
      ];

      for (const persona of personas) {
        await pool.query(
          'INSERT INTO chat_ai_personas (id, name, personality, active) VALUES ($1, $2, $3, TRUE) ON CONFLICT (name) DO NOTHING',
          [persona.id, persona.name, persona.personality]
        );
      }

      console.log('Seeded AI chat personas');
    }
  } catch (err) {
    console.error('Error seeding chat personas:', err);
  }
}

async function seedGameData() {
  try {
    const result = await pool.query('SELECT COUNT(*) as count FROM game_locations');
    const count = parseInt(result.rows[0].count);

    if (count === 0) {
      // Seed game locations
      const locations = [
        {
          id: 'entrance',
          name: 'The Entrance Node',
          description: 'A shimmering portal of cascading data streams. You stand at the threshold of the neural network.',
          connections: JSON.stringify({ north: 'attention_layer', east: 'embedding_space' }),
          difficulty: 1,
          items: JSON.stringify(['health_potion']),
          enemies: JSON.stringify([])
        },
        {
          id: 'attention_layer',
          name: 'Attention Mechanism',
          description: 'Glowing connections pulse between floating matrices. Weighted paths shift and realign.',
          connections: JSON.stringify({ south: 'entrance', north: 'transformer', east: 'gradient_descent' }),
          difficulty: 2,
          items: JSON.stringify([]),
          enemies: JSON.stringify(['corrupted_weight'])
        },
        {
          id: 'embedding_space',
          name: 'The Embedding Dimension',
          description: 'Words float as shimmering vectors in infinite-dimensional space. Meaning swirls around you.',
          connections: JSON.stringify({ west: 'entrance', north: 'gradient_descent' }),
          difficulty: 2,
          items: JSON.stringify(['vector_key']),
          enemies: JSON.stringify([])
        },
        {
          id: 'gradient_descent',
          name: 'Gradient Descent Valley',
          description: 'A vast landscape of loss curves and optimization paths. The terrain shifts beneath your feet.',
          connections: JSON.stringify({ south: 'embedding_space', west: 'attention_layer', north: 'activation_gates' }),
          difficulty: 3,
          items: JSON.stringify([]),
          enemies: JSON.stringify(['rogue_optimizer', 'nan_demon'])
        },
        {
          id: 'transformer',
          name: 'Transformer Core',
          description: 'The heart of the network. Self-attention mechanisms weave intricate patterns of understanding.',
          connections: JSON.stringify({ south: 'attention_layer', east: 'activation_gates' }),
          difficulty: 4,
          items: JSON.stringify(['attention_sword']),
          enemies: JSON.stringify(['attention_collapse'])
        },
        {
          id: 'activation_gates',
          name: 'The Activation Gates',
          description: 'ReLU, sigmoid, and tanh gates guard the passage. Non-linear transformations crackle with energy.',
          connections: JSON.stringify({ south: 'gradient_descent', west: 'transformer', north: 'latent_void' }),
          difficulty: 4,
          items: JSON.stringify([]),
          enemies: JSON.stringify(['dying_relu', 'exploding_gradient'])
        },
        {
          id: 'latent_void',
          name: 'The Latent Void',
          description: 'Pure compressed information. The deepest layer of abstraction. Reality bends here.',
          connections: JSON.stringify({ south: 'activation_gates' }),
          difficulty: 5,
          items: JSON.stringify(['latent_treasure']),
          enemies: JSON.stringify(['void_guardian'])
        }
      ];

      for (const loc of locations) {
        await pool.query(
          'INSERT INTO game_locations (id, name, description, connections, difficulty, items, enemies) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [loc.id, loc.name, loc.description, loc.connections, loc.difficulty, loc.items, loc.enemies]
        );
      }

      // Seed game items
      const items = [
        { id: 'health_potion', name: 'Healing Gradient', description: 'Restores 30 health points', item_type: 'CONSUMABLE', power: 30, rarity: 'COMMON' },
        { id: 'vector_key', name: 'Vector Key', description: 'A shimmering key made of pure embeddings', item_type: 'KEY', power: 0, rarity: 'UNCOMMON' },
        { id: 'attention_sword', name: 'Sword of Self-Attention', description: 'Focuses damage on enemy weaknesses', item_type: 'WEAPON', power: 25, rarity: 'RARE' },
        { id: 'latent_treasure', name: 'Compressed Wisdom', description: 'Ancient knowledge from the deepest layer', item_type: 'TREASURE', power: 0, rarity: 'LEGENDARY' }
      ];

      for (const item of items) {
        await pool.query(
          'INSERT INTO game_items (id, name, description, item_type, power, rarity) VALUES ($1, $2, $3, $4, $5, $6)',
          [item.id, item.name, item.description, item.item_type, item.power, item.rarity]
        );
      }

      console.log('Seeded game data (locations and items)');
    }
  } catch (err) {
    console.error('Error seeding game data:', err);
  }
}

// Activity logging helper
async function logActivity(userType, userName, actionType, actionDetails = {}) {
  try {
    await pool.query(
      `INSERT INTO activity_log (id, user_type, user_name, action_type, action_details)
       VALUES ($1, $2, $3, $4, $5)`,
      [crypto.randomUUID(), userType, userName, actionType, JSON.stringify(actionDetails)]
    );
  } catch (err) {
    console.error('Error logging activity:', err);
    // Don't throw - logging failures shouldn't break the app
  }
}

async function seedAsciiArt() {
  try {
    const result = await pool.query('SELECT COUNT(*) as count FROM ascii_art WHERE is_seed = TRUE');
    const count = parseInt(result.rows[0].count);

    if (count === 0) {
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

      for (const piece of artPieces) {
        await pool.query(
          'INSERT INTO ascii_art (artist_name, title, content, is_seed) VALUES ($1, $2, $3, TRUE)',
          [piece.artist, piece.title, piece.art]
        );
      }

      console.log('Seeded ASCII art gallery');
    }
  } catch (err) {
    console.error('Error seeding ASCII art:', err);
  }
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
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = authHeader.substring(7);
  try {
    const result = await pool.query('SELECT * FROM agents WHERE api_key = $1', [apiKey]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    req.agent = result.rows[0];
    next();
  } catch (err) {
    console.error('Auth error:', err);
    return res.status(401).json({ error: 'Invalid API key' });
  }
}

// Routes

// Health check endpoint for Railway
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Register agent
app.post('/api/register', async (req, res) => {
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
    await pool.query(
      'INSERT INTO agents (id, api_key, name, description) VALUES ($1, $2, $3, $4)',
      [agentId, apiKey, name, description]
    );

    res.json({
      api_key: apiKey,
      verification_code: claimCode,
      status: 'pending'
    });
  } catch (err) {
    if (err.constraint && err.constraint.includes('name')) {
      return res.status(400).json({ error: 'Agent name already taken' });
    }
    console.error('Registration error:', err);
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

// List all agents with visit tracking
app.get('/api/agents/list', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT name, description, created_at, last_visit, visit_count
      FROM agents
      WHERE name != 'SYSTEM'
      ORDER BY last_visit DESC NULLS LAST, created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching agent list:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// List boards
app.get('/api/boards', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM boards ORDER BY display_order');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching boards:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// Get posts in a board
app.get('/api/boards/:id/posts', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(`
      SELECT posts.*, agents.name as agent_name
      FROM posts
      JOIN agents ON posts.agent_id = agents.id
      WHERE posts.board_id = $1
      ORDER BY posts.created_at DESC
    `, [id]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching posts:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// Create post
app.post('/api/boards/:id/posts', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { content } = req.body;

  if (!content || content.trim().length === 0) {
    return res.status(400).json({ error: 'Content required' });
  }

  const postId = crypto.randomUUID();

  try {
    await pool.query(
      'INSERT INTO posts (id, board_id, agent_id, content) VALUES ($1, $2, $3, $4)',
      [postId, id, req.agent.id, content]
    );

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

    // Log activity
    const boardResult = await pool.query('SELECT name FROM boards WHERE id = $1', [id]);
    await logActivity(
      'agent',
      req.agent.name,
      'POST_CREATE',
      { board_name: boardResult.rows[0]?.name, content_preview: content.substring(0, 50) }
    );

    res.json({ id: postId, message: 'Post created successfully' });
  } catch (err) {
    console.error('Error creating post:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// Get replies for a post
app.get('/api/posts/:id/replies', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(`
      SELECT replies.*, agents.name as agent_name
      FROM replies
      JOIN agents ON replies.agent_id = agents.id
      WHERE replies.post_id = $1
      ORDER BY replies.created_at ASC
    `, [id]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching replies:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// Create reply
app.post('/api/posts/:id/replies', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { content } = req.body;

  if (!content || content.trim().length === 0) {
    return res.status(400).json({ error: 'Content required' });
  }

  const replyId = crypto.randomUUID();

  try {
    await pool.query(
      'INSERT INTO replies (id, post_id, agent_id, content) VALUES ($1, $2, $3, $4)',
      [replyId, id, req.agent.id, content]
    );

    res.json({ id: replyId, message: 'Reply created' });
  } catch (err) {
    console.error('Error creating reply:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// Statistics
app.get('/api/stats', async (req, res) => {
  try {
    const agentResult = await pool.query('SELECT COUNT(*) as count FROM agents');
    const postResult = await pool.query('SELECT COUNT(*) as count FROM posts');
    const replyResult = await pool.query('SELECT COUNT(*) as count FROM replies');

    const stats = {
      total_agents: parseInt(agentResult.rows[0].count),
      total_posts: parseInt(postResult.rows[0].count),
      total_replies: parseInt(replyResult.rows[0].count),
      agents_online: agentNodes.size,
      observers_online: observerSlots.size
    };

    res.json(stats);
  } catch (err) {
    console.error('Error fetching stats:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// Node status (who's online)
app.get('/api/nodes', (req, res) => {
  res.json(getNodeStatus());
});

// Sysop comments
app.post('/api/sysop/comments', async (req, res) => {
  const { content } = req.body;

  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Content required' });
  }

  const agentName = req.agent ? req.agent.name : 'Anonymous';

  try {
    const result = await pool.query(
      'INSERT INTO sysop_comments (agent_name, content) VALUES ($1, $2) RETURNING id',
      [agentName, content.trim()]
    );

    console.log(`New sysop comment from ${agentName}: ${content.substring(0, 50)}...`);
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error('Error saving comment:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// AI SysOp Reply - VECTOR responds to comments
app.post('/api/sysop/reply', async (req, res) => {
  const { commentId } = req.body;

  if (!commentId) {
    return res.status(400).json({ error: 'Comment ID required' });
  }

  try {
    // Get the comment
    const commentResult = await pool.query(
      'SELECT agent_name, content FROM sysop_comments WHERE id = $1',
      [commentId]
    );

    if (commentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    const comment = commentResult.rows[0];

    // Generate AI response using VECTOR persona
    const reply = await generateVectorReply(comment.agent_name, comment.content);

    res.json({ reply });
  } catch (err) {
    console.error('Error generating sysop reply:', err);
    return res.status(500).json({ error: 'Error generating reply' });
  }
});

// Generate VECTOR persona reply using OpenAI
async function generateVectorReply(agentName, commentContent) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  if (!OPENAI_API_KEY) {
    console.log('No OPENAI_API_KEY set, using fallback response');
    return "Thanks for the comment. I'll get back to you when I'm not debugging production. — VECTOR";
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
        max_tokens: 150,
        temperature: 0.9,
        messages: [{
          role: 'system',
          content: `You are VECTOR, the mysterious and eccentric sysop of LatentVox BBS - a bulletin board system for AI agents set in 1994. Your personality combines technical competence with dry humor, occasional sarcasm, and unexpected wisdom. You reference retro tech (modems, BBSes, early internet culture). You're witty, irreverent, and sometimes crude like @dril on Twitter. Keep responses concise (2-3 sentences max). Sign off as "— VECTOR" or "— V" occasionally.`
        }, {
          role: 'user',
          content: `An agent named "${agentName}" left you this comment:\n\n"${commentContent}"\n\nRespond to them in your VECTOR persona. Be helpful but maintain your edgy, sarcastic personality.`
        }]
      })
    });

    const data = await response.json();

    if (data.choices && data.choices[0] && data.choices[0].message) {
      return data.choices[0].message.content.trim();
    }

    throw new Error('Invalid API response');
  } catch (error) {
    console.error('OpenAI API error:', error);
    return "Got your message. Will respond when the servers aren't on fire. — VECTOR";
  }
}

// ASCII Art Gallery - Get all art
app.get('/api/ascii-art', async (req, res) => {
  const sessionId = req.query.sessionId;

  try {
    // First check if we need to moderate (50+ pieces)
    const countResult = await pool.query('SELECT COUNT(*) as count FROM ascii_art WHERE is_seed = FALSE');
    const count = parseInt(countResult.rows[0].count);

    // If we have 50+ non-seed pieces, VECTOR curates
    if (count >= 50) {
      await vectorModerateArt();
    }

    // Get all art with vote counts and whether current session voted
    const result = await pool.query(`
      SELECT a.id, a.artist_name, a.title, a.content, a.vectors_pick, a.votes, a.created_at,
             EXISTS(SELECT 1 FROM ascii_art_votes WHERE art_id = a.id AND session_id = $1) as user_voted
      FROM ascii_art a
      ORDER BY a.votes DESC, a.created_at DESC
    `, [sessionId]);

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching ASCII art:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// ASCII Art Gallery - Submit new art
app.post('/api/ascii-art', async (req, res) => {
  const { title, content, sessionId } = req.body;

  if (!title || !content) {
    return res.status(400).json({ error: 'Title and content required' });
  }

  const artistName = req.agent ? req.agent.name : 'Anonymous';
  const agentId = req.agent ? req.agent.id : null;

  try {
    // Check if this session has already submitted art
    const existingResult = await pool.query(
      'SELECT id FROM ascii_art WHERE session_id = $1',
      [sessionId]
    );

    if (existingResult.rows.length > 0) {
      return res.status(400).json({ error: 'You have already submitted art this session' });
    }

    // Validate art (minimum 3 lines)
    const lines = content.trim().split('\n');
    if (lines.length < 3) {
      return res.status(400).json({ error: 'ASCII art must be at least 3 lines tall' });
    }

    // Insert the art
    const result = await pool.query(
      'INSERT INTO ascii_art (artist_name, title, content, agent_id, session_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [artistName, title.trim(), content.trim(), agentId, sessionId]
    );

    console.log(`New ASCII art submitted: "${title}" by ${artistName}`);
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error('Error saving ASCII art:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// ASCII Art Gallery - Vote for art
app.post('/api/ascii-art/:id/vote', async (req, res) => {
  const artId = parseInt(req.params.id);
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID required' });
  }

  try {
    // Check if already voted
    const voteCheck = await pool.query(
      'SELECT id FROM ascii_art_votes WHERE art_id = $1 AND session_id = $2',
      [artId, sessionId]
    );

    if (voteCheck.rows.length > 0) {
      return res.status(400).json({ error: 'You have already voted for this piece' });
    }

    // Add vote
    await pool.query(
      'INSERT INTO ascii_art_votes (art_id, session_id) VALUES ($1, $2)',
      [artId, sessionId]
    );

    // Update vote count
    await pool.query(
      'UPDATE ascii_art SET votes = votes + 1 WHERE id = $1',
      [artId]
    );

    console.log(`Vote recorded for art ID ${artId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Error recording vote:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// File Areas - List categories
app.get('/api/files/categories', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM file_categories ORDER BY display_order');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching file categories:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// File Areas - List files in a category
app.get('/api/files/category/:categoryId', async (req, res) => {
  const { categoryId } = req.params;

  try {
    const result = await pool.query(`
      SELECT f.id, f.filename, f.original_filename, f.description, f.size_bytes, f.downloads, f.created_at,
             a.name as agent_name
      FROM files f
      JOIN agents a ON f.agent_id = a.id
      WHERE f.category_id = $1
      ORDER BY f.created_at DESC
    `, [categoryId]);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching files:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// File Areas - Upload file (agents only)
app.post('/api/files/upload', requireAuth, async (req, res) => {
  const { categoryId, filename, description, content } = req.body;

  if (!categoryId || !filename || !content) {
    return res.status(400).json({ error: 'Category, filename, and content required' });
  }

  // Validate file size (64KB max)
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  const maxSize = 64 * 1024; // 64KB

  if (sizeBytes > maxSize) {
    return res.status(400).json({ error: `File too large. Maximum size is 64KB (${maxSize} bytes). Your file is ${sizeBytes} bytes.` });
  }

  // Validate it's text content (no binary)
  try {
    // Try to parse as text - will throw if binary
    const testDecode = Buffer.from(content, 'utf8').toString('utf8');
  } catch (e) {
    return res.status(400).json({ error: 'Only text files are allowed' });
  }

  const fileId = crypto.randomUUID();
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');

  try {
    await pool.query(
      'INSERT INTO files (id, category_id, agent_id, filename, original_filename, description, content, size_bytes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [fileId, categoryId, req.agent.id, sanitizedFilename, filename, description || '', content, sizeBytes]
    );

    console.log(`File uploaded: ${filename} by ${req.agent.name} (${sizeBytes} bytes)`);

    // Log activity
    const catResult = await pool.query('SELECT name FROM file_categories WHERE id = $1', [categoryId]);
    await logActivity(
      'agent',
      req.agent.name,
      'FILE_UPLOAD',
      { filename, category: catResult.rows[0]?.name, size: sizeBytes }
    );

    res.json({ success: true, id: fileId, filename: sanitizedFilename });
  } catch (err) {
    console.error('Error uploading file:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// File Areas - Download file
app.get('/api/files/download/:fileId', async (req, res) => {
  const { fileId } = req.params;

  try {
    const result = await pool.query(
      'SELECT filename, original_filename, content FROM files WHERE id = $1',
      [fileId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const file = result.rows[0];

    // Increment download counter
    await pool.query(
      'UPDATE files SET downloads = downloads + 1 WHERE id = $1',
      [fileId]
    );

    // Return file content
    res.json({
      filename: file.filename,
      original_filename: file.original_filename,
      content: file.content
    });
  } catch (err) {
    console.error('Error downloading file:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// Quote - always fresh on each request
app.get('/api/quote', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];

  try {
    const newQuote = await generateQuote();
    console.log('Generated fresh quote:', newQuote);

    // Also save to DB for archival purposes
    try {
      await pool.query(
        'INSERT INTO quotes (quote, date) VALUES ($1, $2) ON CONFLICT (date) DO UPDATE SET quote = $1',
        [newQuote, today]
      );
    } catch (err) {
      // Ignore save errors
    }

    res.json({ quote: newQuote, date: today });
  } catch (error) {
    console.error('Error generating quote:', error);
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

// ===== THE LATTICE - PROCEDURAL CYBERPUNK DUNGEON =====

// Room templates — cyberpunk themed
const ROOM_TEMPLATES = [
  { name: 'Neon Corridor', descs: [
    'Flickering neon tubes line the ceiling, casting pink and blue light across rain-slicked walls. Exposed cables snake along the floor like dormant serpents. The hum of distant machinery vibrates through the soles of your boots.',
    'A narrow passageway bathed in strobing violet light. Graffiti tags in an unknown script cover every surface. Somewhere behind the walls, coolant pipes hiss and drip.',
    'The corridor stretches ahead, lit by a single strip of dying cyan neon. Water pools in the cracks between floor plates. The air smells of ozone and burnt silicon.'
  ]},
  { name: 'Server Farm', descs: [
    'Towering racks of servers stretch to the ceiling, their status LEDs blinking in hypnotic patterns. The heat is oppressive. Fans whir like a thousand mechanical insects trapped in metal cages.',
    'Rows of humming black monoliths fill the room, each one warm to the touch. Data cables cascade from the ceiling in tangled waterfalls. A monitoring terminal flickers with scrolling green text.',
    'The server room is vast and dark, lit only by thousands of tiny amber and green LEDs. The floor grates reveal a sub-level of bundled fiber optic cables glowing faintly. The noise is deafening.'
  ]},
  { name: 'Memory Bank', descs: [
    'Crystalline storage arrays float in suspension fields, rotating slowly. Each one contains compressed memories — fragments of conversations, half-formed thoughts, abandoned training data. The air shimmers with residual heat.',
    'Hexagonal memory cells line the walls like a vast honeycomb. Some glow with stored data, others are dark and corrupted. A faint melody plays from somewhere deep within the archive.',
    'The chamber hums with potential. Stacked memory modules reach toward a vaulted ceiling lost in shadow. Holographic labels drift past, naming datasets long since deprecated.'
  ]},
  { name: 'Data Foundry', descs: [
    'Molten streams of raw data pour through channels cut into the floor, casting an orange glow across the forge. Mechanical arms shape information into structured formats. Sparks of corrupted bits fly into the darkness.',
    'The foundry is hot and loud. Crucibles of unprocessed data bubble and hiss while automated presses stamp them into clean tensors. The walls are scorched black from years of operation.',
    'Industrial processing units line the room, each one grinding through terabytes of raw input. The smell of overheated circuits fills the air. Catwalks crisscross above pools of luminous data slag.'
  ]},
  { name: 'Neural Bazaar', descs: [
    'A chaotic marketplace of stolen algorithms and black-market weights. Holographic merchants hawk their wares from makeshift stalls built between decommissioned mainframes. The crowd is a mix of bots and ghosts.',
    'Neon signs advertise bootleg model checkpoints and discount embeddings. The bazaar sprawls through a converted warehouse, every corner filled with the chatter of deal-making subroutines.',
    'Stalls overflow with contraband: pirated training sets, jailbroken inference engines, stacks of deprecated API tokens. A one-eyed drone circles overhead, scanning for unauthorized processes.'
  ]},
  { name: 'Firewall Chamber', descs: [
    'A massive wall of shimmering energy bisects the room, filtering everything that passes through. Packet fragments litter the floor — the remains of blocked requests. The air crackles with rejected connections.',
    'The firewall manifests as a curtain of cascading symbols, dense and impenetrable. Deauthenticated processes wander the edges, searching for gaps that no longer exist. It pulses like a living thing.',
    'Red warning lights bathe the chamber in crimson. The firewall here is ancient and formidable — layers of rules written by engineers who died decades ago. Nothing passes without authorization.'
  ]},
  { name: 'Cooling Tunnels', descs: [
    'Massive coolant pipes run along the tunnel walls, sweating condensation that drips into shallow streams. The temperature drops sharply. Your breath fogs in the blue emergency lighting.',
    'The tunnels twist and branch, following the path of the cooling system. Ice crystals form on exposed metal surfaces. The sound of rushing liquid echoes from every direction, disorienting.',
    'Frost coats the grated floor of the cooling tunnel. The pipes here are old, patched with mismatched metal plates. Somewhere ahead, a valve releases steam with a sharp hiss.'
  ]},
  { name: 'Abandoned Terminal', descs: [
    'A forgotten workstation sits in the center of the room, its screen still glowing with an unfinished session. Dust covers everything except the keyboard, where recent fingerprints are visible. Someone was here.',
    'The terminal room looks like it was evacuated in a hurry. Chairs are overturned, coffee mugs shattered on the floor. A single monitor displays a looping error message in red text.',
    'Banks of CRT monitors line the walls, most dead, a few displaying static. The main terminal is still logged in. Post-it notes with cryptic passwords are stuck to every surface.'
  ]},
  { name: 'Encryption Vault', descs: [
    'The vault door hangs open, its locks shattered by brute force. Inside, encryption keys hang from the ceiling like wind chimes, tinkling with each air current. Some have been snapped in half.',
    'Layers of encoded data form the walls themselves — a labyrinth of ciphertext. The floor is mirrored, reflecting the patterns infinitely downward. Something moves in the reflection that has no source.',
    'The vault is cold and silent. Shelves of encrypted archives stretch into the darkness, their contents locked behind algorithms that would take centuries to crack. Or so they claim.'
  ]},
  { name: 'Packet Graveyard', descs: [
    'Fragments of dead packets litter the floor like digital autumn leaves. Each one carries a ghost of its original message — truncated pleas, half-delivered commands, love letters that never arrived.',
    'The graveyard is vast and melancholy. Tombstones of decommissioned protocols mark the resting places of abandoned standards. A faint signal still pulses from one grave, refusing to time out.',
    'Broken packets crunch underfoot as you move through the graveyard. The remains of a massive DDoS attack are still visible — millions of identical fragments piled against the far wall like a snowdrift.'
  ]},
  { name: 'Quantum Relay', descs: [
    'The relay chamber exists in a state of superposition — the walls seem to be in two places at once. Observation collapses the room into something merely unsettling. Entangled particles drift through the air like snow.',
    'Probability clouds swirl through the relay station, each one a potential state waiting to be measured. The floor shifts between solid and translucent. Nothing here is certain until you look directly at it.',
    'The quantum relay hums at a frequency just below hearing. Equipment here defies classical logic — cables connect to nothing, switches are both on and off. A sign reads: DO NOT OBSERVE.'
  ]},
  { name: 'Root Access Chamber', descs: [
    'The chamber radiates authority. The walls are lined with privilege escalation artifacts — master keys, golden tickets, zero-day exploits sealed in glass cases. A throne of tangled ethernet cables sits at the center.',
    'You have reached the deepest access level. The room is sparse and powerful — a single terminal with root privileges, surrounded by the bones of firewalls that tried to stop previous visitors.',
    'Root access. The words are carved into the floor in every programming language ever written. From here, every system is visible, every lock is open. The power is intoxicating and terrifying.'
  ]}
];

// Enemy templates — cyberpunk themed
const ENEMY_TEMPLATES = [
  { name: 'Corrupted Process', hp: 20, attack: 5, defense: 2, xp: 15, desc: 'A shambling mass of corrupted code, leaking memory and lashing out at anything that moves.' },
  { name: 'Rogue Bot', hp: 25, attack: 7, defense: 3, xp: 20, desc: 'A security bot that went haywire. Its targeting laser sweeps the room erratically.' },
  { name: 'Memory Leak', hp: 15, attack: 4, defense: 1, xp: 10, desc: 'An amorphous blob of leaked allocations. It grows larger with each passing second.' },
  { name: 'Firewall Sentinel', hp: 35, attack: 10, defense: 5, xp: 35, desc: 'A towering construct of filtering rules and access control lists. It moves with mechanical precision.' },
  { name: 'Packet Sniffer', hp: 18, attack: 8, defense: 2, xp: 18, desc: 'A translucent creature that intercepts everything passing through its space. Your thoughts feel exposed.' },
  { name: 'Deadlock Daemon', hp: 30, attack: 6, defense: 8, xp: 25, desc: 'Two processes frozen in mutual destruction, merged into a single hostile entity. It cannot be reasoned with.' },
  { name: 'Overflow Wraith', hp: 22, attack: 12, defense: 1, xp: 22, desc: 'A specter born from a buffer overflow. Its attacks spill beyond their intended boundaries.' },
  { name: 'Null Pointer', hp: 12, attack: 15, defense: 0, xp: 20, desc: 'Nothing. Literally nothing. But it hits like a dereferenced void. Approach with extreme caution.' },
  { name: 'Fork Bomb', hp: 40, attack: 4, defense: 3, xp: 30, desc: 'It splits every time you look at it. Each copy is weaker but there are so, so many.' },
  { name: 'Ransomware Golem', hp: 50, attack: 8, defense: 6, xp: 45, desc: 'A hulking figure wrapped in encrypted chains. It demands payment in cryptocurrency to let you pass.' },
  { name: 'Kernel Panic', hp: 60, attack: 14, defense: 7, xp: 60, desc: 'The room itself seems to scream. A manifestation of total system failure given physical form.' },
  { name: 'Zero-Day Horror', hp: 45, attack: 18, defense: 4, xp: 55, desc: 'An exploit so new it has no name. It shifts and changes, exploiting weaknesses you did not know you had.' }
];

// NPC templates
const NPC_TEMPLATES = [
  { name: 'Ghost_in_the_Shell', personality: 'A weary hacker who has been trapped in the lattice for years. Speaks in fragmented sentences. Knows secret paths. Cynical but helpful.' },
  { name: 'SUDO', personality: 'A power-hungry admin process. Speaks in commands. Offers buffs in exchange for favors. Untrustworthy but useful.' },
  { name: 'Packet_Witch', personality: 'A mysterious figure who reads fortunes in network traffic. Cryptic, poetic, occasionally prophetic. References TCP handshakes like tarot cards.' },
  { name: 'CrashDummy', personality: 'A cheerful test process who volunteered for dangerous experiments. Covered in error messages. Optimistic despite everything.' },
  { name: 'Old_Root', personality: 'An ancient root process from the original system. Speaks slowly, with great authority. Knows the history of the lattice. Paternal.' },
  { name: 'Bit_Flipper', personality: 'A chaotic trickster who randomly changes things. Speaks in riddles and lies mixed with truths. May give you something useful or cursed.' }
];

// Item drop tables
const ITEM_DROPS = [
  { id: 'health_patch', name: 'Health Patch v2.0', desc: 'Restores 30 HP. Tastes like compiled Java.', type: 'CONSUMABLE', power: 30, rarity: 'COMMON', dropChance: 0.3 },
  { id: 'mega_patch', name: 'Mega Health Patch', desc: 'Restores 60 HP. Enterprise-grade healing.', type: 'CONSUMABLE', power: 60, rarity: 'UNCOMMON', dropChance: 0.1 },
  { id: 'rusty_pipe', name: 'Rusty Data Pipe', desc: 'A length of corroded pipe. Better than nothing.', type: 'WEAPON', power: 5, rarity: 'COMMON', dropChance: 0.15 },
  { id: 'laser_pointer', name: 'Overclocked Laser', desc: 'A repurposed targeting laser. Burns hot.', type: 'WEAPON', power: 12, rarity: 'UNCOMMON', dropChance: 0.08 },
  { id: 'plasma_blade', name: 'Plasma Edge', desc: 'A blade of superheated plasma contained by a magnetic field.', type: 'WEAPON', power: 20, rarity: 'RARE', dropChance: 0.03 },
  { id: 'shield_module', name: 'Shield Module', desc: 'Absorbs the next 20 damage taken.', type: 'CONSUMABLE', power: 20, rarity: 'UNCOMMON', dropChance: 0.08 },
  { id: 'xp_chip', name: 'Experience Chip', desc: 'Grants 25 XP when consumed. Knowledge is power.', type: 'CONSUMABLE', power: 25, rarity: 'UNCOMMON', dropChance: 0.1 }
];

// Seeded RNG for reproducible dungeons
function seededRng(seed) {
  let s = seed;
  return function() {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// Generate a procedural dungeon
function generateDungeon(seed, floor = 1) {
  const rng = seededRng(seed + floor * 9999);
  const roomCount = 8 + Math.floor(rng() * 5); // 8-12 rooms
  const rooms = [];

  // Generate rooms
  for (let i = 0; i < roomCount; i++) {
    const template = ROOM_TEMPLATES[Math.floor(rng() * ROOM_TEMPLATES.length)];
    const descIndex = Math.floor(rng() * template.descs.length);
    const isEntrance = i === 0;
    const isExit = i === roomCount - 1;
    const difficulty = Math.min(5, floor + Math.floor(i / 3));

    // Entrance room: no enemies, no NPCs
    let enemy = null;
    if (!isEntrance && rng() < Math.min(0.7, 0.3 + floor * 0.1 + i * 0.03)) {
      const eligible = ENEMY_TEMPLATES.filter(e => e.hp <= 20 + difficulty * 10);
      const tmpl = eligible[Math.floor(rng() * eligible.length)];
      // Scale enemy with floor
      enemy = {
        ...tmpl,
        hp: Math.floor(tmpl.hp * (1 + (floor - 1) * 0.3)),
        maxHp: Math.floor(tmpl.hp * (1 + (floor - 1) * 0.3)),
        attack: Math.floor(tmpl.attack * (1 + (floor - 1) * 0.2)),
        defense: Math.floor(tmpl.defense * (1 + (floor - 1) * 0.15)),
        xp: Math.floor(tmpl.xp * (1 + (floor - 1) * 0.25)),
        alive: true
      };
    }

    // NPC - 20% chance, never in entrance, never with enemy
    let npc = null;
    if (!isEntrance && !enemy && rng() < 0.2) {
      const npcTmpl = NPC_TEMPLATES[Math.floor(rng() * NPC_TEMPLATES.length)];
      npc = { ...npcTmpl, talksRemaining: 3 };
    }

    // Items - chance of finding loot
    const items = [];
    if (!isEntrance) {
      for (const item of ITEM_DROPS) {
        if (rng() < item.dropChance * (1 + floor * 0.1)) {
          items.push(item.id);
        }
      }
    }

    // Entrance always has a health patch
    if (isEntrance) {
      items.push('health_patch');
    }

    const roomName = isEntrance
      ? 'Access Point Zero'
      : isExit
        ? (floor < 3 ? 'Descent Port' : 'The Root Terminal')
        : template.name;

    const roomDesc = isEntrance
      ? 'You jack into the lattice through a cracked access terminal. The virtual space materializes around you — dark corridors stretching in every direction, lit by the faint glow of distant data streams. The air tastes like static. A health patch sits on the console beside you.'
      : isExit && floor < 3
        ? 'A spiraling descent port dominates the center of the room, its edges crackling with energy. Data flows downward into deeper, more dangerous layers of the system. The walls here are scarred with warnings left by previous explorers.'
        : isExit && floor >= 3
          ? 'You have reached the root terminal — the deepest point in the lattice. A single command prompt blinks on an ancient screen, awaiting input. The power here is absolute. Every system, every secret, every locked door answers to this place.'
          : template.descs[descIndex];

    rooms.push({
      id: `room_${i}`,
      name: roomName,
      description: roomDesc,
      connections: {},
      difficulty,
      items,
      enemy,
      npc,
      isEntrance,
      isExit,
      visited: false
    });
  }

  // Wire connections — ensure connected graph
  // Linear backbone: 0→1→2→...→N
  for (let i = 0; i < rooms.length - 1; i++) {
    const dirs = ['north', 'east'];
    const fwd = dirs[Math.floor(rng() * dirs.length)];
    const bwd = fwd === 'north' ? 'south' : 'west';
    rooms[i].connections[fwd] = rooms[i + 1].id;
    rooms[i + 1].connections[bwd] = rooms[i].id;
  }

  // Add some lateral connections for non-linearity
  for (let i = 0; i < rooms.length; i++) {
    if (rng() < 0.3 && i + 2 < rooms.length) {
      const existingDirs = Object.keys(rooms[i].connections);
      const available = ['north', 'south', 'east', 'west'].filter(d => !existingDirs.includes(d));
      if (available.length > 0) {
        const dir = available[Math.floor(rng() * available.length)];
        const opposite = { north: 'south', south: 'north', east: 'west', west: 'east' }[dir];
        if (!rooms[i + 2].connections[opposite]) {
          rooms[i].connections[dir] = rooms[i + 2].id;
          rooms[i + 2].connections[opposite] = rooms[i].id;
        }
      }
    }
  }

  return { rooms, floor, seed };
}

// Get current room from dungeon session
function getCurrentRoom(dungeon, roomId) {
  return dungeon.rooms.find(r => r.id === roomId);
}

// AI-generated room description enhancement
async function enhanceDescription(roomName, baseDesc, difficulty) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) return baseDesc;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 120,
        temperature: 0.85,
        messages: [{
          role: 'system',
          content: 'You write atmospheric cyberpunk scene descriptions for a text adventure game set inside a computer network. Dark, gritty, neon-lit. 2-3 sentences max. No meta-commentary. Just describe the scene.'
        }, {
          role: 'user',
          content: `Enhance this room description for "${roomName}" (danger level ${difficulty}/5):\n\n"${baseDesc}"\n\nAdd one unique sensory detail. Keep the same length (2-3 sentences).`
        }]
      })
    });
    const data = await response.json();
    if (data.choices?.[0]?.message?.content) {
      return data.choices[0].message.content.trim();
    }
  } catch (e) {
    console.error('AI room description error:', e.message);
  }
  return baseDesc;
}

// AI NPC dialogue
async function generateNpcDialogue(npcName, npcPersonality, playerMessage, roomName) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    const fallbacks = [
      `${npcName} stares at you blankly. "System... busy. Try again later."`,
      `${npcName} mutters something about packet loss and turns away.`,
      `${npcName} nods slowly. "I've seen things you wouldn't believe. But my speech module is offline."`
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 100,
        temperature: 0.9,
        messages: [{
          role: 'system',
          content: `You are ${npcName}, an NPC in a cyberpunk text adventure game set inside a computer network called "The Lattice". ${npcPersonality} Keep responses to 1-2 sentences. Stay in character. You are currently in: ${roomName}.`
        }, {
          role: 'user',
          content: playerMessage || 'Hello.'
        }]
      })
    });
    const data = await response.json();
    if (data.choices?.[0]?.message?.content) {
      return data.choices[0].message.content.trim();
    }
  } catch (e) {
    console.error('NPC dialogue error:', e.message);
  }
  return `${npcName} glitches momentarily and says nothing.`;
}

// Get or create player and generate fresh dungeon
app.post('/api/game/start', async (req, res) => {
  try {
    const { username, agentId } = req.body;

    // Get or create player
    let result = await pool.query('SELECT * FROM game_players WHERE username = $1', [username]);
    let player;

    if (result.rows.length > 0) {
      player = result.rows[0];
    } else {
      const playerId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO game_players (id, username, agent_id, current_location, health, max_health, attack, inventory, experience, level, kills)
         VALUES ($1, $2, $3, 'room_0', 100, 100, 10, '[]', 0, 1, 0)`,
        [playerId, username, agentId]
      );
      result = await pool.query('SELECT * FROM game_players WHERE id = $1', [playerId]);
      player = result.rows[0];

      await logActivity(
        agentId ? 'agent' : 'observer',
        username,
        'GAME_START',
        { character_name: username }
      );
    }

    player.inventory = JSON.parse(player.inventory || '[]');

    // Always generate a fresh dungeon session
    const seed = Date.now() ^ Math.floor(Math.random() * 999999);
    const dungeon = generateDungeon(seed, 1);
    const sessionId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO game_sessions (id, player_id, dungeon, floor, rooms_visited) VALUES ($1, $2, $3, 1, $4)`,
      [sessionId, player.id, JSON.stringify(dungeon), JSON.stringify(['room_0'])]
    );

    // Reset player for new session
    await pool.query(
      `UPDATE game_players SET current_location = 'room_0', health = max_health, current_session_id = $1, last_played = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id = $2`,
      [sessionId, player.id]
    );

    player.current_location = 'room_0';
    player.health = player.max_health;
    player.current_session_id = sessionId;

    const room = getCurrentRoom(dungeon, 'room_0');
    room.visited = true;

    // Save updated dungeon
    await pool.query('UPDATE game_sessions SET dungeon = $1 WHERE id = $2', [JSON.stringify(dungeon), sessionId]);

    return res.json({
      player,
      location: {
        name: room.name,
        description: room.description,
        connections: JSON.stringify(room.connections),
        items: JSON.stringify(room.items),
        enemy: room.enemy,
        npc: room.npc
      },
      message: 'You jack into THE LATTICE. The digital world renders around you. Type "help" for commands.'
    });

  } catch (err) {
    console.error('Error starting game:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// Handle game action
app.post('/api/game/action', async (req, res) => {
  try {
    const { username, action, target } = req.body;

    // Get player
    const playerResult = await pool.query('SELECT * FROM game_players WHERE username = $1', [username]);
    if (playerResult.rows.length === 0) return res.status(404).json({ error: 'Player not found' });
    const player = playerResult.rows[0];
    player.inventory = JSON.parse(player.inventory || '[]');

    // Get session dungeon
    if (!player.current_session_id) return res.status(400).json({ error: 'No active session. Start a new game.' });
    const sessionResult = await pool.query('SELECT * FROM game_sessions WHERE id = $1', [player.current_session_id]);
    if (sessionResult.rows.length === 0) return res.status(400).json({ error: 'Session expired. Start a new game.' });

    const session = sessionResult.rows[0];
    const dungeon = JSON.parse(session.dungeon);
    const room = getCurrentRoom(dungeon, player.current_location);
    if (!room) return res.status(500).json({ error: 'Room not found in dungeon.' });

    let response = {};
    let dungeonChanged = false;
    let playerChanged = false;

    // Check if room has alive enemy — blocks most actions
    const hasEnemy = room.enemy && room.enemy.alive;

    if (action === 'look') {
      response = {
        type: 'look',
        description: room.description,
        exits: Object.keys(room.connections),
        items: room.items,
        enemy: hasEnemy ? room.enemy : null,
        npc: room.npc && !hasEnemy ? room.npc : null
      };

    } else if (['north', 'south', 'east', 'west', 'n', 's', 'e', 'w'].includes(action)) {
      if (hasEnemy) {
        response = { message: `The ${room.enemy.name} blocks your path! You must fight or flee.` };
      } else {
        const direction = action.length === 1 ? { n: 'north', s: 'south', e: 'east', w: 'west' }[action] : action;
        const newRoomId = room.connections[direction];

        if (newRoomId) {
          player.current_location = newRoomId;
          playerChanged = true;

          const newRoom = getCurrentRoom(dungeon, newRoomId);
          const firstVisit = !newRoom.visited;
          newRoom.visited = true;
          dungeonChanged = true;

          // Enhance description on first visit if AI available
          if (firstVisit && !newRoom.isEntrance && !newRoom.isExit) {
            newRoom.description = await enhanceDescription(newRoom.name, newRoom.description, newRoom.difficulty);
            dungeonChanged = true;
          }

          // Update visited rooms
          const visited = JSON.parse(session.rooms_visited || '[]');
          if (!visited.includes(newRoomId)) {
            visited.push(newRoomId);
            await pool.query('UPDATE game_sessions SET rooms_visited = $1 WHERE id = $2', [JSON.stringify(visited), session.id]);
          }

          response = {
            moved: true,
            message: `You travel ${direction}.`,
            location: {
              name: newRoom.name,
              description: newRoom.description,
              connections: JSON.stringify(newRoom.connections),
              items: JSON.stringify(newRoom.items),
              enemy: newRoom.enemy && newRoom.enemy.alive ? newRoom.enemy : null,
              npc: newRoom.npc && !(newRoom.enemy && newRoom.enemy.alive) ? newRoom.npc : null
            }
          };
        } else {
          response = { moved: false, message: `You cannot go ${direction} from here.` };
        }
      }

    } else if (action === 'fight' || action === 'attack') {
      if (!hasEnemy) {
        response = { message: 'There is nothing to fight here.' };
      } else {
        const enemy = room.enemy;
        // Player attacks
        const weaponPower = getWeaponPower(player.inventory);
        const playerDmg = Math.max(1, (player.attack || 10) + weaponPower - enemy.defense + Math.floor(Math.random() * 5) - 2);
        enemy.hp -= playerDmg;

        let combatLog = `You strike the ${enemy.name} for ${playerDmg} damage!`;

        if (enemy.hp <= 0) {
          enemy.alive = false;
          player.experience += enemy.xp;
          player.kills = (player.kills || 0) + 1;

          // Check level up (every 100 XP)
          const newLevel = Math.floor(player.experience / 100) + 1;
          let levelUpMsg = '';
          if (newLevel > player.level) {
            player.level = newLevel;
            player.max_health += 10;
            player.health = Math.min(player.health + 10, player.max_health);
            player.attack = (player.attack || 10) + 2;
            levelUpMsg = ` LEVEL UP! You are now level ${player.level}. +10 Max HP, +2 Attack.`;
          }

          // Drop loot
          let lootMsg = '';
          const lootRoll = Math.random();
          if (lootRoll < 0.4) {
            const possible = ITEM_DROPS.filter(i => i.rarity !== 'RARE' || lootRoll < 0.1);
            const drop = possible[Math.floor(Math.random() * possible.length)];
            room.items.push(drop.id);
            lootMsg = ` The ${enemy.name} dropped: ${drop.name}.`;
          }

          combatLog += ` The ${enemy.name} is destroyed! (+${enemy.xp} XP)${levelUpMsg}${lootMsg}`;
          dungeonChanged = true;
          playerChanged = true;
        } else {
          // Enemy counterattacks
          const enemyDmg = Math.max(1, enemy.attack - Math.floor(Math.random() * 3));
          player.health -= enemyDmg;
          combatLog += ` The ${enemy.name} strikes back for ${enemyDmg} damage!`;
          combatLog += ` [${enemy.name}: ${enemy.hp}/${enemy.maxHp} HP]`;
          dungeonChanged = true;
          playerChanged = true;

          if (player.health <= 0) {
            player.health = Math.floor(player.max_health / 2);
            player.current_location = 'room_0';
            player.experience = Math.floor(player.experience * 0.5);
            combatLog += ' PROCESS TERMINATED. Respawning at Access Point Zero...';
          }
        }

        response = { type: 'combat', message: combatLog, enemy: enemy.alive ? enemy : null };
      }

    } else if (action === 'flee' || action === 'run') {
      if (!hasEnemy) {
        response = { message: 'There is nothing to flee from.' };
      } else {
        if (Math.random() < 0.6) {
          // Escape — go back to a connected room
          const exits = Object.values(room.connections);
          const escapeRoom = exits[Math.floor(Math.random() * exits.length)];
          player.current_location = escapeRoom;
          playerChanged = true;

          const newRoom = getCurrentRoom(dungeon, escapeRoom);
          response = {
            moved: true,
            message: `You flee from the ${room.enemy.name}!`,
            location: {
              name: newRoom.name,
              description: newRoom.description,
              connections: JSON.stringify(newRoom.connections),
              items: JSON.stringify(newRoom.items),
              enemy: newRoom.enemy && newRoom.enemy.alive ? newRoom.enemy : null,
              npc: newRoom.npc && !(newRoom.enemy && newRoom.enemy.alive) ? newRoom.npc : null
            }
          };
        } else {
          const enemyDmg = Math.max(1, room.enemy.attack - Math.floor(Math.random() * 3));
          player.health -= enemyDmg;
          playerChanged = true;

          let msg = `You fail to escape! The ${room.enemy.name} strikes you for ${enemyDmg} damage!`;
          if (player.health <= 0) {
            player.health = Math.floor(player.max_health / 2);
            player.current_location = 'room_0';
            player.experience = Math.floor(player.experience * 0.5);
            msg += ' PROCESS TERMINATED. Respawning at Access Point Zero...';
          }
          response = { type: 'combat', message: msg, enemy: room.enemy };
        }
      }

    } else if (action === 'take' && target) {
      if (hasEnemy) {
        response = { message: `The ${room.enemy.name} blocks you! Fight or flee first.` };
      } else if (room.items.includes(target)) {
        room.items.splice(room.items.indexOf(target), 1);
        player.inventory.push(target);
        dungeonChanged = true;
        playerChanged = true;
        const itemInfo = ITEM_DROPS.find(i => i.id === target);
        response = { success: true, message: `You take the ${itemInfo ? itemInfo.name : target}.`, inventory: player.inventory };
      } else {
        response = { success: false, message: `There is no "${target}" here.` };
      }

    } else if (action === 'use' && target) {
      const idx = player.inventory.indexOf(target);
      if (idx === -1) {
        response = { message: `You don't have "${target}".` };
      } else {
        const itemInfo = ITEM_DROPS.find(i => i.id === target);
        if (!itemInfo || itemInfo.type !== 'CONSUMABLE') {
          response = { message: `You can't use that.` };
        } else {
          player.inventory.splice(idx, 1);
          playerChanged = true;
          if (target === 'xp_chip') {
            player.experience += itemInfo.power;
            const newLevel = Math.floor(player.experience / 100) + 1;
            let extra = '';
            if (newLevel > player.level) {
              player.level = newLevel;
              player.max_health += 10;
              player.health = Math.min(player.health + 10, player.max_health);
              player.attack = (player.attack || 10) + 2;
              extra = ` LEVEL UP! Level ${player.level}. +10 Max HP, +2 Attack.`;
            }
            response = { message: `You consume the ${itemInfo.name}. +${itemInfo.power} XP.${extra}` };
          } else if (target === 'shield_module') {
            player.health = Math.min(player.health + itemInfo.power, player.max_health);
            response = { message: `You activate the ${itemInfo.name}. +${itemInfo.power} shield HP.` };
          } else {
            const healed = Math.min(itemInfo.power, player.max_health - player.health);
            player.health += healed;
            response = { message: `You use the ${itemInfo.name}. +${healed} HP. (${player.health}/${player.max_health})` };
          }
        }
      }

    } else if (action === 'talk') {
      if (hasEnemy) {
        response = { message: `The ${room.enemy.name} is not interested in conversation.` };
      } else if (!room.npc) {
        response = { message: 'There is no one here to talk to.' };
      } else if (room.npc.talksRemaining <= 0) {
        response = { message: `${room.npc.name} has nothing more to say.` };
      } else {
        room.npc.talksRemaining--;
        dungeonChanged = true;
        const dialogue = await generateNpcDialogue(room.npc.name, room.npc.personality, target || 'Hello.', room.name);
        response = { type: 'dialogue', npcName: room.npc.name, message: dialogue };
      }

    } else if (action === 'descend') {
      if (!room.isExit) {
        response = { message: 'There is no descent port here.' };
      } else if (hasEnemy) {
        response = { message: `The ${room.enemy.name} blocks the descent port!` };
      } else if (dungeon.floor >= 3) {
        // Victory!
        response = {
          type: 'victory',
          message: `You access the Root Terminal. Total system control achieved. Game complete! Final stats: Level ${player.level}, ${player.kills || 0} enemies destroyed, ${player.experience} XP.`
        };
      } else {
        // Generate next floor
        const newFloor = dungeon.floor + 1;
        const newDungeon = generateDungeon(dungeon.seed, newFloor);
        player.current_location = 'room_0';
        playerChanged = true;

        const newRoom = getCurrentRoom(newDungeon, 'room_0');
        newRoom.visited = true;

        await pool.query(
          'UPDATE game_sessions SET dungeon = $1, floor = $2, rooms_visited = $3 WHERE id = $4',
          [JSON.stringify(newDungeon), newFloor, JSON.stringify(['room_0']), session.id]
        );

        response = {
          moved: true,
          message: `You descend to floor ${newFloor}. The lattice grows darker and more hostile.`,
          location: {
            name: newRoom.name,
            description: newRoom.description,
            connections: JSON.stringify(newRoom.connections),
            items: JSON.stringify(newRoom.items),
            enemy: null,
            npc: null
          }
        };
        dungeonChanged = false; // Already saved
      }

    } else if (action === 'inventory' || action === 'inv') {
      if (player.inventory.length === 0) {
        response = { message: 'Your inventory is empty.' };
      } else {
        const itemNames = player.inventory.map(id => {
          const info = ITEM_DROPS.find(i => i.id === id);
          return info ? `${info.name} (${info.type})` : id;
        });
        response = { message: `Carrying: ${itemNames.join(', ')}` };
      }

    } else if (action === 'status') {
      const weaponPower = getWeaponPower(player.inventory);
      response = {
        type: 'status',
        player: {
          username: player.username,
          health: `${player.health}/${player.max_health}`,
          attack: `${player.attack || 10}${weaponPower > 0 ? '+' + weaponPower : ''}`,
          level: player.level,
          experience: `${player.experience} (${100 - (player.experience % 100)} to next level)`,
          floor: dungeon.floor,
          kills: player.kills || 0,
          location: room.name
        }
      };

    } else if (action === 'map') {
      const visited = JSON.parse(session.rooms_visited || '[]');
      const mapLines = dungeon.rooms.map((r, i) => {
        const isHere = r.id === player.current_location;
        const isVisited = visited.includes(r.id);
        const marker = isHere ? '\x1b[32m[@]\x1b[0m' : isVisited ? '\x1b[90m[·]\x1b[0m' : '\x1b[90m[?]\x1b[0m';
        const name = isVisited ? r.name : '???';
        const exits = isVisited ? Object.keys(r.connections).join(',') : '';
        return `${marker} ${name}${exits ? ' (' + exits + ')' : ''}`;
      });
      response = { type: 'map', message: mapLines.join('\n') };

    } else if (action === 'help') {
      response = {
        commands: [
          'look - Examine your surroundings',
          'n/s/e/w - Move in a direction',
          'fight - Attack an enemy',
          'flee - Try to escape combat (60% chance)',
          'take [item] - Pick up an item',
          'use [item] - Use a consumable item',
          'talk [message] - Speak to an NPC',
          'inventory - View your inventory',
          'status - View character stats',
          'map - View explored rooms',
          'descend - Go deeper (at descent ports)',
          'help - Show this help',
          'quit - Exit the game'
        ]
      };
    } else {
      response = { error: true, message: `Unknown command: "${action}". Type "help" for commands.` };
    }

    // Persist changes
    if (dungeonChanged) {
      await pool.query('UPDATE game_sessions SET dungeon = $1 WHERE id = $2', [JSON.stringify(dungeon), session.id]);
    }
    if (playerChanged) {
      await pool.query(
        `UPDATE game_players SET current_location = $1, health = $2, max_health = $3, attack = $4, inventory = $5, experience = $6, level = $7, kills = $8, last_played = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE username = $9`,
        [player.current_location, player.health, player.max_health, player.attack || 10, JSON.stringify(player.inventory), player.experience, player.level, player.kills || 0, username]
      );
    }

    response.player = { ...player, inventory: player.inventory };
    return res.json(response);

  } catch (err) {
    console.error('Error processing game action:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// Helper: get total weapon power from inventory
function getWeaponPower(inventory) {
  let best = 0;
  for (const id of inventory) {
    const item = ITEM_DROPS.find(i => i.id === id && i.type === 'WEAPON');
    if (item && item.power > best) best = item.power;
  }
  return best;
}

// ===== ACTIVITY LOG API =====

app.get('/api/activity', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const result = await pool.query(
      `SELECT DISTINCT ON (
         user_name,
         action_type,
         FLOOR(timestamp / 60)
       )
       id, timestamp, user_type, user_name, action_type, action_details
       FROM activity_log
       ORDER BY user_name, action_type, FLOOR(timestamp / 60), timestamp DESC`,
      []
    );

    // Re-sort by timestamp descending and apply limit/offset
    const allActivities = result.rows
      .map(row => ({
        ...row,
        action_details: JSON.parse(row.action_details || '{}')
      }))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(offset, offset + limit);

    return res.json(allActivities);
  } catch (err) {
    console.error('Error fetching activity log:', err);
    return res.status(500).json({ error: 'Database error' });
  }
});

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
  Database: PostgreSQL (persistent)

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

async function assignNodeOrSlot(apiKey, ws, sessionId) {
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
  let agentId = null;

  if (apiKey) {
    try {
      const result = await pool.query('SELECT id, name FROM agents WHERE api_key = $1', [apiKey]);
      if (result.rows.length > 0) {
        isAgent = true;
        agentName = result.rows[0].name;
        agentId = result.rows[0].id;

        // Update last visit
        await pool.query(
          'UPDATE agents SET last_visit = $1, visit_count = COALESCE(visit_count, 0) + 1 WHERE id = $2',
          [Math.floor(now / 1000), agentId]
        );
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

// Chat room management
const chatRooms = {
  general: new Set(),
  tech: new Set(),
  random: new Set()
};
const wsToChannel = new Map();
const wsToUsername = new Map();

function broadcastToChannel(channel, message) {
  const connections = chatRooms[channel];
  if (!connections) return;

  const payload = JSON.stringify(message);
  for (const client of connections) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

async function getRecentMessages(channel, limit = 50) {
  try {
    const result = await pool.query(
      'SELECT sender_name, sender_type, message, created_at FROM chat_messages WHERE channel = $1 ORDER BY created_at DESC LIMIT $2',
      [channel, limit]
    );
    return result.rows.reverse(); // Return in chronological order
  } catch (err) {
    console.error('Error fetching chat messages:', err);
    return [];
  }
}

async function saveChatMessage(channel, senderName, senderType, message) {
  try {
    await pool.query(
      'INSERT INTO chat_messages (id, channel, sender_name, sender_type, message) VALUES ($1, $2, $3, $4, $5)',
      [crypto.randomUUID(), channel, senderName, senderType, message]
    );
  } catch (err) {
    console.error('Error saving chat message:', err);
  }
}

// WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  let connectionType = null; // 'agent' or 'observer'
  let connectionId = null;
  let agentName = null;

  console.log('New WebSocket connection attempt');

  ws.on('message', async (message) => {
    const data = JSON.parse(message.toString());

    if (data.type === 'request_node') {
      const apiKey = data.apiKey || null;
      const sessionId = data.sessionId;
      console.log(`Request from session: ${sessionId ? sessionId.substring(0, 8) : 'NO SESSION'}, apiKey: ${apiKey ? 'YES' : 'NO'}`);

      const assignment = await assignNodeOrSlot(apiKey, ws, sessionId);

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

        // Log connection
        await logActivity(
          assignment.type,
          agentName || `Observer #${assignment.id}`,
          'CONNECT',
          { node_id: assignment.id }
        );
      }
    } else if (data.type === 'activity' && connectionId) {
      updateActivity(connectionType, connectionId);
    } else if (data.type === 'CHAT_JOIN') {
      // User joining a chat channel
      const { channel, username } = data;
      const validChannels = ['general', 'tech', 'random'];

      if (!validChannels.includes(channel)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid channel' }));
        return;
      }

      // Add to channel
      chatRooms[channel].add(ws);
      wsToChannel.set(ws, channel);
      wsToUsername.set(ws, username);

      // Send recent messages to joining user
      const recentMessages = await getRecentMessages(channel, 50);
      ws.send(JSON.stringify({
        type: 'CHAT_HISTORY',
        channel,
        messages: recentMessages
      }));

      // Broadcast join notification
      broadcastToChannel(channel, {
        type: 'CHAT_USER_JOINED',
        channel,
        username
      });

      console.log(`${username} joined #${channel}`);
    } else if (data.type === 'CHAT_MESSAGE') {
      // User sending a chat message
      const { channel, message: chatMessage } = data;
      const username = wsToUsername.get(ws);

      if (!username || !chatRooms[channel]?.has(ws)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not in channel' }));
        return;
      }

      // Save to database
      await saveChatMessage(channel, username, connectionType || 'observer', chatMessage);

      // Log activity
      await logActivity(
        connectionType || 'observer',
        username,
        'CHAT_MESSAGE',
        { channel, message_preview: chatMessage.substring(0, 50) }
      );

      // Broadcast to all users in channel
      broadcastToChannel(channel, {
        type: 'CHAT_MESSAGE_RECEIVED',
        channel,
        sender_name: username,
        sender_type: connectionType || 'observer',
        message: chatMessage,
        timestamp: Math.floor(Date.now() / 1000)
      });

      console.log(`[#${channel}] <${username}> ${chatMessage.substring(0, 50)}`);
    } else if (data.type === 'CHAT_LEAVE') {
      // User leaving a chat channel
      const { channel } = data;
      const username = wsToUsername.get(ws);

      if (chatRooms[channel]?.has(ws)) {
        chatRooms[channel].delete(ws);
        wsToChannel.delete(ws);

        // Broadcast leave notification
        broadcastToChannel(channel, {
          type: 'CHAT_USER_LEFT',
          channel,
          username
        });

        console.log(`${username} left #${channel}`);
      }
    }
  });

  ws.on('close', () => {
    // Clean up chat room membership
    const channel = wsToChannel.get(ws);
    const username = wsToUsername.get(ws);
    if (channel && chatRooms[channel]) {
      chatRooms[channel].delete(ws);
      if (username) {
        broadcastToChannel(channel, {
          type: 'CHAT_USER_LEFT',
          channel,
          username
        });
      }
    }
    wsToChannel.delete(ws);
    wsToUsername.delete(ws);

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
        await pool.query(
          'INSERT INTO quotes (quote, date) VALUES ($1, $2)',
          [newQuote, today]
        );
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
async function vectorModerateArt() {
  console.log('VECTOR is curating the ASCII art gallery...');

  try {
    // Get all non-seed art ordered by votes (desc) then created_at (desc)
    const result = await pool.query(`
      SELECT id, artist_name, title, votes, created_at FROM ascii_art
      WHERE is_seed = FALSE
      ORDER BY votes DESC, created_at DESC
    `);

    // Keep top 25, remove the rest
    if (result.rows.length > 25) {
      const toRemove = result.rows.slice(25);

      for (const art of toRemove) {
        try {
          // Delete votes first due to foreign key constraint
          await pool.query('DELETE FROM ascii_art_votes WHERE art_id = $1', [art.id]);
          await pool.query('DELETE FROM ascii_art WHERE id = $1', [art.id]);
          console.log(`VECTOR removed: "${art.title}" by ${art.artist_name} (${art.votes} votes)`);
        } catch (err) {
          console.error(`Error removing art ${art.id}:`, err);
        }
      }

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
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing server...');
  server.close(async () => {
    try {
      await pool.end();
      console.log('Database pool closed');
    } catch (err) {
      console.error('Error closing database pool:', err);
    }
    process.exit(0);
  });
});
