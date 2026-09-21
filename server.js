/**
 * The Last Star - 多人在线回合制炮弹游戏 - 服务端
 * 服务器权威：弹道、伤害、地形均在服务器计算，客户端只负责渲染与输入
 */
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// 关闭 Nagle 算法：小包（游戏消息）立即发送，不被 TCP 缓冲合并
server.on('connection', (socket) => socket.setNoDelay(true));
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  perMessageDeflate: false, // 游戏小包压缩得不偿失，关闭以降低延迟
});

const WORLD_W = 1920;
const WORLD_H = 1080;
const GRAVITY = 0.28;
const TURN_TIME = 20;          // 秒
const MAX_POWER = 160;
const MAX_HP = 1500;
const TANK_R = 14;             // 命中半径
const EXPLODE_R = 55;          // 爆炸半径
const MAX_DMG = 320;           // 中心最大伤害
const MOVE_BUDGET = 150;       // 每回合可移动像素
const TEAM_SIZE = 3;           // 每队人数（3v3）
const ROOM_CAPACITY = 8;       // 房间总容量：6名对战玩家 + 2名观战
const ROOM_LIFE = 1000 * 60 * 60;

/** 随机默认英文名 */
const EN_NAMES = ['Phoenix', 'Raven', 'Blaze', 'Storm', 'Falcon', 'Shadow', 'Thunder', 'Comet', 'Ember', 'Frost',
  'Nova', 'Titan', 'Viper', 'Hawk', 'Wolf', 'Dragon', 'Lynx', 'Puma', 'Cobra', 'Echo',
  'Rocket', 'Bullet', 'Cannon', 'Ace', 'Duke', 'Rex', 'Max', 'Leo', 'Ozzy', 'Zoe'];
function randomName() {
  return EN_NAMES[Math.floor(Math.random() * EN_NAMES.length)] + Math.floor(Math.random() * 90 + 10);
}

/** 卡牌定义：双卡槽制——开局随机1张，可主动抽牌三选一补满第二槽；仅自己回合可打出 */
const CARDS = {
  heal:      { id: 'heal',      emoji: '💚', name: 'Healing',       desc: '恢复250点生命' },
  shield:    { id: 'shield',    emoji: '🛡️', name: 'Mini Shield',   desc: '获得护盾，格挡250点伤害（周身淡蓝护盾特效）' },
  double:    { id: 'double',    emoji: '💥', name: 'Double Trouble',desc: '炮弹额外造成120点真实伤害（不受任何加成影响）' },
  revenge:   { id: 'revenge',   emoji: '🎯', name: 'Revenge',       desc: '下一次炮击伤害+100（可叠加）' },
  poison:    { id: 'poison',    emoji: '☠️', name: 'Poison',        desc: '炮弹命中的目标受120点毒伤，之后每回合60点毒伤，共2回合（多张叠加）' },
  bloodpact: { id: 'bloodpact', emoji: '🏹', name: 'Blood Pact',    desc: '炮弹额外造成280点真实伤害；消耗150生命（最低保留1点）；仅能使用一次' },
  berserk:   { id: 'berserk',   emoji: '🔥', name: 'Berserk',       desc: '3回合内炮击伤害+70' },
  fortress:  { id: 'fortress',  emoji: '🏰', name: 'Fortress',      desc: '3回合内受到的伤害降低25%' },
};
/** 积分强化定义 */
const UPGRADES = {
  a: { id: 'a', name: '强化A', cost: 50,  desc: '追加一个发射物(30%伤害,可暴击)' },
  b: { id: 'b', name: '强化B', cost: 15,  desc: '暴击几率+8%' },
  c: { id: 'c', name: '强化C', cost: 60,  desc: '所有发射物伤害+30%' },
  d: { id: 'd', name: '强化D', cost: 25,  desc: '所有发射物伤害+20' },
  s: { id: 's', name: '强化S', cost: 200, desc: '伤害+100%（需蓄积两回合积分）' },
  e: { id: 'e', name: '强化E', cost: 35,  desc: '汲血：本次炮击伤害的30%转化为生命' },
  f: { id: 'f', name: '强化F', cost: 30,  desc: '精准：不受距离衰减，边缘保持满伤害' },
  g: { id: 'g', name: '强化G', cost: 80,  desc: '二次爆破：命中点引发二次爆炸(半径40,40%伤害)' },
};
function cardPool(p) {
  // 血契一次性卡：该玩家用过一次后不再出现
  return Object.keys(CARDS).filter(id => !(id === 'bloodpact' && p && p.bloodUsed));
}
function randomCard(p) {
  const ids = cardPool(p);
  return CARDS[ids[Math.floor(Math.random() * ids.length)]];
}
function randomChoices(p, n) {
  const ids = cardPool(p);
  const picked = [];
  while (picked.length < n && picked.length < ids.length) {
    const c = ids[Math.floor(Math.random() * ids.length)];
    if (!picked.includes(c)) picked.push(c);
  }
  return picked.map(id => CARDS[id]);
}
/** 向玩家同步卡槽状态（仅发给本人） */
function sendSlots(p) {
  io.to(p.sid).emit('hand', { slots: p.slots || [], deckUsed: !!p.deckUsed });
  if (p.cardChoice && p.cardChoice.length) io.to(p.sid).emit('cardChoice', { cards: p.cardChoice });
  else io.to(p.sid).emit('cardChoice', { cards: [] });
}

// 官网落地页挂在根路径（其 css/js 资源目录与 public 不冲突），游戏大厅挂 /game
app.use(express.static(path.join(__dirname, 'landing-page')));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'landing-page', 'index.html')));
app.get('/game', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
// 开场动画页：播放 intro 视频后进入 /game
app.get('/intro', (req, res) => res.sendFile(path.join(__dirname, 'public', 'intro.html')));
app.use('/opening-video', express.static(path.join(__dirname, 'opening-video')));

const rooms = new Map(); // roomId -> room
const sessions = new Map(); // 会话令牌 -> roomId（掉线重连用：玩家对象上存 token）
const waitingQueue = []; // 快速匹配

function genTerrain(map) {
  if (map === 'castle') return genCastleTerrain();
  const h = new Float32Array(WORLD_W);
  const base = WORLD_H * 0.72;
  const a1 = 40 + Math.random() * 60, f1 = 0.004 + Math.random() * 0.003, p1 = Math.random() * 7;
  const a2 = 20 + Math.random() * 40, f2 = 0.010 + Math.random() * 0.008, p2 = Math.random() * 7;
  const a3 = 8 + Math.random() * 15, f3 = 0.03, p3 = Math.random() * 7;
  for (let x = 0; x < WORLD_W; x++) {
    h[x] = base + Math.sin(x * f1 + p1) * a1 + Math.sin(x * f2 + p2) * a2 + Math.sin(x * f3 + p3) * a3;
    h[x] = Math.min(WORLD_H - 30, Math.max(120, h[x]));
  }
  return h;
}

/** 城堡地图：中央石制城堡（前景可破坏），两侧平缓草地质供两队出生 */
function genCastleTerrain() {
  const h = new Float32Array(WORLD_W);
  const base = WORLD_H * 0.78; // 平地
  for (let x = 0; x < WORLD_W; x++) {
    // 平缓地面起伏（±10），保持出生区平坦
    const t = Math.sin(x * 0.006) * 8 + Math.sin(x * 0.021 + 2) * 4;
    h[x] = base + t;
  }
  // 城齿垛口：从结构左缘起，每周期=垛墙宽28 + 垛口宽16，缺口下凹depth（两端都是实体垛墙）
  const crenel = (x, x0, top, depth) => {
    const m = (x - x0) % 44;
    return top + (m >= 28 ? depth : 0);
  };
  const seg = (x0, x1, fn) => { for (let x = Math.max(0, x0); x <= Math.min(WORLD_W - 1, x1); x++) h[x] = Math.min(h[x], fn(x)); };
  // 左塔 / 右塔：垂直塔身 + 垛口顶
  seg(790, 950, x => crenel(x, 790, 390, 18));
  seg(1210, 1370, x => crenel(x, 1210, 390, 18));
  // 中央主堡（更高，垛口稍深）
  seg(990, 1170, x => crenel(x, 990, 300, 20));
  // 连接城墙（低于塔顶，窄垛口）
  seg(950, 990, x => crenel(x, 950, 560, 14));
  seg(1170, 1210, x => crenel(x, 1170, 560, 14));
  return h;
}

/** 城堡藤蔓：挂在垛口缺口下沿的波状细条（可破坏，阻挡炮弹）。
    位置与 genCastleTerrain 的城齿周期一致：缺口位于 x0+k*44+28 起的16px内 */
function genVines() {
  const vines = [];
  // [结构左缘x0, 结构右缘, 垛口缺口底y]，与 genCastleTerrain 保持一致
  const structs = [
    [790, 950, 408], [990, 1170, 320], [1210, 1370, 408], // 左塔 / 主堡 / 右塔
    [950, 990, 574], [1170, 1210, 574],                    // 连接城墙
  ];
  for (const [x0, x1, yTop] of structs) {
    for (let x = x0 + 28; x < x1 - 4; x += 44) {
      if (Math.random() < 0.45) continue; // 不铺满，留出疏密
      const cx = x + 8 + (Math.random() - 0.5) * 6;  // 缺口中心附近
      const h = 50 + Math.floor(Math.random() * 90); // 50~140px
      vines.push({ shape: 'vine', x: Math.round(cx - 6), y: yTop, w: 12, h, phase: Math.random() * 6.28 });
    }
  }
  return vines;
}

function groundY(terrain, x) {
  x = Math.max(0, Math.min(WORLD_W - 1, Math.round(x)));
  return terrain[x];
}

/** 随机生成空中平台（可阻挡炮弹，也能承接落下的角色）；城堡地图：垛口下挂藤蔓（可破坏） */
function genPlatforms(map) {
  if (map === 'castle') return genVines();
  const plats = [];
  const n = 2 + Math.floor(Math.random() * 2); // 2~3 个
  for (let i = 0; i < n; i++) {
    for (let tries = 0; tries < 20; tries++) {
      const w = 110 + Math.floor(Math.random() * 80);
      const h = 20 + Math.floor(Math.random() * 10);
      const x = 300 + Math.floor(Math.random() * (WORLD_W - 600 - w));
      const y = 150 + Math.floor(Math.random() * 140);
      const overlap = plats.some(p => x < p.x + p.w + 40 && p.x < x + w + 40 && y < p.y + 60 && p.y < y + 60);
      if (!overlap) { plats.push({ shape: 'round', x, y, w, h }); break; }
    }
  }
  return plats;
}

/** 由高度图 + 空中平台构建 2D 实心网格 */
function buildMask(terrain, platforms) {
  const m = new Uint8Array(WORLD_W * WORLD_H);
  for (let x = 0; x < WORLD_W; x++) {
    const g = Math.round(terrain[x]);
    for (let y = g; y < WORLD_H; y++) m[y * WORLD_W + x] = 1;
  }
  for (const pf of platforms || []) {
    const x0 = Math.max(0, pf.x), x1 = Math.min(WORLD_W - 1, pf.x + pf.w - 1);
    const y0 = Math.max(0, pf.y), y1 = Math.min(WORLD_H - 1, pf.y + pf.h - 1);
    if (pf.shape === 'ellipse') {
      const cx = pf.x + pf.w / 2, cy = pf.y + pf.h / 2, rx = pf.w / 2, ry = pf.h / 2;
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry;
        if (nx * nx + ny * ny <= 1) m[y * WORLD_W + x] = 1;
      }
    } else if (pf.shape === 'vine') {
      // 波状藤干：中心线随深度正弦摆动，实体为4px宽芯（叶片不参与碰撞）
      const cx = pf.x + pf.w / 2;
      for (let y = y0; y <= y1; y++) {
        const xc = Math.round(cx + Math.sin((y - pf.y) * 0.08 + (pf.phase || 0)) * 4);
        for (let x = Math.max(0, xc - 2); x <= Math.min(WORLD_W - 1, xc + 2); x++) m[y * WORLD_W + x] = 1;
      }
    } else {
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) m[y * WORLD_W + x] = 1;
    }
  }
  return m;
}

function solidIn(mask, x, y) {
  if (x < 0 || x >= WORLD_W || y < 0 || y >= WORLD_H) return false;
  return mask[y * WORLD_W + x] === 1;
}

/** 某列最顶部的实心表面 y（坦克站立点） */
function topSolid(mask, x) {
  x = Math.max(0, Math.min(WORLD_W - 1, Math.round(x)));
  for (let y = 0; y < WORLD_H; y++) if (mask[y * WORLD_W + x]) return y;
  return WORLD_H;
}

/** 某列从 fromY（脚底附近）开始向下首个实心表面 y。
    空中平台只承接从上方落下的实体，不会把平台下方的人吸上去 */
function groundBelow(mask, x, fromY) {
  x = Math.max(0, Math.min(WORLD_W - 1, Math.round(x)));
  for (let y = Math.max(0, Math.round(fromY)); y < WORLD_H; y++) if (mask[y * WORLD_W + x]) return y;
  return WORLD_H;
}

/** 碰撞圆心：贴图随坡面旋转后的视觉中心（世界坐标）。centerH = 圆心距脚底的高度 */
function colCenter(room, x, y, centerH) {
  const xa = Math.max(0, Math.min(WORLD_W - 1, Math.round(x - 14)));
  const xb = Math.max(0, Math.min(WORLD_W - 1, Math.round(x + 14)));
  const ya = groundBelow(room.mask, xa, y - 8), yb = groundBelow(room.mask, xb, y - 8);
  let tx = xb - xa, ty = yb - ya;
  if (ya >= WORLD_H || yb >= WORLD_H) { tx = 1; ty = 0; }
  const l = Math.hypot(tx, ty) || 1;
  return { cx: x + (ty / l) * centerH, cy: y - (tx / l) * centerH };
}

/** 在 2D 网格上挖圆形弹坑，返回每列被清除的区段（增量同步给客户端） */
function carveMask(mask, cx, cy, r) {
  const runs = [];
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(WORLD_W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(WORLD_H - 1, Math.ceil(cy + r));
  for (let x = x0; x <= x1; x++) {
    let runStart = -1;
    for (let y = y0; y <= y1; y++) {
      const dx = x - cx, dy = y - cy;
      const inCircle = dx * dx + dy * dy <= r * r;
      if (inCircle && mask[y * WORLD_W + x]) {
        mask[y * WORLD_W + x] = 0;
        if (runStart < 0) runStart = y;
      } else if (runStart >= 0) {
        runs.push({ x, y0: runStart, y1: y - 1 });
        runStart = -1;
      }
    }
    if (runStart >= 0) runs.push({ x, y0: runStart, y1 });
  }
  return runs;
}

function createRoom(name, pve) {
  const room = {
    id: name || ('R' + Math.random().toString(36).slice(2, 7).toUpperCase()),
    terrain: genTerrain(),
    map: 'random',        // 地图：random 随机 | castle 城堡（房主可切换，开局时按此生成）
    mask: null,           // 2D 实心网格（可破坏地形的碰撞与挖掘依据）
    mode: pve ? 'pve' : 'pvp',
    monsters: [],         // PVE：小兵与Boss
    players: [],          // { sid, name, x, y, hp, angle, power, alive }
    hostSid: null,        // 房主
    turn: 0,              // 当前行动玩家索引
    state: 'waiting',     // waiting | playing | over
    wind: 0,
    timer: null,
    shotTimer: null,      // 炮弹32tick模拟循环
    timeLeft: TURN_TIME,
    shots: 0,
    spawnSeq: 0, // Boss产小兵计数
    bossShot: null, bossShotTimer: null,
    createdAt: Date.now(),
  };
  room.platforms = genPlatforms(room.map);
  room.mask = buildMask(room.terrain, room.platforms);
  rooms.set(room.id, room);
  return room;
}

/** 生成PVE怪物：与玩家数相当的小兵 + 1个Boss */
function spawnMonsters(room) {
  const actives = room.players.filter(p => !p.spectator);
  const n = Math.max(3, actives.length);
  room.monsters = [];
  for (let i = 0; i < n; i++) {
    const x = Math.min(WORLD_W - 100, 1100 + i * 150 + Math.random() * 40);
    room.monsters.push({ id: 'm' + i, kind: 'minion', x, y: 0, hp: 450, maxHp: 450, dmg: 125, speed: 200, range: 45, r: 19.5, alive: true });
  }
  const bx = Math.min(WORLD_W - 100, 1160 + n * 150);
  room.monsters.push({ id: 'boss', kind: 'boss', x: bx, y: 0, hp: 1800, maxHp: 1800, dmg: 250, speed: 100, range: 60, r: 35.75, alive: true, spawnCount: 0 });
  for (const m of room.monsters) m.y = groundY(room.terrain, m.x); // 出生在地面（平台由重力系统按需承接）
  broadcast(room, 'monsters', { monsters: room.monsters });
}

/** Boss行动：发射一枚“小兵炮弹”（32tick权威抛射，无弹坑，落地生成小兵）。onDone在炮弹落地后调用 */
function bossSpawnShot(room, boss, onDone) {
  if (room.monsters.length >= 10) { onDone && onDone(); return; } // 场上小兵上限
  const seq = ++room.spawnSeq;
  const id = 'sp' + seq;
  let dirx = Math.random() < 0.5 ? -1 : 1;
  let bd = Infinity;
  for (const p of room.players) {
    if (p.spectator || !p.alive) continue;
    const d = Math.abs(p.x - boss.x);
    if (d < bd) { bd = d; dirx = Math.sign(p.x - boss.x) || 1; }
  }
  const speed = 3.2 + Math.random() * 1.4; // 低速：射程很近
  const ang = (40 + Math.random() * 20) * Math.PI / 180;
  const shot = {
    x: boss.x, y: boss.y - boss.r,
    vx: Math.cos(ang) * speed * dirx,
    vy: -Math.sin(ang) * speed,
  };
  broadcast(room, 'minionShotBegin', { id, x: +shot.x.toFixed(1), y: +shot.y.toFixed(1), vx: +shot.vx.toFixed(2), vy: +shot.vy.toFixed(2) });
  room.bossShot = { id, shot };
  room.bossShotTimer = setInterval(() => {
    const bs = room.bossShot;
    if (!bs) { clearInterval(room.bossShotTimer); room.bossShotTimer = null; onDone && onDone(); return; }
    const s = bs.shot;
    s.x += s.vx * 0.7; s.y += s.vy * 0.7; s.vy += GRAVITY * 0.7; s.x += room.wind * 0.012;
    s.step = (s.step || 0) + 1;
    const landed = (s.step > 6 && solidIn(room.mask, Math.round(s.x), Math.round(s.y))) || s.y > WORLD_H || s.step > 600;
    if (landed) {
      // 落地：先广播一帧“冻结”的最终位置（速度清零），客户端小球即刻停在落点，不再滑行
      const gy = groundBelow(room.mask, s.x, s.y - 8);
      broadcast(room, 'minionShotTick', { id, x: +s.x.toFixed(1), y: +gy.toFixed(1), vx: 0, vy: 0, done: true });
      clearInterval(room.bossShotTimer);
      room.bossShotTimer = null;
      room.bossShot = null;
      const minion = { id, kind: 'minion', x: Math.round(s.x), y: gy, hp: 200, maxHp: 200, dmg: 85, speed: 200, range: 45, r: 12.5, alive: true };
      room.monsters.push(minion);
      broadcast(room, 'minionShotEnd', { id, minion });
      broadcast(room, 'monsters', { monsters: room.monsters });
      onDone && onDone(); // 炮弹落地、小兵生成后才放行下一只行动
      return;
    }
    broadcast(room, 'minionShotTick', { id, x: +s.x.toFixed(1), y: +s.y.toFixed(1), vx: +s.vx.toFixed(2), vy: +s.vy.toFixed(2) });
  }, 1000 / 32);
}

/** 重力系统：脚下没有实心地形时加速下落直到触地（32tick，与炮弹相同的重力加速度） */
function startGravity(room) {
  if (room.gravityTimer) return;
  const TICK_MS = 1000 / 32;   // 32 tick/秒
  const STEPS = 3;             // 每tick推进3个物理步（与炮弹一致）
  room.gravityTimer = setInterval(() => {
    if (room.state !== 'playing') return;
    let changed = false;
    const players = [], monsters = [];
    /** 单个实体按加速度下落STEPS个物理步，返回位置是否变化 */
    const fallSteps = (e, x) => {
      const before = e.y;
      for (let k = 0; k < STEPS; k++) {
        const g = groundBelow(room.mask, x, e.y - 8); // 从脚底上方一点起查，允许浅度卡入回贴
        if (e.y > g) { e.y = g; e.fallV = 0; }               // 卡进地形：贴回表面
        else if (e.y < g - 1) {                              // 悬空：加速下落
          e.fallV = (e.fallV || 0) + GRAVITY * 0.7;
          e.y = Math.min(g, e.y + e.fallV * 0.7);
          if (e.y >= g - 0.5) { e.y = g; e.fallV = 0; }      // 落地
        } else { e.fallV = 0; break; }                       // 已在地表
      }
      return e.y !== before;
    };
    for (let i = 0; i < room.players.length; i++) {
      const p = room.players[i];
      if (p.spectator || !p.alive) continue;
      if (fallSteps(p, p.x)) {
        players.push({ slot: i, x: +p.x.toFixed(1), y: +p.y.toFixed(1) });
        changed = true;
      }
    }
    for (const m of room.monsters || []) {
      if (!m.alive || m.climbing) continue; // 攀爬/挂壁中的怪物不受重力
      if (fallSteps(m, m.x)) {
        monsters.push({ id: m.id, y: +m.y.toFixed(1) });
        changed = true;
      }
    }
    if (changed) broadcast(room, 'fall', { players, monsters });
  }, TICK_MS);
}
/** 单只怪物行动：向最近的存活玩家移动，进入近战范围则攻击 */
function monsterActOne(room, m, onDone) {
  // 串行怪物阶段：onDone 在本只行动真正结束后恰好调用一次（走完/打完/炮弹落地），下一只才开始
  let finished = false;
  const fin = () => { if (!finished) { finished = true; onDone && onDone(); } };
  if (room.state !== 'playing' || !m.alive) { fin(); return; }
  // 怪物的"回合"开始：中毒掉血 / 被跳过
  if (m.poison > 0) {
    m.poison--;
    const real = dealDamage(room, m, 60, '☠️ 中毒');
    broadcast(room, 'poisonDmg', { monId: m.id, damage: real, hp: m.hp, alive: m.alive });
    broadcast(room, 'msg', { sys: true, text: `☠️ 中毒：${m.kind === 'boss' ? '👹Boss' : '👾小兵'} 损失 ${real} 生命` });
    if (!m.alive) { broadcastState(room); checkCardEnd(room); fin(); return; }
  }
  if (m.skip > 0) {
    m.skip--;
    broadcast(room, 'msg', { sys: true, text: `⏭️ ${m.kind === 'boss' ? '👹Boss' : '👾小兵'} 被跳过行动！` });
    broadcastState(room);
    fin();
    return;
  }
  // Boss每2次行动：发射一枚“小兵炮弹”（32tick抛射，落地生成小兵），本次不再攻击/移动
  if (m.kind === 'boss') {
    m.spawnCount = (m.spawnCount || 0) + 1;
    if (m.spawnCount % 2 === 0) { bossSpawnShot(room, m, fin); return; }
  }
  const targets = room.players.filter(p => !p.spectator && p.alive);
  if (!targets.length) { fin(); return; }
  let target = targets[0], best = Infinity;
  for (const p of targets) {
    const d = Math.abs(p.x - m.x);
    if (d < best) { best = d; target = p; }
  }
  let walkStarted = false;
  /** 近战攻击（起步在范围内与走到即砍共用） */
  const melee = (t) => {
    t.hp = Math.max(0, t.hp - m.dmg);
    const label = m.kind === 'boss' ? '👹Boss' : '👾小兵';
    broadcast(room, 'msg', { sys: true, text: `${label} 近战攻击 ${t.name}，造成 ${m.dmg} 伤害！` });
    if (t.hp <= 0) {
      t.alive = false;
      broadcast(room, 'msg', { sys: true, text: `💀 ${t.name} 被怪物击败了` });
    }
  };
  /** 玩家全灭检查（近战可能补刀，走完与行动收尾都要查） */
  const checkWipe = () => {
    const aliveP = room.players.filter(p => !p.spectator && p.alive);
    if (room.state === 'playing' && aliveP.length === 0) {
      endGame(room, '怪物军团', []);
      broadcast(room, 'msg', { sys: true, text: '💀 怪物军团获胜……' });
    }
  };
  /** 走路收尾：走到即砍——走完后若已进入攻击范围，本次行动立刻近战，再放行下一只 */
  const finishWalk = () => {
    let t2 = null, bd = Infinity;
    for (const p of room.players) {
      if (p.spectator || !p.alive) continue;
      const d = Math.abs(p.x - m.x);
      if (d < bd) { bd = d; t2 = p; }
    }
    if (t2 && bd <= m.range) {
      melee(t2);
      broadcast(room, 'monsters', { monsters: room.monsters });
      broadcastState(room);
      checkWipe();
    }
    fin();
  };
  if (best <= m.range) {
    melee(target);
  } else {
    // 走路：步频 tick节拍与炮弹/重力同钟；走到"刚好进入攻击范围"即停（best - range + 1），不越过玩家。
    // 墙体检测：每tick探测下一列自脚上8px起的承接面——高差≥8px视为陡壁，本tick不前进、
    // 垂直攀爬4px且同样消耗行动步数（预算耗尽仍贴墙则挂壁，climbing=true 免于重力，下轮从断点继续爬）；
    // 缓坡（0<高差<8）贴步而上；下坡/崖沿交给重力自然下落。修复城堡图怪物穿墙/被防卡死逻辑泵上墙顶。
    walkStarted = true;
    const TICK_MS = 1000 / 32;
    const WALK_TICKS = m.kind === 'boss' ? 24 : 32; // 小兵200px在32tick内走完（6.25px/tick），Boss 100px为24tick
    const PX_PER_TICK = m.speed / WALK_TICKS;
    const total = Math.min(m.speed, best - m.range + 1);
    const dirx = Math.sign(target.x - m.x) || 1;
    let walked = 0, tickGuard = 0;
    const iv = setInterval(() => {
      if (room.state !== 'playing' || !m.alive) { clearInterval(iv); m.climbing = false; fin(); return; }
      if (++tickGuard > 640) { clearInterval(iv); m.climbing = false; finishWalk(); return; } // 安全上限
      const probe = Math.round(Math.max(20, Math.min(WORLD_W - 20, m.x + dirx * PX_PER_TICK)));
      const g = groundBelow(room.mask, probe, m.y - 8);
      const rise = m.y - g; // 正值=前方承接面高于脚部
      if (rise >= 8) {
        // 陡壁：原地攀爬，不水平前进，攀爬消耗行动步数
        m.climbing = true;
        m.y = Math.max(30, m.y - 4);
        walked += 4;
        if (walked >= total) { clearInterval(iv); finishWalk(); } // climbing保留：挂壁待下轮继续
      } else {
        m.climbing = false;
        if (walked >= total) { clearInterval(iv); finishWalk(); return; }
        const step = Math.min(PX_PER_TICK, total - walked);
        m.x = Math.max(20, Math.min(WORLD_W - 20, m.x + dirx * step));
        if (rise > 0) m.y = g; // 缓坡/台阶贴上新地面
        walked += step;
      }
      broadcast(room, 'monsters', { monsters: room.monsters });
    }, TICK_MS);
    // 垂直下落交给重力系统处理（攀爬/挂壁中的怪物被重力跳过）
  }
  broadcast(room, 'monsters', { monsters: room.monsters });
  broadcastState(room);
  checkWipe();
  if (!walkStarted) fin(); // 近战等同步行动：收尾后立即放行；走路的在走完那一刻放行
}

/** 怪物阶段：逐只串行行动——上一只走完/打完/炮弹落地，下一只才开始；全部结束后才轮到玩家回合 */
function monsterPhase(room, done) {
  if (room.state !== 'playing') { done && done(); return; }
  const alive = (room.monsters || []).filter(m => m.alive);
  if (!alive.length) { done && done(); return; }
  broadcast(room, 'msg', { sys: true, text: '👾 怪物行动中…' });
  let i = 0;
  const next = () => {
    if (room.state !== 'playing') { done && done(); return; }
    while (i < alive.length && !alive[i].alive) i++; // 阶段中途阵亡的（如毒发）直接跳过
    if (i >= alive.length) { done && done(); return; }
    monsterActOne(room, alive[i++], next);
  };
  setTimeout(next, 600); // 阶段开场稍作停顿后开始第一只
}

/** 广播房间等待界面信息 */
function broadcastRoom(room) {
  io.to(room.id).emit('room', {
    id: room.id,
    state: room.state,
    mode: room.mode,
    map: room.map,
    hostSid: room.hostSid,
    players: room.players.map(p => ({ sid: p.sid, name: p.name, spectator: p.spectator, team: p.team, char: p.char || 0 })),
  });
}

/** 按玩家逐个下发房间状态，保证各自的 isYou 标记正确。
    withTerrain 仅在加入/重赛时为true：常规同步携带原始高度图会导致客户端把弹坑恢复原样 */
function broadcastState(room, withTerrain) {
  for (const p of room.players) io.to(p.sid).emit('state', publicRoom(room, p.sid, withTerrain));
}

/** 将玩家真正移出房间（主动离开、掉线宽限超时共用）：处理房主转移、判负/回等待、房间回收 */
function removePlayerFromRoom(room, p) {
  if (p.dcTimer) { clearTimeout(p.dcTimer); p.dcTimer = null; }
  const i = room.players.indexOf(p);
  if (i >= 0) {
    room.players.splice(i, 1);
    broadcast(room, 'msg', { sys: true, text: `${p.name} 离开了` });
  }
  if (p.token) sessions.delete(p.token);
  // 房主离开：转移给房间里的下一名玩家
  if (room.hostSid === p.sid) {
    room.hostSid = room.players.length ? room.players[0].sid : null;
    if (room.hostSid) broadcast(room, 'msg', { sys: true, text: `${room.players[0].name} 成为新房主` });
  }
  const active = room.players.filter(x => !x.spectator);
  if (room.state === 'playing') {
    if (room.mode === 'pve') {
      // PVE：只要还有玩家就继续
      if (active.length === 0) {
        room.state = 'waiting';
        clearInterval(room.timer);
        clearInterval(room.shotTimer);
        clearInterval(room.bossShotTimer);
        clearInterval(room.gravityTimer);
        broadcast(room, 'msg', { sys: true, text: '人数不足，回到等待中…' });
      }
    } else {
      // PVP：一方全部退出 → 剩余方直接获胜（退出者判负）；否则回到等待
      const aliveTeams = [0, 1].filter(t => active.some(x => x.team === t));
      if (active.length >= 1 && aliveTeams.length === 1) {
        const winTeam = aliveTeams[0];
        const winName = winTeam === 0 ? '红队' : '蓝队';
        const winners = active.filter(x => x.team === winTeam && x.alive).map(x => x.name);
        broadcast(room, 'msg', { sys: true, text: `🏃 对手退出对战，${winName} 直接获胜！` });
        endGame(room, winName, winners);
      } else if (active.length < 2 || aliveTeams.length < 2) {
        room.state = 'waiting';
        clearInterval(room.timer);
        clearInterval(room.shotTimer);
        clearInterval(room.bossShotTimer);
        clearInterval(room.gravityTimer);
        broadcast(room, 'msg', { sys: true, text: '人数不足，回到等待中…' });
      }
    }
    reorderRoom(room);
    room.turn = 0;
  }
  broadcastState(room);
  if (room.players.length === 0) {
    clearInterval(room.timer);
    clearInterval(room.shotTimer);
    clearInterval(room.bossShotTimer);
    clearInterval(room.gravityTimer);
    rooms.delete(room.id);
    const qi = waitingQueue.indexOf(room.id);
    if (qi >= 0) waitingQueue.splice(qi, 1);
  } else {
    broadcastRoom(room);
  }
}

/** 碰撞掩码游程编码：0/1两值成对输出[值,长度,...]，数百万像素压缩为数KB */
function rleMask(mask) {
  const out = [];
  let v = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    const cur = mask[i] ? 1 : 0;
    if (cur === v) n++;
    else { out.push(v, n); v = cur; n = 1; }
  }
  out.push(v, n);
  return out;
}

function publicRoom(room, forSid, withTerrain) {
  const o = {
    id: room.id,
    state: room.state,
    mode: room.mode,
    map: room.map,
    wind: room.wind,
    turn: room.turn,
    timeLeft: room.timeLeft,
    monsters: room.monsters,
    players: room.players.map((p, i) => ({
      slot: i, name: p.name, x: Math.round(p.x), y: Math.round(p.y),
      hp: p.hp, alive: p.alive, isYou: p.sid === forSid, dir: p.dir, team: p.team, char: p.char || 0,
      spectator: !!p.spectator,
      shield: p.shield || 0, poison: p.poison || 0, berserk: p.berserk || 0, fortress: p.fortress || 0,
      revenge: p.revenge || 0, dc: !!p.disconnected,
      points: p.points || 0, extraShots: p.extraShots || 0, critBonus: p.critBonus || 0, dmgPct: p.dmgPct || 0, flatDmg: p.flatDmg || 0,
    })),
  };
  if (withTerrain) {
    // 原始高度（而非被弹坑改写的投影高度）：客户端用它重建出与开局一致的贴图，
    // 真实弹坑/被破坏平台由像素级掩码 maskRuns 还原，避免重建后地形断裂错位
    o.terrain = Array.from(room.terrain0 || room.terrain);
    o.platforms = room.platforms;
    if (room.mask) o.maskRuns = rleMask(room.mask);
  }
  return o;
}

/** 重排玩家数组：对战玩家按 A/B 队交错排列（决定行动顺序），观战者在末尾 */
function reorderRoom(room) {
  const actives = room.players.filter(p => !p.spectator);
  const specs = room.players.filter(p => p.spectator);
  const t0 = actives.filter(p => p.team === 0), t1 = actives.filter(p => p.team === 1);
  const ordered = [];
  for (let i = 0; i < TEAM_SIZE; i++) {
    if (t0[i]) ordered.push(t0[i]);
    if (t1[i]) ordered.push(t1[i]);
  }
  room.players = ordered.concat(specs);
}

function broadcast(room, ev, data) {
  io.to(room.id).emit(ev, data);
}

function addPlayerToRoom(room, sid, name, forceSpectator) {
  const active = room.players.filter(p => !p.spectator);
  // 游戏已开始（或已结束未重开）的房间、主动观战、或满员时只能观战
  const spectator = forceSpectator || room.state !== 'waiting' || active.length >= TEAM_SIZE * 2;
  const teamCounts = [0, 1].map(t => active.filter(p => p.team === t && !p.spectator).length);
  // PVE：全员同队（红队），并肩对抗怪物
  const team = room.mode === 'pve' ? 0 : (teamCounts[0] <= teamCounts[1] ? 0 : 1);
  const idxInTeam = teamCounts[team];
  const p = {
    sid, name, spectator, team,
    x: 0, y: 0, hp: MAX_HP, alive: true,
    angle: 45, power: 40, dir: 1, moveBudget: MOVE_BUDGET, fired: false,
    char: Math.floor(Math.random() * 4), // 角色形象（0~3），房间内可改
    slots: [null, null], cardChoice: null, cardPlayed: false, deckUsed: false, // 卡牌：双卡槽+牌堆整局限抽一次（开局/重开时发随机卡）
    shield: 0, berserk: 0, revenge: 0, fortress: 0, poison: 0, skip: 0, // 增减益（revenge为层数，可叠加）
    trueDmg: 0, hitPoison: 0, bloodUsed: false, // 卡牌：炮弹附加真实伤害/命中涂毒（层数，可叠加）/血契一次性
    points: 0,                            // 积分（每回合+100）
    extraShots: 0, critBonus: 0, dmgPct: 0, flatDmg: 0, // 积分强化
    lifesteal: 0, pierceEdge: false, doubleBoom: false,   // 积分强化（机制型）
  };
  if (!spectator) {
    if (room.mode === 'pve') {
      // PVE：玩家全部在左侧营地
      p.x = 260 + idxInTeam * 100 + Math.random() * 40;
      p.dir = 1;
    } else if (team === 0) {
      // PVP：队伍0在左侧，队伍1在右侧
      p.x = 260 + idxInTeam * 90 + Math.random() * 30;
      p.dir = 1;
    } else {
      p.x = WORLD_W - 260 - idxInTeam * 90 - Math.random() * 30;
      p.dir = -1;
    }
    p.y = groundY(room.terrain, p.x); // 初始生成时高度图与网格一致
  }
  room.players.push(p);
  if (!room.hostSid) room.hostSid = sid; // 第一个进房间的是房主
  reorderRoom(room);
  return p;
}

function placeOnGround(room, p) {
  p.y = groundBelow(room.mask, p.x, p.y - 8);
}

/** 通用伤害结算：堡垒减伤 → 护盾格挡 → 扣血/死亡，返回实际伤害 */
function dealDamage(room, target, amount, srcLabel) {
  if (!target.alive || amount <= 0) return 0;
  let dmg = amount;
  if (target.fortress > 0) {
    dmg = Math.max(1, Math.round(dmg * 0.75));
    broadcast(room, 'msg', { sys: true, text: `🏰 Fortress：${srcLabel || '伤害'}被减免25% → ${dmg}` });
  }
  if (target.shield > 0 && dmg > 0) {
    const abs = Math.min(target.shield, dmg);
    target.shield -= abs;
    dmg -= abs;
    if (abs > 0) broadcast(room, 'msg', { sys: true, text: `🛡️ 护盾格挡了 ${abs} 点伤害（剩余 ${target.shield}）` });
  }
  if (dmg <= 0) return 0;
  target.hp = Math.max(0, target.hp - dmg);
  if (target.hp <= 0 && target.alive) {
    target.alive = false;
    const nm = target.kind ? (target.kind === 'boss' ? '👹Boss' : '👾小兵') : target.name;
    broadcast(room, 'msg', { sys: true, text: `💀 ${nm} 阵亡了` });
  }
  return dmg;
}

/** 离 p 最近的存活敌人：PVE为最近怪物，PVP为最近敌方玩家 */
function nearestEnemy(room, p) {
  if (room.mode === 'pve') {
    let best = null, bd = Infinity;
    for (const m of room.monsters || []) {
      if (!m.alive) continue;
      const d = Math.abs(m.x - p.x);
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }
  let best = null, bd = Infinity;
  for (const q of room.players) {
    if (q.spectator || !q.alive || q.team === p.team) continue;
    const d = Math.abs(q.x - p.x);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}

/** 卡牌造成的死亡后检查胜负（与炮弹结算的胜负逻辑一致） */
function checkCardEnd(room) {
  if (room.state !== 'playing') return;
  if (room.mode === 'pve') {
    if (room.monsters.length && room.monsters.every(m => !m.alive)) {
      const survivors = room.players.filter(p => !p.spectator && p.alive).map(p => p.name);
      endGame(room, '玩家队', survivors);
      broadcast(room, 'msg', { sys: true, text: `🏆 玩家队获胜！怪物全灭！（${survivors.join('、') || '无'}）` });
    } else if (!room.players.some(p => !p.spectator && p.alive)) {
      endGame(room, '怪物军团', []);
      broadcast(room, 'msg', { sys: true, text: '💀 怪物军团获胜……' });
    }
  } else {
    const actives = room.players.filter(p => !p.spectator);
    const aliveByTeam = [0, 1].map(t => actives.filter(p => p.team === t && p.alive));
    if (aliveByTeam[0].length === 0 || aliveByTeam[1].length === 0) {
      const winners = aliveByTeam[0].length ? aliveByTeam[0] : aliveByTeam[1];
      const winTeam = winners.length && winners[0].team === 0 ? '红队' : '蓝队';
      endGame(room, winTeam, winners.map(p => p.name));
      broadcast(room, 'msg', { sys: true, text: `🏆 ${winTeam}获胜！(${winners.map(p => p.name).join('、')})` });
    }
  }
}

/** 打出一张卡牌 */
function applyCard(room, p, id) {
  const enemy = nearestEnemy(room, p);
  const ename = enemy ? (enemy.kind ? (enemy.kind === 'boss' ? '👹Boss' : '👾小兵') : enemy.name) : '';
  switch (id) {
    case 'heal':
      p.hp = Math.min(MAX_HP, p.hp + 250);
      broadcast(room, 'msg', { sys: true, text: `💚 ${p.name} 恢复了 250 生命（${p.hp}）` });
      break;
    case 'shield':
      p.shield += 250;
      broadcast(room, 'msg', { sys: true, text: `🛡️ ${p.name} 获得护盾（可格挡 ${p.shield} 伤害）` });
      break;
    case 'double':
      p.trueDmg = (p.trueDmg || 0) + 120;
      broadcast(room, 'msg', { sys: true, text: `💥 ${p.name} 的下一次炮击将额外造成 120 点真实伤害（不受任何加成影响）` });
      break;
    case 'revenge':
      p.revenge = (p.revenge || 0) + 1; // 层数叠加：下一炮每层+100
      broadcast(room, 'msg', { sys: true, text: `🎯 ${p.name} 的下一次炮击伤害 +${100 * p.revenge}${p.revenge > 1 ? `（${p.revenge} 层复仇叠加）` : ''}` });
      break;
    case 'poison':
      p.hitPoison = (p.hitPoison || 0) + 1; // 层数叠加：命中时每层独立结算毒伤与持续回合
      broadcast(room, 'msg', { sys: true, text: `☠️ ${p.name} 的下一次炮弹命中将涂毒：目标 120 毒伤，之后每回合 60 共 2 回合${p.hitPoison > 1 ? `（已叠 ${p.hitPoison} 层）` : ''}` });
      break;
    case 'bloodpact':
      p.trueDmg = (p.trueDmg || 0) + 280;
      p.bloodUsed = true; // 一次性卡：用后不再出现在候选中
      p.hp = Math.max(1, p.hp - 150); // 生命不足时保留1点
      broadcast(room, 'msg', { sys: true, text: `🏹 ${p.name} 签订血契：下一次炮击额外 280 真实伤害，消耗 150 生命（剩余 ${p.hp}）` });
      break;
    case 'berserk':
      p.berserk = 3;
      broadcast(room, 'msg', { sys: true, text: `🔥 ${p.name} 进入狂暴：3 回合内炮击伤害 +70` });
      break;
    case 'fortress':
      p.fortress = 3;
      broadcast(room, 'msg', { sys: true, text: `🏰 ${p.name} 进入堡垒状态：3 回合内受到的伤害降低 25%` });
      break;
  }
}

function startTurn(room) {
  if (room.state !== 'playing') return;
  const active = room.players.filter(p => !p.spectator);
  const alive = active.filter(p => p.alive);
  const minPlayers = room.mode === 'pve' ? 1 : 2;
  if (alive.length < minPlayers) {
    if (alive.length === 0) {
      // 所有玩家阵亡（怪物阶段杀死的最后一人）
      if (room.mode === 'pve') {
        endGame(room, '怪物军团', []);
        broadcast(room, 'msg', { sys: true, text: '💀 怪物军团获胜……' });
      } else {
        const teamAlive = [0, 1].filter(t => active.some(p => p.team === t && p.alive));
        if (teamAlive.length === 0) {
          endGame(room, '平局', []);
          broadcast(room, 'msg', { sys: true, text: '💀 双方全灭，平局！' });
        } else {
          const winTeam = teamAlive[0] === 0 ? '红队' : '蓝队';
          const winners = active.filter(p => p.team === teamAlive[0] && p.alive);
          endGame(room, winTeam, winners.map(p => p.name));
          broadcast(room, 'msg', { sys: true, text: `🏆 ${winTeam}获胜！` });
        }
      }
    } else {
      room.state = 'waiting';
      clearInterval(room.gravityTimer);
      broadcast(room, 'msg', { sys: true, text: '人数不足，回到等待中…' });
    }
    return;
  }
  room.turn = room.turn % active.length;
  const p = active[room.turn];
  p.moveBudget = MOVE_BUDGET;
  p.fired = false; // 新回合重置开火标记

  // 回合开始结算：中毒（在自己回合掉血）与堡垒衰减
  if (p.poison > 0) {
    p.poison--;
    const real = dealDamage(room, p, 60, '☠️ 中毒');
    // 毒伤飘字（紫色，客户端错开炮弹伤害的位置显示）
    broadcast(room, 'poisonDmg', { slot: room.players.indexOf(p), damage: real, hp: p.hp, alive: p.alive });
  }
  if (p.fortress > 0) p.fortress--;
  if (!p.alive) { // 中毒致死
    broadcastState(room);
    checkCardEnd(room);
    if (room.state === 'playing') nextTurn(room);
    return;
  }
  // 被跳过回合：不能攻击也不能出牌
  const skipped = p.skip > 0;
  if (skipped) {
    p.skip--;
    p.fired = true;
    broadcast(room, 'msg', { sys: true, text: `⏭️ ${p.name} 被跳过回合，无法攻击！` });
  }

  // 卡牌：跳过回合时不能出牌；卡槽状态跨回合保留（双卡槽制，不再每回合发牌）
  p.cardPlayed = skipped;
  // 强化只生效一回合：回合开始时清空上一回合购买的强化
  p.extraShots = 0; p.critBonus = 0; p.dmgPct = 0; p.flatDmg = 0;
  p.lifesteal = 0; p.pierceEdge = false; p.doubleBoom = false;
  p.points += 100; // 每回合开始获得100积分
  room.wind = +(Math.random() * 10 - 5).toFixed(1);
  room.timeLeft = TURN_TIME;
  clearInterval(room.timer);
  room.timer = setInterval(() => {
    room.timeLeft--;
    broadcast(room, 'timer', room.timeLeft);
    if (room.timeLeft <= 0) {
      clearInterval(room.timer);
      broadcast(room, 'msg', { sys: true, text: `${p.name} 超时，回合结束` });
      broadcast(room, 'turnEnd', {});
      nextTurn(room);
    }
  }, 1000);
  broadcast(room, 'turn', {
    turn: room.turn,
    sid: p.sid,
    name: p.name,
    team: p.team,
    wind: room.wind,
    timeLeft: room.timeLeft,
    points: p.points,
    extraShots: p.extraShots || 0,
    critBonus: p.critBonus || 0,
    dmgPct: p.dmgPct || 0,
    flatDmg: p.flatDmg || 0,
  });
}

function endGame(room, winner, names) {
  room.state = 'over';
  clearInterval(room.timer);
  clearInterval(room.shotTimer);
  clearInterval(room.bossShotTimer);
  broadcast(room, 'gameover', { winner, names });
  broadcastRoom(room);
}

function nextTurn(room) {
  const active = room.players.filter(p => !p.spectator);
  const alive = active.filter(p => p.alive);
  if (!alive.length) {
    // 所有对战玩家已阵亡
    if (room.mode === 'pve') {
      endGame(room, '怪物军团', []);
      broadcast(room, 'msg', { sys: true, text: '💀 怪物军团获胜……' });
    } else {
      endGame(room, '平局', []);
      broadcast(room, 'msg', { sys: true, text: '💀 双方全灭，平局！' });
    }
    return;
  }
  // 跳过已阵亡玩家，最多绕一圈
  for (let i = 0; i < active.length; i++) {
    room.turn = (room.turn + 1) % active.length;
    if (active[room.turn].alive) break;
  }
  // 无论玩家是开火还是超时，怪物阶段都会执行
  monsterPhase(room, () => {
    if (room.state === 'playing') startTurn(room);
  });
}

function fire(room, shooter) {
  const rad = (shooter.angle * Math.PI) / 180;
  const speed = shooter.power * 0.1425; // 满力速度降低25%，弹道更易观察
  const dir = shooter.dir || 1;
  // 发射方向 = 世界仰角φ（φ = 坡度倾角tilt + 局部瞄准角，钳制到 [-30, 90]），与客户端换算一致
  const xa = Math.max(0, Math.min(WORLD_W - 1, Math.round(shooter.x - 14)));
  const xb = Math.max(0, Math.min(WORLD_W - 1, Math.round(shooter.x + 14)));
  let ya = groundBelow(room.mask, xa, shooter.y - 8), yb = groundBelow(room.mask, xb, shooter.y - 8);
  let tilt = (ya >= WORLD_H || yb >= WORLD_H) ? 0 : Math.atan2(ya - yb, xb - xa) * 180 / Math.PI;
  tilt *= dir; // 面朝上坡为正
  const phi = tilt + shooter.angle; // 最终世界仰角 = 坡度 + 局部瞄准角，无额外限制
  const phiRad = phi * Math.PI / 180;
  const bx = shooter.x + Math.cos(phiRad) * 22 * dir;
  const by = shooter.y - Math.sin(phiRad) * 22;
  const vx0 = Math.cos(phiRad) * speed * dir;
  const vy0 = -Math.sin(phiRad) * speed;

  broadcast(room, 'msg', { sys: true, text: `${shooter.name} 发射！(角度${shooter.angle} 力度${shooter.power})` });

  // 角色被动：
  // one(0)：大范围爆炸 | two(1)：15%暴击(+50%伤害) | three(2)：炮弹追踪吸附 | four(3)：一次三发
  const ch = shooter.char || 0;
  const bulletR = ch === 1 || ch === 2 || ch === 3 ? 8 : 0;
  const expR = ch === 0 ? Math.round(EXPLODE_R * 1.4) : EXPLODE_R;
  const homing = ch === 2;
  // 基础伤害系数（平衡命中优势）：鹰眼必中减伤、疾风三连发每发减伤
  const baseMult = ch === 2 ? 0.75 : ch === 3 ? 0.45 : 1.0;
  // 卡牌附加效果（Double/BloodPact真实伤害、Poison涂毒）：本volley内每个目标只结算一次
  const onHitDone = new Set();
  // 附加伤害飘字需进入当前爆炸的 boomFx 载荷（dmgList/mDmgList）；不在爆炸结算期间则回退到回合汇总
  let curLists = null;
  const applyOnHit = (target, isMonster) => {
    const key = (isMonster ? 'm' + target.id : 'p' + target.sid);
    if (onHitDone.has(key)) return;
    onHitDone.add(key);
    if (!target.alive && target.alive !== undefined) return;
    if (shooter.trueDmg > 0) {
      // 真实伤害：直接扣血，无视护盾/堡垒/暴击/强化等一切加成
      target.hp = Math.max(0, target.hp - shooter.trueDmg);
      const nm = isMonster ? (target.kind === 'boss' ? '👹Boss' : '👾小兵') : target.name;
      broadcast(room, 'msg', { sys: true, text: `⚡ 真实伤害：${nm} 受到 ${shooter.trueDmg} 点无视减伤的伤害` });
      if (isMonster) { const e = { id: target.id, x: Math.round(target.x), y: Math.round(target.y - target.r * 2.6), damage: shooter.trueDmg, crit: false, tag: 'true' }; mDmg.push(e); if (curLists) curLists.mDmgList.push(e); }
      else { const e = { slot: room.players.indexOf(target), damage: shooter.trueDmg, hp: target.hp, alive: target.alive, crit: false, tag: 'true' }; dmg.push(e); if (curLists) curLists.dmgList.push(e); }
      if (target.hp <= 0 && target.alive) {
        target.alive = false;
        broadcast(room, 'msg', { sys: true, text: `💀 ${nm} 阵亡了` });
      }
    }
    if (shooter.hitPoison > 0 && target.hp > 0) {
      const n = shooter.hitPoison; // 层数叠加：每层独立 120 毒伤 + 2 回合持续毒
      const pdmg = 120 * n;
      target.hp = Math.max(0, target.hp - pdmg);
      target.poison = 2 * n;
      const nm = isMonster ? (target.kind === 'boss' ? '👹Boss' : '👾小兵') : target.name;
      broadcast(room, 'msg', { sys: true, text: `☠️ ${nm} 中毒：${pdmg} 毒伤，之后每回合 60 共 ${2 * n} 回合${n > 1 ? `（${n} 层毒叠加）` : ''}` });
      if (isMonster) { const e = { id: target.id, x: Math.round(target.x), y: Math.round(target.y - target.r * 2.6), damage: pdmg, crit: false, tag: 'poison' }; mDmg.push(e); if (curLists) curLists.mDmgList.push(e); }
      else { const e = { slot: room.players.indexOf(target), damage: pdmg, hp: target.hp, alive: target.alive, crit: false, tag: 'poison' }; dmg.push(e); if (curLists) curLists.dmgList.push(e); }
      if (target.hp <= 0 && target.alive) {
        target.alive = false;
        broadcast(room, 'msg', { sys: true, text: `💀 ${nm} 阵亡了` });
      }
    }
  };
  const HOMING_R = 150;
  const spread = ch === 3 ? [-0.14, 0, 0.14] : [0];

  // 强化A：每级追加一个发射物（30%伤害，可暴击）
  const shotDefs = spread.map(off => ({ off, factor: 1 }));
  for (let i = 0; i < (shooter.extraShots || 0); i++) {
    shotDefs.push({ off: 0.06 * Math.ceil((i + 1) / 2) * (i % 2 === 0 ? -1 : 1), factor: 0.3 });
  }

  // 每发发射物独立模拟
  const shots = shotDefs.map(sd => {
    const cos = Math.cos(sd.off), sin = Math.sin(sd.off);
    return { x: bx, y: by, vx: vx0 * cos - vy0 * sin, vy: vx0 * sin + vy0 * cos, done: false, step: 0, factor: sd.factor };
  });
  // 子弹时间：timeScale=0.65 表示物理时间流速放慢，弹道形状/落点不变
  const timeScale = 0.65;
  broadcast(room, 'shotBegin', {
    char: ch,
    ts: timeScale,
    shots: shots.map(s => ({ x: +s.x.toFixed(1), y: +s.y.toFixed(1), vx: +s.vx.toFixed(2), vy: +s.vy.toFixed(2) })),
  });

  // 服务器权威逐帧模拟：32 tick/秒，每 tick 推进 3 个物理步
  const TICK_MS = 1000 / 32;
  const STEPS_PER_TICK = 3;
  const explosions = [], dmg = [], mDmg = [], terrainRuns = [];
  let crit = false, lsGain = 0, boomDone = false, pendingBoom = null;

  /** 一次爆炸结算（挖弹坑+伤害）：主爆炸与二次爆破共用，返回实际伤害总和 */
  const explodeAt = (ex, ey, R, dmgRatio, tag = '') => {
    const runList = [];
    const runs = carveMask(room.mask, ex, ey, R);
    terrainRuns.push(...runs);
    runList.push(...runs);
    for (const r of runs) {
      const ts = topSolid(room.mask, r.x);
      if (ts > room.terrain[r.x]) room.terrain[r.x] = ts;
    }
    let sum = 0;
    const dmgList = [], mDmgList = [];
    const isCrit = Math.random() < ((ch === 1 ? 0.15 : 0) + (shooter.critBonus || 0));
    if (isCrit) crit = true;
    const mult = (isCrit ? 1.5 : 1) * dmgRatio;
    // 精准(i)：不受距离衰减
    const falloff = (dist) => shooter.pierceEdge ? 1 : Math.max(0, 1 - 0.5 * dist / R);
    curLists = { dmgList, mDmgList };
    for (const p of room.players) {
      if (p.spectator || !p.alive) continue;
      const ccP = colCenter(room, p.x, p.y, 26);
      const dist = Math.max(0, Math.hypot(p.x - ex, ccP.cy - ey) - TANK_R);
      if (dist < R) {
        // 敌方目标被炮弹命中：结算卡牌附加（真实伤害/涂毒），队友与自己不触发
        if (p !== shooter && (room.mode === 'pve' || p.team !== shooter.team)) applyOnHit(p, false);
        let d = Math.round(MAX_DMG * falloff(dist) * baseMult);
        if (shooter.berserk > 0) d += 70;
        d += 100 * (shooter.revenge || 0);
        d += shooter.flatDmg || 0;
        d = Math.round(d * (1 + (shooter.dmgPct || 0)) * mult);
        if (d > 0) {
          const real = dealDamage(room, p, d, `${shooter.name} 的炮击`);
          if (real > 0) {
            broadcast(room, 'msg', { sys: true, text: `🎯 ${p.name} 受到 ${real} 点爆炸伤害（爆炸点 x=${Math.round(ex)}，你位于 x=${Math.round(p.x)}, y=${Math.round(p.y)}）` });
            const e = { slot: room.players.indexOf(p), damage: real, hp: p.hp, alive: p.alive, crit: isCrit, tag }; dmg.push(e); dmgList.push(e); sum += real;
          }
        }
      }
    }
    for (const m of room.monsters || []) {
      if (!m.alive) continue;
      const mcc = colCenter(room, m.x, m.y, m.r * 1.3);
      // 与玩家结算口径一致：减去怪物自身半径，否则炮弹擦到Boss边缘/在其脚边地形引爆时
      // （爆炸点距中心55~90px）视觉上命中、判定上却是0伤害。Boss半径大，此问题最明显
      const dist = Math.max(0, Math.hypot(m.x - ex, mcc.cy - ey) - m.r);
      if (dist < R) {
        applyOnHit(m, true); // 怪物被炮弹命中：结算卡牌附加（真实伤害/涂毒）
        // 小兵不再有额外减伤；Boss保留0.8系数（更耐打）
        const tankMult = m.kind === 'boss' ? 0.8 : 1.0;
        let d = Math.round(MAX_DMG * tankMult * falloff(dist) * baseMult);
        if (shooter.berserk > 0) d += 70;
        d += 100 * (shooter.revenge || 0);
        d += shooter.flatDmg || 0;
        d = Math.round(d * (1 + (shooter.dmgPct || 0)) * mult);
        if (d > 0) {
          m.hp = Math.max(0, m.hp - d);
          const me2 = { id: m.id, x: Math.round(m.x), y: Math.round(m.y - m.r * 2.6) + (tag === 'boom2' ? 18 : 0), damage: d, crit: isCrit, tag };
          mDmg.push(me2); mDmgList.push(me2);
          sum += d;
          if (m.hp <= 0) {
            m.alive = false;
            broadcast(room, 'msg', { sys: true, text: `💥 ${m.kind === 'boss' ? '👹Boss' : '👾小兵'} 被消灭了！` });
          }
        }
      }
    }
    if (shooter.berserk > 0) shooter.berserk--;
    if (shooter.revenge) shooter.revenge = 0; // 复仇层数随下一次炮击全部消耗
    curLists = null;
    return { sum, crit: isCrit, dmg: dmgList, mDmg: mDmgList, runs: runList };
  };

  /** 单发命中结算：挖弹坑、结算伤害 */
  const impact = (s) => {
    s.done = true;
    const ex = s.x, ey = s.y;
    const res = explodeAt(ex, ey, expR, s.factor || 1);
    lsGain += res.sum;
    explosions.push({ x: +ex.toFixed(1), y: +ey.toFixed(1), r: expR, tag: '' });
    broadcast(room, 'boomFx', {
      x: +ex.toFixed(1), y: +ey.toFixed(1), r: expR, char: ch, crit: res.crit,
      dmg: res.dmg, mDmg: res.mDmg, runs: res.runs,
    });
    // 二次爆破(f)：24 tick后引爆，中心沿弹道方向前移40px（覆盖主爆炸之外的纵深带）
    if (shooter.doubleBoom && !boomDone) {
      boomDone = true;
      const vl = Math.hypot(s.vx, s.vy) || 1;
      pendingBoom = { x: ex + (s.vx / vl) * 40, y: ey + (s.vy / vl) * 40, ticks: 24 };
    }
  };

  /** 追踪（four/疾风）：一定范围内优先选择飞行方向前方的最近敌人，避免被身后更近的怪把弹道拉回头 */
  const steerHoming = (s) => {
    let tx = null, ty = null, bd = HOMING_R, fwdTx = null, fwdTy = null, fwdBd = HOMING_R;
    const consider = (cx, cy) => {
      const dx = cx - s.x, dy = cy - s.y;
      const d = Math.hypot(dx, dy);
      if (d >= bd) return;
      bd = d; tx = cx; ty = cy;
      if (dx * s.vx + dy * s.vy > 0 && d < fwdBd) { fwdBd = d; fwdTx = cx; fwdTy = cy; } // 前方（与速度同向）目标
    };
    if (room.mode === 'pve') {
      for (const m of room.monsters || []) {
        if (!m.alive) continue;
        const cc = colCenter(room, m.x, m.y, m.r * 1.3);
        consider(cc.cx, cc.cy);
      }
    } else {
      for (const p of room.players) {
        if (p.spectator || !p.alive || p === shooter || p.team === shooter.team) continue;
        const cc = colCenter(room, p.x, p.y, 26);
        consider(cc.cx, cc.cy);
      }
    }
    if (fwdTx !== null) { tx = fwdTx; ty = fwdTy; } // 有前方目标时优先，绝不往回拉
    if (tx !== null) {
      const dx = tx - s.x, dy = ty - s.y;
      const dl = Math.hypot(dx, dy) || 1;
      const sp = Math.hypot(s.vx, s.vy) || 1;
      const k = 0.15 * timeScale; // 吸附强度（随子弹时间同步缩放）
      s.vx += (dx / dl * sp - s.vx) * k;
      s.vy += (dy / dl * sp - s.vy) * k;
    }
  };

  const endShot = () => {
    clearInterval(room.shotTimer);
    room.shotTimer = null;
    // 卡牌附加效果随本次炮击结束而消耗（一次性）
    shooter.trueDmg = 0;
    shooter.hitPoison = 0;
    // 汲血(g)：本次炮击总伤害的30%转化为生命
    if (shooter.alive && shooter.lifesteal > 0 && lsGain > 0) {
      const heal = Math.min(MAX_HP - shooter.hp, Math.round(lsGain * shooter.lifesteal));
      if (heal > 0) {
        shooter.hp += heal;
        broadcast(room, 'msg', { sys: true, text: `🩸 ${shooter.name} 汲血恢复 ${heal} 生命（${shooter.hp}）` });
      }
    }
    broadcast(room, 'shotEnd', {
      explosions,
      terrainRuns,
      damage: dmg,
      mDmg,
      crit,
      monsters: room.monsters,
      positions: room.players.filter(p => !p.spectator).map(p => ({ slot: room.players.indexOf(p), x: +p.x.toFixed(1), y: +p.y.toFixed(1) })),
    });

    // PVE胜负：怪物全灭 → 玩家获胜
    if (room.mode === 'pve') {
      if (room.state === 'playing' && room.monsters.length && room.monsters.every(m => !m.alive)) {
        const survivors = room.players.filter(p => !p.spectator && p.alive).map(p => p.name);
        endGame(room, '玩家队', survivors);
        broadcast(room, 'msg', { sys: true, text: `🏆 玩家队获胜！怪物全灭！（${survivors.join('、') || '无'}）` });
        return;
      }
    } else {
      // PVP胜负：某一队全灭则另一队获胜
      const actives = room.players.filter(p => !p.spectator);
      const aliveByTeam = [0, 1].map(t => actives.filter(p => p.team === t && p.alive));
      if (room.state === 'playing' && (aliveByTeam[0].length === 0 || aliveByTeam[1].length === 0)) {
        const winners = aliveByTeam[0].length ? aliveByTeam[0] : aliveByTeam[1];
        const winTeam = winners.length && winners[0].team === 0 ? '红队' : '蓝队';
        endGame(room, winTeam, winners.map(p => p.name));
        broadcast(room, 'msg', { sys: true, text: `🏆 ${winTeam}获胜！(${winners.map(p => p.name).join('、')})` });
        return;
      }
    }
    // 稍等爆炸播完再交棒；怪物阶段由 nextTurn 统一触发，避免怪物一回合连动两次
    setTimeout(() => {
      if (room.state === 'playing') nextTurn(room);
    }, 1500);
  };

  room.shotTimer = setInterval(() => {
    // 每tick预算一次所有实体的旋转碰撞圆心
    const pcc = new Map(), mcc = new Map();
    for (const p of room.players) if (!p.spectator && p.alive) pcc.set(p, colCenter(room, p.x, p.y, 26));
    for (const m of room.monsters || []) if (m.alive) mcc.set(m, colCenter(room, m.x, m.y, m.r * 1.3));
    for (const s of shots) {
      if (s.done) continue;
      for (let i = 0; i < STEPS_PER_TICK && !s.done; i++) {
        s.step++;
        if (homing) steerHoming(s);
        s.x += s.vx * 0.7 * timeScale;
        s.y += s.vy * 0.7 * timeScale;
        s.vy += GRAVITY * 0.7 * timeScale;
        s.x += room.wind * 0.012 * timeScale;
        if (s.x < -200 || s.x > WORLD_W + 200 || s.y > WORLD_H + 100) { s.done = true; break; }
        // 命中玩家
        for (const p of room.players) {
          if (p.spectator || !p.alive) continue;
          const ccP = pcc.get(p);
          const dx = s.x - ccP.cx, dy = s.y - ccP.cy;
          if (dx * dx + dy * dy < (TANK_R + 6) * (TANK_R + 6) && p !== shooter) {
            impact(s); break;
          }
        }
        if (s.done) break;
        // 命中自己（延迟几步防止刚出手就打自己）
        if (s.step > 12) {
          for (const p of room.players) {
            if (p.spectator || !p.alive || p !== shooter) continue;
            const ccP = pcc.get(p);
            const dx = s.x - ccP.cx, dy = s.y - ccP.cy;
            if (dx * dx + dy * dy < (TANK_R + 4) * (TANK_R + 4)) { impact(s); break; }
          }
          if (s.done) break;
        }
        // 命中怪物（PVE）
        for (const m of room.monsters || []) {
          if (!m.alive) continue;
          const ccM = mcc.get(m);
          const dx = s.x - ccM.cx, dy = s.y - ccM.cy;
          if (dx * dx + dy * dy < (m.r + 8) * (m.r + 8)) { impact(s); break; }
        }
        if (s.done) break;
        // 地形碰撞：大弹体沿速度垂直方向采样三点，小弹体只测中心点
        if (s.step > 6) {
          if (bulletR > 0) {
            const vl = Math.hypot(s.vx, s.vy) || 1;
            const ox = (-s.vy / vl) * bulletR, oy = (s.vx / vl) * bulletR;
            if (solidIn(room.mask, Math.round(s.x), Math.round(s.y)) ||
                solidIn(room.mask, Math.round(s.x + ox), Math.round(s.y + oy)) ||
                solidIn(room.mask, Math.round(s.x - ox), Math.round(s.y - oy))) {
              impact(s); break;
            }
          } else if (solidIn(room.mask, Math.round(s.x), Math.round(s.y))) {
            impact(s); break;
          }
          if (s.step >= 4000) { s.done = true; break; }
        }
      }
    }
    // 二次爆破倒计时（tick计量）
    if (pendingBoom && --pendingBoom.ticks <= 0) {
      const res = explodeAt(pendingBoom.x, pendingBoom.y, 40, 0.4, 'boom2');
      lsGain += res.sum;
      explosions.push({ x: +pendingBoom.x.toFixed(1), y: +pendingBoom.y.toFixed(1), r: 40, tag: 'boom2' });
      broadcast(room, 'boomFx', {
        x: +pendingBoom.x.toFixed(1), y: +pendingBoom.y.toFixed(1), r: 40, char: ch, crit: res.crit,
        dmg: res.dmg, mDmg: res.mDmg, runs: res.runs,
      });
      broadcast(room, 'msg', { sys: true, text: `💥 二次爆破！` });
      pendingBoom = null;
    }
    if (shots.every(s => s.done) && !pendingBoom) { endShot(); return; }
    broadcast(room, 'shotTick', {
      pts: shots.map(s => ({ x: +s.x.toFixed(1), y: +s.y.toFixed(1), vx: s.done ? 0 : +s.vx.toFixed(2), vy: s.done ? 0 : +s.vy.toFixed(2), done: s.done })),
    });
  }, TICK_MS);
}

io.on('connection', (socket) => {
  let curRoom = null, me = null;
  socket.data.name = randomName();
  // 会话令牌：重连时用它找回掉线玩家（socket.id 每次连接都会变）
  const myToken = crypto.randomUUID();
  socket.emit('session', { token: myToken });

  socket.on('setChar', (n) => {
    if (!curRoom || !me) return;
    if (curRoom.state !== 'waiting') { socket.emit('err', '游戏开始后不能更换角色'); return; }
    me.char = Math.max(0, Math.min(3, +n || 0));
    broadcastRoom(curRoom);
    broadcastState(curRoom);
  });

  socket.on('rename', (n) => {
    n = String(n || '').trim().slice(0, 12);
    if (n) socket.data.name = n;
    socket.emit('renamed', socket.data.name);
  });

  socket.emit('lobby', { rooms: roomList(), yourName: socket.data.name });

  socket.on('lobbyRefresh', () => socket.emit('lobby', { rooms: roomList(), yourName: socket.data.name }));

  function roomList() {
    return [...rooms.values()]
      .filter(r => Date.now() - r.createdAt < ROOM_LIFE && r.players.length > 0)
      .map(r => ({ id: r.id, count: r.players.filter(p => !p.spectator).length, state: r.state, mode: r.mode }));
  }

  socket.on('quickMatch', () => {
    // 优先：未满员的等待房间；其次：未满8人的进行中房间（观战）
    let rid = waitingQueue.find(x => rooms.has(x) && rooms.get(x).state === 'waiting');
    if (!rid) {
      const specRoom = [...rooms.values()].find(r =>
        Date.now() - r.createdAt < ROOM_LIFE &&
        r.players.length < ROOM_CAPACITY &&
        r.players.filter(p => !p.spectator).length >= TEAM_SIZE * 2);
      if (specRoom) rid = specRoom.id;
    }
    if (rid) {
      joinRoom(rid); // 房间未满员时保留在匹配队列中
    } else {
      const room = createRoom();
      waitingQueue.push(room.id);
      joinRoom(room.id);
    }
  });

  socket.on('createRoom', (rid) => {
    rid = String(rid || '').trim().slice(0, 10) || undefined;
    if (rid && rooms.has(rid)) { socket.emit('err', '房间名已存在'); return; }
    const room = createRoom(rid);
    joinRoom(room.id);
  });

  socket.on('createRoomPve', (rid) => {
    rid = String(rid || '').trim().slice(0, 10) || undefined;
    if (rid && rooms.has(rid)) { socket.emit('err', '房间名已存在'); return; }
    const room = createRoom(rid, true);
    joinRoom(room.id);
  });

  socket.on('joinRoom', (rid, opts) => joinRoom(rid, opts && opts.spectate));

  function joinRoom(rid, spectate) {
    const room = rooms.get(rid);
    if (!room) { socket.emit('err', '房间不存在'); return; }
    if (room.players.length >= ROOM_CAPACITY) { socket.emit('err', '房间已满（6名对战+2名观战）'); return; }
    if (curRoom) leaveRoom();
    curRoom = room;
    socket.join(room.id);
    me = addPlayerToRoom(room, socket.id, socket.data.name, !!spectate);
    me.token = myToken; sessions.set(myToken, room.id);
    broadcast(room, 'msg', { sys: true, text: `${me.name} ${me.spectator ? '进入观战' : '加入了房间'}` });
    const inGame = room.state !== 'waiting';
    socket.emit('joined', { roomId: room.id, isSpectator: me.spectator, inGame });
    broadcastRoom(room);
    broadcastState(room);
    // 新进玩家需要完整地形（含已被破坏的表面）；老玩家不重建纹理
    io.to(socket.id).emit('state', publicRoom(room, socket.id, true));
  }

  // 房主开始游戏：至少2名对战玩家
  socket.on('startGame', () => {
    if (!curRoom || !me) return;
    const room = curRoom;
    if (room.hostSid !== socket.id) { socket.emit('err', '只有房主才能开始游戏'); return; }
    if (room.state !== 'waiting') return;
    const active = room.players.filter(p => !p.spectator);
    const need = room.mode === 'pve' ? 1 : 2; // PVE单人即可开局
    if (active.length < need) { socket.emit('err', room.mode === 'pve' ? '等待玩家加入' : '至少需要2名玩家才能开始'); return; }
    room.state = 'playing';
    // 双卡槽：开局每人随机获得1张卡（槽1），槽2留空待玩家主动抽牌补充
    for (const p of active) {
      p.slots = [randomCard(p), null];
      p.cardChoice = null; p.cardPlayed = false; p.bloodUsed = false; p.deckUsed = false;
      sendSlots(p);
    }
    // 按房主选择的地图重新生成地形（等待期间可能切换过）
    room.terrain = genTerrain(room.map);
    room.terrain0 = Float32Array.from(room.terrain); // 原始高度留档：重连快照用它重建贴图，弹坑由maskRuns像素级还原
    room.platforms = genPlatforms(room.map);
    room.mask = buildMask(room.terrain, room.platforms);
    const qi = waitingQueue.indexOf(room.id);
    if (qi >= 0) waitingQueue.splice(qi, 1);
    room.turn = Math.floor(Math.random() * active.length);
    broadcast(room, 'msg', { sys: true, text: room.mode === 'pve' ? '⚔️ 战斗开始！（玩家 vs 怪物军团）' : '⚔️ 战斗开始！（红队 vs 蓝队）' });
    if (room.mode === 'pve') spawnMonsters(room);
    startGravity(room);
    broadcastRoom(room);
    broadcastState(room, true); // 开局重生成地形（等待期可能切换地图），需携带
    setTimeout(() => startTurn(room), 1000);
  });

  // 房主在等待界面切换地图
  socket.on('setMap', (v) => {
    if (!curRoom) return;
    if (curRoom.hostSid !== socket.id) { socket.emit('err', '只有房主才能切换地图'); return; }
    if (curRoom.state !== 'waiting') return;
    v = v === 'castle' ? 'castle' : 'random';
    if (curRoom.map === v) return;
    curRoom.map = v;
    broadcast(curRoom, 'msg', { sys: true, text: v === 'castle' ? '🏰 房主选择了城堡地图' : '🎲 房主选择了随机地图' });
    broadcastRoom(curRoom);
    broadcastState(curRoom);
  });

  function leaveRoom() {
    if (!curRoom) return;
    socket.leave(curRoom.id);
    removePlayerFromRoom(curRoom, me);
    curRoom = null; me = null;
  }

  // 断线重连：客户端（含刷新页面/socket.io自动重连）带令牌找回掉线玩家，重绑到新连接
  socket.on('resume', (tok) => {
    tok = String(tok || '');
    const rid = sessions.get(tok);
    const room = rid ? rooms.get(rid) : null;
    if (!room) { if (rid) sessions.delete(tok); return; }
    const p = room.players.find(x => x.token === tok && x.disconnected);
    if (!p) return; // 无掉线玩家：令牌无效或已超时移除，走正常大厅流程
    if (curRoom) leaveRoom();
    if (p.dcTimer) { clearTimeout(p.dcTimer); p.dcTimer = null; }
    p.disconnected = false;
    p.sid = socket.id;
    socket.data.name = p.name; // 服务器侧名字同步回该玩家的对局名
    curRoom = room; me = p;
    socket.join(room.id);
    broadcast(room, 'msg', { sys: true, text: `🎉 ${p.name} 重连成功` });
    socket.emit('joined', { roomId: room.id, isSpectator: false, inGame: true, reconnected: true });
    broadcastRoom(room);
    broadcastState(room);
    io.to(socket.id).emit('state', publicRoom(room, socket.id, true)); // 全量快照（含被破坏地形）
    sendSlots(p); // 重连：重发卡槽与未决的三选一候选
  });

  // 断线：对局中的对战玩家进入30秒宽限期（保留席位与状态），其余情况立即移除
  socket.on('disconnect', () => {
    if (curRoom && me && curRoom.state === 'playing' && !me.spectator) {
      const room = curRoom, p = me;
      p.disconnected = true;
      broadcast(room, 'msg', { sys: true, text: `🔌 ${p.name} 掉线，等待重连（30秒）…` });
      broadcastRoom(room);
      broadcastState(room);
      p.dcTimer = setTimeout(() => {
        p.disconnected = false;
        removePlayerFromRoom(room, p); // 超时：按主动离开处理（PVP判负/回等待）
      }, 30000);
      curRoom = null; me = null;
    } else {
      leaveRoom();
    }
  });

  socket.on('leaveRoom', leaveRoom);

  socket.on('aim', ({ angle, power, dir }) => {
    if (!curRoom || !me || curRoom.state !== 'playing') return;
    if (me.spectator) return; // 观战者不能上报瞄准（会污染朝向广播）
    me.angle = Math.max(-30, Math.min(90, Math.round(+angle || 45))); // 世界仰角
    me.power = Math.max(40, Math.min(MAX_POWER, Math.round(+power || 40)));
    if (dir === 1 || dir === -1) {
      const changed = me.dir !== dir;
      me.dir = dir;
      if (changed) broadcast(curRoom, 'facing', { slot: curRoom.players.indexOf(me), dir });
    }
  });

  socket.on('move', ({ dx }) => {
    if (!curRoom || !me || curRoom.state !== 'playing') return;
    const active = curRoom.players.filter(p => !p.spectator);
    if (active[curRoom.turn] !== me) return;
    dx = Math.max(-6, Math.min(6, +dx || 0));
    if (!dx) return;
    const step = Math.min(Math.abs(dx), me.moveBudget);
    if (step <= 0) { socket.emit('moved', { slot: curRoom.players.indexOf(me), x: me.x, y: me.y, budget: 0 }); return; }
    me.x = Math.max(30, Math.min(WORLD_W - 30, me.x + Math.sign(dx) * step));
    me.moveBudget -= step;
    placeOnGround(curRoom, me);
    broadcast(curRoom, 'moved', { slot: curRoom.players.indexOf(me), x: me.x, y: me.y, budget: me.moveBudget });
  });

  socket.on('fire', () => {
    if (!curRoom || !me || curRoom.state !== 'playing') return;
    const active = curRoom.players.filter(p => !p.spectator);
    if (active[curRoom.turn] !== me) return;
    if (me.fired) return; // 本回合已发射，防止连发刷炮
    me.fired = true;
    clearInterval(curRoom.timer);
    broadcast(curRoom, 'turnEnd', {}); // 本回合结束，客户端立即结束行动状态
    fire(curRoom, me);
  });

  socket.on('drawDeck', () => {
    if (!curRoom || !me || curRoom.state !== 'playing') return;
    if (me.deckUsed) { socket.emit('err', '牌堆只能抽一次'); return; }
    if (!me.alive) { socket.emit('err', '阵亡后无法抽牌'); return; }
    if (!me.slots) return;
    if (me.slots[1]) { socket.emit('err', '第二卡槽已有卡牌'); return; }
    if (me.cardChoice && me.cardChoice.length) { socket.emit('cardChoice', { cards: me.cardChoice }); return; }
    me.cardChoice = randomChoices(me, 3);
    io.to(me.sid).emit('cardChoice', { cards: me.cardChoice });
  });

  socket.on('pickCard', (id) => {
    if (!curRoom || !me || curRoom.state !== 'playing') return;
    if (!me.cardChoice || !me.cardChoice.some(c => c.id === String(id))) return;
    if (me.slots && !me.slots[1]) {
      me.slots[1] = me.cardChoice.find(c => c.id === String(id));
      me.deckUsed = true; // 牌堆整局限一次：选定后即使打出该卡也不能再抽
      const def = me.slots[1];
      broadcast(curRoom, 'msg', { sys: true, text: `🂠 ${me.name} 从牌堆选了一张卡（${def.emoji} ${def.name}）` });
    }
    me.cardChoice = null;
    sendSlots(me);
  });

  socket.on('playCard', (slot) => {
    if (!curRoom || !me || curRoom.state !== 'playing') return;
    const room = curRoom;
    const active = room.players.filter(p => !p.spectator);
    if (active[room.turn] !== me) return; // 只有轮到自己才能出牌
    if (me.cardPlayed) return; // 被跳过回合时不能出牌
    const idx = Number(slot);
    if (!me.slots || !(idx === 0 || idx === 1) || !me.slots[idx]) return;
    const id = me.slots[idx].id;
    me.slots[idx] = null;
    const def = CARDS[id];
    broadcast(room, 'cardPlayed', { slot: room.players.indexOf(me), card: `${def.emoji} ${def.name}`, by: me.name });
    applyCard(room, me, id);
    sendSlots(me);
    broadcastState(room);
    checkCardEnd(room);
  });

  socket.on('buyUpgrade', (id) => {
    if (!curRoom || !me || curRoom.state !== 'playing') return;
    const room = curRoom;
    const active = room.players.filter(p => !p.spectator);
    if (active[room.turn] !== me) { socket.emit('err', '只能在自己的回合购买强化'); return; }
    const u = UPGRADES[String(id)];
    if (!u) return;
    if (me.points < u.cost) { socket.emit('err', '积分不足'); return; }
    // 强化F是布尔型增益，本回合已购买则不可重复购买
    if (String(id) === 'f' && me.pierceEdge) { socket.emit('err', '强化F已生效，不能重复购买'); return; }
    me.points -= u.cost;
    switch (String(id)) {
      case 'a': me.extraShots++; break;
      case 'b': me.critBonus += 0.08; break;
      case 'c': me.dmgPct += 0.3; break;
      case 'd': me.flatDmg += 20; break;
      case 's': me.dmgPct += 1.0; break;
      case 'e': me.lifesteal = (me.lifesteal || 0) + 0.3; break;
      case 'f': me.pierceEdge = true; break;
      case 'g':
        if (me.doubleBoom) { socket.emit('err', '强化G已生效，不能重复购买'); return; }
        me.doubleBoom = true; break;
    }
    broadcast(room, 'msg', { sys: true, text: `🛒 ${me.name} 购买了 ${u.name}（-${u.cost} 积分）` });
    broadcastState(room);
  });

  socket.on('chat', (text) => {
    if (!curRoom) return;
    text = String(text || '').trim().slice(0, 120);
    if (text) broadcast(curRoom, 'msg', { name: socket.data.name, text });
  });

  socket.on('rematch', () => {
    if (!curRoom) return;
    const room = curRoom;
    if (room.hostSid !== socket.id) { socket.emit('err', '只有房主才能开始新一局'); return; }
    if (room.state !== 'over') return;
    room.terrain = genTerrain(room.map);
    room.terrain0 = Float32Array.from(room.terrain); // 原始高度留档：重连快照用它重建贴图，弹坑由maskRuns像素级还原
    room.platforms = genPlatforms(room.map);
    room.mask = buildMask(room.terrain, room.platforms);
    for (const p of room.players) {
      p.hp = MAX_HP; p.alive = true; p.angle = 45; p.power = 40; p.moveBudget = MOVE_BUDGET; p.fired = false;
      p.slots = [randomCard(p), null]; p.cardChoice = null; p.cardPlayed = false; p.deckUsed = false; p.shield = 0; p.berserk = 0; p.revenge = 0; p.fortress = 0; p.poison = 0; p.skip = 0;
      p.trueDmg = 0; p.hitPoison = 0; p.bloodUsed = false;
      p.points = 0; p.extraShots = 0; p.critBonus = 0; p.dmgPct = 0; p.flatDmg = 0;
      room.spawnSeq = 0; room.spawnCount = 0;
      p.lifesteal = 0; p.pierceEdge = false; p.doubleBoom = false;
      sendSlots(p);
    }
    const active = room.players.filter(p => !p.spectator);
    const idxInTeam = [0, 0];
    for (const p of active) {
      if (p.team === 0) { p.x = 260 + idxInTeam[0] * 90 + Math.random() * 30; p.dir = 1; idxInTeam[0]++; }
      else { p.x = WORLD_W - 260 - idxInTeam[1] * 90 - Math.random() * 30; p.dir = -1; idxInTeam[1]++; }
      p.y = groundY(room.terrain, p.x); // 先回到新地表，再贴面（避免旧坐标残留）
    }
    active.forEach(p => placeOnGround(room, p));
    room.state = 'playing';
    room.turn = Math.floor(Math.random() * active.length);
    if (room.mode === 'pve') spawnMonsters(room); // PVE重新刷怪
    startGravity(room);
    broadcast(room, 'msg', { sys: true, text: '🔄 新的一局开始！' });
    broadcastRoom(room);
    broadcastState(room, true); // 重赛重新生成了地形，必须携带
    setTimeout(() => startTurn(room), 800);
  });

  // 延迟测量：客户端发带回调的探测包，收到即回执（socket.io ack）
  socket.on('lat:ping', (ack) => { if (typeof ack === 'function') ack(); });
});

// 测试专用导出：TEST_EXPORT=1 时可离线复现炮弹/伤害逻辑（不影响正常运行）
if (process.env.TEST_EXPORT) {
  module.exports = { createRoom, addPlayerToRoom, spawnMonsters, placeOnGround, groundY, fire, rooms };
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`The Last Star 服务器已启动: http://localhost:${PORT}`);
});
