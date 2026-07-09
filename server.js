// 照章成事游戏工坊 - 后端服务
// 技术栈：Node.js + Express + SQLite（Node内置 node:sqlite 模块，无需额外编译安装数据库驱动）

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const { DatabaseSync } = require('node:sqlite');

const app = express();
app.use(cors());
app.use(express.json());

// ---------- 数据库初始化 ----------
const dbPath = path.join(__dirname, 'arcade.db');
const db = new DatabaseSync(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS game_time (
  user_id INTEGER PRIMARY KEY,
  seconds INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS duel_stats (
  user_id INTEGER NOT NULL,
  game TEXT NOT NULL,
  win INTEGER NOT NULL DEFAULT 0,
  lose INTEGER NOT NULL DEFAULT 0,
  draw INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, game)
);
CREATE TABLE IF NOT EXISTS mine_best (
  user_id INTEGER NOT NULL,
  difficulty TEXT NOT NULL,
  best_time INTEGER NOT NULL,
  PRIMARY KEY (user_id, difficulty)
);
`);

// ---------- 工具函数 ----------
function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}
function genToken() {
  return crypto.randomBytes(24).toString('hex');
}
function nowISO() {
  return new Date().toISOString();
}

// ---------- 鉴权中间件 ----------
function auth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: '未登录' });
  const row = db.prepare(
    'SELECT s.user_id AS user_id, u.username AS username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'
  ).get(token);
  if (!row) return res.status(401).json({ error: '登录已失效，请重新登录' });
  req.userId = row.user_id;
  req.username = row.username;
  next();
}

// ---------- 账号：注册 / 登录 / 登出 / 当前用户 ----------
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (password.length < 4) return res.status(400).json({ error: '密码至少需要4位' });
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(400).json({ error: '用户名已被注册' });

  const info = db.prepare(
    'INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'
  ).run(username, hashPassword(password), nowISO());
  const userId = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO game_time (user_id, seconds) VALUES (?, 0)').run(userId);

  const token = genToken();
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, nowISO());
  res.json({ token, username });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || user.password_hash !== hashPassword(password || '')) {
    return res.status(400).json({ error: '用户名或密码错误' });
  }
  const token = genToken();
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, user.id, nowISO());
  res.json({ token, username });
});

app.post('/api/logout', auth, (req, res) => {
  const token = req.headers['authorization'].slice(7);
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const gt = db.prepare('SELECT seconds FROM game_time WHERE user_id = ?').get(req.userId);
  res.json({ username: req.username, gameTime: gt ? gt.seconds : 0 });
});

// ---------- 游戏时长同步（客户端定期上报增量秒数） ----------
app.post('/api/gametime', auth, (req, res) => {
  const delta = Math.max(0, Math.min(3600, parseInt(req.body && req.body.delta, 10) || 0));
  const existing = db.prepare('SELECT seconds FROM game_time WHERE user_id = ?').get(req.userId);
  if (existing) {
    db.prepare('UPDATE game_time SET seconds = seconds + ? WHERE user_id = ?').run(delta, req.userId);
  } else {
    db.prepare('INSERT INTO game_time (user_id, seconds) VALUES (?, ?)').run(req.userId, delta);
  }
  const gt = db.prepare('SELECT seconds FROM game_time WHERE user_id = ?').get(req.userId);
  res.json({ gameTime: gt.seconds });
});

// ---------- 对战战绩（井字棋 / 五子棋，人机对战模式） ----------
const DUEL_GAMES = ['ttt', 'gomoku'];
const DUEL_RESULTS = ['win', 'lose', 'draw'];

app.post('/api/duel-result', auth, (req, res) => {
  const { game, result } = req.body || {};
  if (!DUEL_GAMES.includes(game) || !DUEL_RESULTS.includes(result)) {
    return res.status(400).json({ error: '参数错误' });
  }
  const existing = db.prepare('SELECT * FROM duel_stats WHERE user_id = ? AND game = ?').get(req.userId, game);
  if (existing) {
    db.prepare(`UPDATE duel_stats SET ${result} = ${result} + 1 WHERE user_id = ? AND game = ?`).run(req.userId, game);
  } else {
    const counts = { win: 0, lose: 0, draw: 0 };
    counts[result] = 1;
    db.prepare(
      'INSERT INTO duel_stats (user_id, game, win, lose, draw) VALUES (?, ?, ?, ?, ?)'
    ).run(req.userId, game, counts.win, counts.lose, counts.draw);
  }
  res.json({ ok: true });
});

app.get('/api/leaderboard/duel/:game', (req, res) => {
  const game = req.params.game;
  if (!DUEL_GAMES.includes(game)) return res.status(400).json({ error: '参数错误' });
  const rows = db.prepare(
    'SELECT u.username AS username, d.win AS win, d.lose AS lose, d.draw AS draw FROM duel_stats d JOIN users u ON u.id = d.user_id WHERE d.game = ? ORDER BY d.win DESC'
  ).all(game);
  res.json(rows);
});

// ---------- 扫雷最佳用时 ----------
const MINE_DIFFS = ['easy', 'medium', 'hard'];

app.post('/api/mine-result', auth, (req, res) => {
  const { difficulty, time } = req.body || {};
  const t = parseInt(time, 10);
  if (!MINE_DIFFS.includes(difficulty) || !Number.isFinite(t) || t < 0) {
    return res.status(400).json({ error: '参数错误' });
  }
  const existing = db.prepare('SELECT * FROM mine_best WHERE user_id = ? AND difficulty = ?').get(req.userId, difficulty);
  if (!existing) {
    db.prepare('INSERT INTO mine_best (user_id, difficulty, best_time) VALUES (?, ?, ?)').run(req.userId, difficulty, t);
  } else if (t < existing.best_time) {
    db.prepare('UPDATE mine_best SET best_time = ? WHERE user_id = ? AND difficulty = ?').run(t, req.userId, difficulty);
  }
  res.json({ ok: true });
});

app.get('/api/leaderboard/mine', (req, res) => {
  const rows = db.prepare(
    'SELECT u.username AS username, m.difficulty AS difficulty, m.best_time AS best_time FROM mine_best m JOIN users u ON u.id = m.user_id ORDER BY m.best_time ASC'
  ).all();
  res.json(rows);
});

// ---------- 静态文件（把前端 html 也放进 public 目录即可同源访问） ----------
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true, time: nowISO() }));

// ---------- 联网对战（Socket.IO 房间制，双人跨设备/跨网络实时对战） ----------
// 房间只存于内存中，不落库；每个房间两名玩家，先创建者为 A（先手），加入者为 B（后手）
const ONLINE_GAMES = ['ttt', 'gomoku', 'mine'];
const MINE_ONLINE_DIFFS = ['easy', 'medium', 'hard'];
const rooms = new Map(); // code -> { game, sockets: {A: socketId, B: socketId}, names: {A,B}, turn: 'A'|'B', difficulty?, seed? }

function genMineSeed() {
  // 扫雷联网对战需要一个双方共享的随机种子，用同一个种子在两边各自生成完全相同的雷区布局，
  // 这样服务器不用维护整张棋盘状态，只需转发"翻开了哪一格"这类操作即可，和井字棋/五子棋的逻辑保持一致
  return crypto.randomInt(1, 2147483646);
}

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆字符
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.role = null;

  socket.on('duel:create', ({ game, name, difficulty } = {}, ack) => {
    if (!ONLINE_GAMES.includes(game)) return ack && ack({ ok: false, error: '不支持的游戏' });
    const code = genRoomCode();
    const room = {
      game,
      sockets: { A: socket.id, B: null },
      names: { A: (name || '玩家A').slice(0, 12), B: null },
      turn: 'A',
    };
    if (game === 'mine') {
      room.difficulty = MINE_ONLINE_DIFFS.includes(difficulty) ? difficulty : 'easy';
      room.seed = genMineSeed();
    }
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = 'A';
    ack && ack({ ok: true, code });
  });

  socket.on('duel:join', ({ game, code, name } = {}, ack) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return ack && ack({ ok: false, error: '房间不存在，请检查房间号' });
    if (room.game !== game) return ack && ack({ ok: false, error: '房间游戏类型不匹配' });
    if (room.sockets.B) return ack && ack({ ok: false, error: '房间已满' });
    room.sockets.B = socket.id;
    room.names.B = (name || '玩家B').slice(0, 12);
    socket.join(code.toUpperCase());
    socket.data.roomCode = code.toUpperCase();
    socket.data.role = 'B';
    ack && ack({ ok: true, code: code.toUpperCase() });
    // 扫雷需要把难度和随机种子一起下发，双方各自用同一个种子生成完全一致的雷区
    const extra = room.game === 'mine' ? { difficulty: room.difficulty, seed: room.seed } : {};
    io.to(room.sockets.A).emit('duel:start', { code: code.toUpperCase(), role: 'A', opponentName: room.names.B, ...extra });
    io.to(room.sockets.B).emit('duel:start', { code: code.toUpperCase(), role: 'B', opponentName: room.names.A, ...extra });
  });

  socket.on('duel:move', ({ code, data } = {}) => {
    const room = rooms.get(code);
    if (!room) return;
    const role = socket.data.role;
    if (!role || room.sockets[role] !== socket.id) return; // 非本房间玩家
    if (room.turn !== role) return; // 未到该玩家回合，忽略（防作弊/误触）
    const opponentRole = role === 'A' ? 'B' : 'A';
    const opponentSocketId = room.sockets[opponentRole];
    room.turn = opponentRole;
    if (opponentSocketId) io.to(opponentSocketId).emit('duel:opponent-move', { data });
  });

  socket.on('duel:restart-request', ({ code } = {}) => {
    const room = rooms.get(code);
    if (!room) return;
    room.turn = 'A';
    if (room.game === 'mine') {
      // 扫雷每一局都要换一张新雷区，重新生成种子后广播给房间内两人（含发起者本人），确保双方拿到的是同一张新地图
      room.seed = genMineSeed();
      io.to(code).emit('duel:opponent-restart', { seed: room.seed, difficulty: room.difficulty });
      return;
    }
    const role = socket.data.role;
    const opponentRole = role === 'A' ? 'B' : 'A';
    const opponentSocketId = room.sockets[opponentRole];
    if (opponentSocketId) io.to(opponentSocketId).emit('duel:opponent-restart');
  });

  socket.on('duel:leave', () => leaveRoom(socket));
  socket.on('disconnect', () => leaveRoom(socket));

  function leaveRoom(sock) {
    const code = sock.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const role = sock.data.role;
    const opponentRole = role === 'A' ? 'B' : 'A';
    const opponentSocketId = room.sockets[opponentRole];
    if (opponentSocketId) io.to(opponentSocketId).emit('duel:opponent-left');
    rooms.delete(code);
    sock.data.roomCode = null;
  }
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`照章成事游戏工坊后端已启动: http://localhost:${PORT}`);
  console.log(`数据库文件: ${dbPath}`);
});
