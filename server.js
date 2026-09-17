/**
 * 弹弹堂风格多人在线回合制炮弹游戏 - 服务端
 * 服务器权威：弹道、伤害、地形均在服务器计算，客户端只负责渲染与输入
 */
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const WORLD_W = 1200;
const WORLD_H = 600;
const GRAVITY = 0.28;
const TURN_TIME = 20;          // 秒
const MAX_POWER = 100;
const MAX_HP = 1000;
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

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const rooms = new Map(); // roomId -> room
const waitingQueue = []; // 快速匹配

function genTerrain() {
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

function groundY(terrain, x) {
  x = Math.max(0, Math.min(WORLD_W - 1, Math.round(x)));
  return terrain[x];
}

/** 随机生成空中平台（可阻挡炮弹，也能承接落下的角色） */
function genPlatforms() {
  const plats = [];
  const n = 2 + Math.floor(Math.random() * 2); // 2~3 个
  for (let i = 0; i < n; i++) {
    for (let tries = 0; tries < 20; tries++) {
      const w = 90 + Math.floor(Math.random() * 70);
      const x = 300 + Math.floor(Math.random() * (WORLD_W - 600 - w));
      const y = 150 + Math.floor(Math.random() * 140);
      const overlap = plats.some(p => x < p.x + p.w + 40 && p.x < x + w + 40 && y < p.y + 60 && p.y < y + 60);
      if (!overlap) { plats.push({ x, y, w, h: 16 + Math.floor(Math.random() * 8) }); break; }
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
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) m[y * WORLD_W + x] = 1;
  }
  return m;
}

/** 由高度图构建 2D 实心网格：每像素记录"实心/空"，支持真正的圆形弹坑 */
function buildMask(terrain) {
  const m = new Uint8Array(WORLD_W * WORLD_H);
  for (let x = 0; x < WORLD_W; x++) {
    const g = Math.round(terrain[x]);
    for (let y = g; y < WORLD_H; y++) m[y * WORLD_W + x] = 1;
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
    createdAt: Date.now(),
  };
  room.platforms = genPlatforms();
  room.mask = buildMask(room.terrain, room.platforms);
  rooms.set(room.id, room);
  return room;
}

/** 生成PVE怪物：与玩家数相当的小兵 + 1个Boss */
function spawnMonsters(room) {
  const actives = room.players.filter(p => !p.spectator);
  const n = Math.max(2, actives.length);
  room.monsters = [];
  for (let i = 0; i < n; i++) {
    const x = Math.min(1150, 620 + i * 95 + Math.random() * 30);
    room.monsters.push({ id: 'm' + i, kind: 'minion', x, y: 0, hp: 300, maxHp: 300, dmg: 60, speed: 30, range: 45, r: 12, alive: true });
  }
  const bx = Math.min(1150, 640 + n * 95);
  room.monsters.push({ id: 'boss', kind: 'boss', x: bx, y: 0, hp: 1500, maxHp: 1500, dmg: 130, speed: 18, range: 60, r: 22, alive: true });
  for (const m of room.monsters) m.y = groundY(room.terrain, m.x); // 出生在地面（平台由重力系统按需承接）
  broadcast(room, 'monsters', { monsters: room.monsters });
}

/** 重力系统：脚下没有实心地形时，角色和怪物逐步下落直到触地 */
function startGravity(room) {
  if (room.gravityTimer) return;
  room.gravityTimer = setInterval(() => {
    if (room.state !== 'playing') return;
    let changed = false;
    const players = [];
    for (let i = 0; i < room.players.length; i++) {
      const p = room.players[i];
      if (p.spectator || !p.alive) continue;
      const g = groundBelow(room.mask, p.x, p.y - 8); // 从脚底上方一点起查，允许浅度卡入回贴
      if (p.y < g - 1) { // 悬空：下落
        p.y = Math.min(g, p.y + 6);
        changed = true;
      } else if (p.y > g) { // 卡进地形：贴回表面
        p.y = g;
        changed = true;
      }
      if (changed) players.push({ slot: i, x: +p.x.toFixed(1), y: +p.y.toFixed(1) });
    }
    const monsters = [];
    for (const m of room.monsters || []) {
      if (!m.alive) continue;
      const g = groundBelow(room.mask, m.x, m.y - 8);
      if (m.y < g - 1) { m.y = Math.min(g, m.y + 4); changed = true; }
      else if (m.y > g) { m.y = g; changed = true; }
      if (changed) monsters.push({ id: m.id, y: +m.y.toFixed(1) });
    }
    if (changed) broadcast(room, 'fall', { players, monsters });
  }, 90);
}
/** 单只怪物行动：向最近的存活玩家移动，进入近战范围则攻击 */
function monsterActOne(room, m) {
  if (room.state !== 'playing' || !m.alive) return;
  const targets = room.players.filter(p => !p.spectator && p.alive);
  if (!targets.length) return;
  let target = targets[0], best = Infinity;
  for (const p of targets) {
    const d = Math.abs(p.x - m.x);
    if (d < best) { best = d; target = p; }
  }
  if (best <= m.range) {
    target.hp = Math.max(0, target.hp - m.dmg);
    const label = m.kind === 'boss' ? '👹Boss' : '👾小兵';
    broadcast(room, 'msg', { sys: true, text: `${label} 近战攻击 ${target.name}，造成 ${m.dmg} 伤害！` });
    if (target.hp <= 0) {
      target.alive = false;
      broadcast(room, 'msg', { sys: true, text: `💀 ${target.name} 被怪物击败了` });
    }
  } else {
    // 朝目标小步走：每80ms走6px，逐步广播，客户端看到的是行走而非瞬移
    const total = m.speed;
    const dirx = Math.sign(target.x - m.x) || 1;
    let walked = 0;
    const iv = setInterval(() => {
      if (room.state !== 'playing' || !m.alive) { clearInterval(iv); return; }
      const step = Math.min(6, total - walked);
      if (step <= 0) { clearInterval(iv); return; }
      m.x = Math.max(20, Math.min(WORLD_W - 20, m.x + dirx * step));
      walked += step;
      broadcast(room, 'monsters', { monsters: room.monsters });
      if (walked >= total) clearInterval(iv);
    }, 80);
    // 垂直方向交给重力系统处理
  }
  broadcast(room, 'monsters', { monsters: room.monsters });
  broadcastState(room);
  // 玩家全灭 → 怪物获胜
  const aliveP = room.players.filter(p => !p.spectator && p.alive);
  if (room.state === 'playing' && aliveP.length === 0) {
    endGame(room, '怪物军团', []);
    broadcast(room, 'msg', { sys: true, text: '💀 怪物军团获胜……' });
  }
}

/** 怪物阶段：每只怪物逐个行动（各自独立节奏），完毕后再轮到玩家 */
function monsterPhase(room, done) {
  if (room.state !== 'playing') { done && done(); return; }
  const alive = (room.monsters || []).filter(m => m.alive);
  if (!alive.length) { done && done(); return; }
  broadcast(room, 'msg', { sys: true, text: '👾 怪物行动中…' });
  alive.forEach((m, i) => setTimeout(() => monsterActOne(room, m), 600 + i * 900));
  setTimeout(() => done && done(), 600 + alive.length * 900);
}

/** 广播房间等待界面信息 */
function broadcastRoom(room) {
  io.to(room.id).emit('room', {
    id: room.id,
    state: room.state,
    mode: room.mode,
    hostSid: room.hostSid,
    players: room.players.map(p => ({ sid: p.sid, name: p.name, spectator: p.spectator, team: p.team })),
  });
}

/** 按玩家逐个下发房间状态，保证各自的 isYou 标记正确。
    withTerrain 仅在加入/重赛时为true：常规同步携带原始高度图会导致客户端把弹坑恢复原样 */
function broadcastState(room, withTerrain) {
  for (const p of room.players) io.to(p.sid).emit('state', publicRoom(room, p.sid, withTerrain));
}

function publicRoom(room, forSid, withTerrain) {
  const o = {
    id: room.id,
    state: room.state,
    mode: room.mode,
    wind: room.wind,
    turn: room.turn,
    timeLeft: room.timeLeft,
    monsters: room.monsters,
    players: room.players.map((p, i) => ({
      slot: i, name: p.name, x: Math.round(p.x), y: Math.round(p.y),
      hp: p.hp, alive: p.alive, isYou: p.sid === forSid, dir: p.dir, team: p.team,
    })),
  };
  if (withTerrain) { o.terrain = Array.from(room.terrain); o.platforms = room.platforms; }
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
    angle: 45, power: 50, dir: 1, moveBudget: MOVE_BUDGET, fired: false,
  };
  if (!spectator) {
    if (room.mode === 'pve') {
      // PVE：玩家全部在左侧营地
      p.x = 180 + idxInTeam * 70 + Math.random() * 30;
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
  room.wind = +(Math.random() * 10 - 5).toFixed(1);
  room.timeLeft = TURN_TIME;
  clearInterval(room.timer);
  room.timer = setInterval(() => {
    room.timeLeft--;
    broadcast(room, 'timer', room.timeLeft);
    if (room.timeLeft <= 0) {
      clearInterval(room.timer);
      broadcast(room, 'msg', { sys: true, text: `${p.name} 超时，回合结束` });
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
  });
}

function endGame(room, winner, names) {
  room.state = 'over';
  clearInterval(room.timer);
  clearInterval(room.shotTimer);
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
  let x = shooter.x + Math.cos(rad) * 22 * dir;
  let y = shooter.y - Math.sin(rad) * 22 - 6;
  const vx = Math.cos(rad) * speed * dir;
  let vy = -Math.sin(rad) * speed;

  broadcast(room, 'msg', { sys: true, text: `${shooter.name} 发射！(角度${shooter.angle} 力度${shooter.power})` });
  broadcast(room, 'shotBegin', { x: +x.toFixed(1), y: +y.toFixed(1) });

  // 服务器权威逐帧模拟：32 tick/秒，每 tick 推进 3 个物理步（飞行时长 ≈ 步数/96 秒）
  const TICK_MS = 1000 / 32;
  const STEPS_PER_TICK = 3;
  let hit = null, step = 0;

  const endShot = () => {
    clearInterval(room.shotTimer);
    room.shotTimer = null;
    const ex = hit && hit.x !== undefined ? hit.x : x;
    const ey = hit && hit.y !== undefined ? hit.y : y;
    let terrainRuns = [];
    const dmg = [];

    if (hit && hit.type !== 'out') {
      terrainRuns = carveMask(room.mask, ex, ey, EXPLODE_R);
      // 同步高度图表面（供新加入玩家重建地形）：表面只会被越炸越低（忽略仍悬空的平台）
      for (const r of terrainRuns) {
        const ts = topSolid(room.mask, r.x);
        if (ts > room.terrain[r.x]) room.terrain[r.x] = ts;
      }
      for (const p of room.players) {
        if (p.spectator || !p.alive) continue;
        const dx = p.x - ex, dy = (p.y - 10) - ey;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < EXPLODE_R + TANK_R) {
          const ratio = Math.max(0, 1 - Math.max(0, dist - TANK_R) / EXPLODE_R);
          const d = Math.round(MAX_DMG * ratio);
          if (d > 0) {
            p.hp = Math.max(0, p.hp - d);
            if (p.hp <= 0) p.alive = false;
            dmg.push({ slot: room.players.indexOf(p), damage: d, hp: p.hp, alive: p.alive });
          }
        }
      }
      // 爆炸波及怪物（PVE）：必须真正进入爆炸半径内才会受伤
      for (const m of room.monsters || []) {
        if (!m.alive) continue;
        const dx = m.x - ex, dy = (m.y - m.r) - ey;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < EXPLODE_R) {
          const ratio = Math.max(0, 1 - dist / EXPLODE_R);
          const d = Math.round(MAX_DMG * 0.8 * ratio);
          if (d > 0) {
            m.hp = Math.max(0, m.hp - d);
            if (m.hp <= 0) {
              m.alive = false;
              broadcast(room, 'msg', { sys: true, text: `💥 ${m.kind === 'boss' ? '👹Boss' : '👾小兵'} 被消灭了！` });
            }
          }
        }
      }
    }

    broadcast(room, 'shotEnd', {
      explosion: hit && hit.type !== 'out' ? { x: +ex.toFixed(1), y: +ey.toFixed(1), r: EXPLODE_R } : null,
      terrainRuns,
      damage: dmg,
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
    for (let s = 0; s < STEPS_PER_TICK; s++) {
      step++;
      x += vx * 0.7;
      y += vy * 0.7;
      vy += GRAVITY * 0.7;
      x += room.wind * 0.012;
      if (x < -200 || x > WORLD_W + 200 || y > WORLD_H + 100) { hit = { type: 'out' }; break; }
      // 命中玩家
      for (const p of room.players) {
        if (p.spectator || !p.alive) continue;
        const dx = x - p.x, dy = y - (p.y - 10);
        if (dx * dx + dy * dy < (TANK_R + 6) * (TANK_R + 6) && p !== shooter) {
          hit = { type: 'player', x, y, target: p };
          break;
        }
      }
      if (hit) break;
      // 命中自己（延迟几步防止刚出手就打自己）
      if (step > 12) {
        for (const p of room.players) {
          if (p.spectator || !p.alive || p !== shooter) continue;
          const dx = x - p.x, dy = y - (p.y - 10);
          if (dx * dx + dy * dy < (TANK_R + 4) * (TANK_R + 4)) { hit = { type: 'player', x, y, target: p }; break; }
        }
        if (hit) break;
      }
      // 命中怪物（PVE）
      for (const m of room.monsters || []) {
        if (!m.alive) continue;
        const dx = x - m.x, dy = y - (m.y - m.r);
        if (dx * dx + dy * dy < (m.r + 8) * (m.r + 8)) { hit = { type: 'monster', x, y }; break; }
      }
      if (hit) break;
      if (step > 6 && solidIn(room.mask, Math.round(x), Math.round(y))) { hit = { type: 'ground', x, y }; break; }
      if (step >= 4000) { hit = { type: 'out' }; break; }
    }
    if (hit) endShot();
    else broadcast(room, 'shotTick', { x: +x.toFixed(1), y: +y.toFixed(1) });
  }, TICK_MS);
}

io.on('connection', (socket) => {
  let curRoom = null, me = null;
  socket.data.name = randomName();

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
    const qi = waitingQueue.indexOf(room.id);
    if (qi >= 0) waitingQueue.splice(qi, 1);
    room.turn = Math.floor(Math.random() * active.length);
    broadcast(room, 'msg', { sys: true, text: room.mode === 'pve' ? '⚔️ 战斗开始！（玩家 vs 怪物军团）' : '⚔️ 战斗开始！（红队 vs 蓝队）' });
    if (room.mode === 'pve') spawnMonsters(room);
    startGravity(room);
    broadcastRoom(room);
    broadcastState(room);
    setTimeout(() => startTurn(room), 1000);
  });

  function leaveRoom() {
    if (!curRoom) return;
    const room = curRoom;
    socket.leave(room.id);
    const i = room.players.findIndex(p => p.sid === socket.id);
    if (i >= 0) {
      const [p] = room.players.splice(i, 1);
      broadcast(room, 'msg', { sys: true, text: `${p.name} 离开了` });
    }
    // 房主离开：转移给房间里的下一名玩家
    if (room.hostSid === socket.id) {
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
          clearInterval(room.gravityTimer);
          broadcast(room, 'msg', { sys: true, text: '人数不足，回到等待中…' });
        }
      } else {
        // PVP：双方都还有人就继续打，否则回到等待
        const aliveTeams = [0, 1].filter(t => active.some(x => x.team === t));
        if (active.length < 2 || aliveTeams.length < 2) {
          room.state = 'waiting';
          clearInterval(room.timer);
          clearInterval(room.shotTimer);
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
      clearInterval(room.gravityTimer);
      rooms.delete(room.id);
      const qi = waitingQueue.indexOf(room.id);
      if (qi >= 0) waitingQueue.splice(qi, 1);
    } else {
      broadcastRoom(room);
    }
    curRoom = null; me = null;
  }

  socket.on('leaveRoom', leaveRoom);

  socket.on('aim', ({ angle, power, dir }) => {
    if (!curRoom || !me || curRoom.state !== 'playing') return;
    const active = curRoom.players.filter(p => !p.spectator);
    if (active[curRoom.turn] !== me) return;
    me.angle = Math.max(10, Math.min(90, Math.round(+angle || 45)));
    me.power = Math.max(10, Math.min(MAX_POWER, Math.round(+power || 50)));
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
    fire(curRoom, me);
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
    room.terrain = genTerrain();
    room.platforms = genPlatforms();
    room.mask = buildMask(room.terrain, room.platforms);
    for (const p of room.players) { p.hp = MAX_HP; p.alive = true; p.angle = 45; p.power = 50; p.moveBudget = MOVE_BUDGET; p.fired = false; }
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

  socket.on('disconnect', leaveRoom);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`弹弹堂服务器已启动: http://localhost:${PORT}`);
});
