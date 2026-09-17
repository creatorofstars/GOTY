/* 弹弹堂 Online 客户端 */
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const W = 1200, H = 600;
const RES = 2; // SSAA超采样：内部按2倍分辨率渲染，浏览器缩回显示尺寸获得平滑边缘
cv.width = W * RES;
cv.height = H * RES;

const socket = io();
let myName = '';
let roomId = null;
let isSpectator = false;
let terrain = new Float32Array(W);
// 2D 可破坏地形：离屏画布（显示）+ 实心网格（本地碰撞预估，权威在服务器）
const tcv = document.createElement('canvas');
tcv.width = W; tcv.height = H;
const tctx = tcv.getContext('2d');
let mask = new Uint8Array(W * H);

let platforms = [];                    // 空中平台（服务器生成，随terrain一起同步）

/** 分层地形贴图：表层草皮 → 泥土 → 岩石（厚度随列起伏，形成自然断面） */
function buildTerrainTexture(heightArr) {
  tctx.clearRect(0, 0, W, H);
  for (let x = 0; x < W; x++) {
    const top = Math.max(0, Math.round(heightArr[x] || H)); // 与碰撞网格完全一致，不多画1像素
    if (top >= H) continue;
    const grassH = 8;
    const dirtH = 38 + Math.round(10 * Math.sin(x * 0.045) + 6 * Math.sin(x * 0.013)); // 泥土层厚度起伏
    // 草皮：亮草尖 + 主草色
    tctx.fillStyle = '#6fbf44';
    tctx.fillRect(x, top, 1, Math.min(grassH, H - top));
    tctx.fillStyle = '#8fd960';
    tctx.fillRect(x, top, 1, Math.min(3, H - top));
    // 泥土
    const dirtTop = top + grassH;
    const dd = Math.max(0, Math.min(dirtH, H - dirtTop));
    if (dd > 0) { tctx.fillStyle = '#8a5a33'; tctx.fillRect(x, dirtTop, 1, dd); }
    // 岩石
    const stoneTop = dirtTop + dd;
    if (stoneTop < H) { tctx.fillStyle = '#5f6368'; tctx.fillRect(x, stoneTop, 1, H - stoneTop); }
  }
  drawPlatforms();
  mask = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    const g = Math.round(heightArr[x] || H);
    for (let y = g; y < H; y++) mask[y * W + x] = 1;
  }
  for (const pf of platforms) {
    for (let x = Math.max(0, pf.x); x < Math.min(W, pf.x + pf.w); x++)
      for (let y = Math.max(0, pf.y); y < Math.min(H, pf.y + pf.h); y++) mask[y * W + x] = 1;
  }
}

/** 空中平台：草皮 + 泥土夹层 + 岩石底 */
function drawPlatforms() {
  for (const pf of platforms) {
    tctx.fillStyle = '#5f6368'; tctx.fillRect(pf.x, pf.y + 6, pf.w, pf.h - 6); // 岩石主体
    tctx.fillStyle = '#8a5a33'; tctx.fillRect(pf.x, pf.y + 6, pf.w, 5);        // 泥土夹层
    tctx.fillStyle = '#6fbf44'; tctx.fillRect(pf.x, pf.y, pf.w, 6);            // 草皮
    tctx.fillStyle = '#8fd960'; tctx.fillRect(pf.x, pf.y, pf.w, 2);            // 草尖高光
  }
}

function applyTerrainRuns(runs) {
  for (const r of runs) {
    tctx.clearRect(r.x, r.y0, 1, r.y1 - r.y0 + 1);
    for (let y = r.y0; y <= r.y1; y++) mask[y * W + r.x] = 0;
  }
}

function topSolidLocal(x) {
  x = Math.max(0, Math.min(W - 1, Math.round(x)));
  for (let y = 0; y < H; y++) if (mask[y * W + x]) return y;
  return H;
}

/** 从脚底附近向下找落点（与服务器 groundBelow 一致：平台只承接上方落下的实体） */
function groundBelowLocal(x, fromY) {
  x = Math.max(0, Math.min(W - 1, Math.round(x)));
  for (let y = Math.max(0, Math.round(fromY)); y < H; y++) if (mask[y * W + x]) return y;
  return H;
}
let players = [];               // {slot,name,x,y,hp,alive,isYou}
let mySlot = -1;
let curTurnSid = null;
let curTurnSlot = -1;
let wind = 0;
let angle = 45, power = 0, dir = 1;   // dir: 1 朝右, -1 朝左
let monsters = [];                     // PVE怪物
// 玩家角色贴图
const charImg = new Image();
charImg.src = '/texture/character.png';
let charging = false, chargeStart = 0;
let animating = false;
let shots = [];                 // 粒子特效
let explosion = null;           // {x,y,r,t}
let flying = null;              // {points, idx, x, y}
let clouds = Array.from({length: 6}, () => ({ x: Math.random()*W, y: 40+Math.random()*160, s: .2+Math.random()*.5 }));

/* ---------- 摄像机 ----------
   发射后镜头在0.75秒内推近聚焦炮弹（跟随飞行）；
   0.75秒后回到正常视野；若子弹提前命中，立即提前恢复 */
const cam = { s: 1, left: 0, top: 0, mode: 'idle', t: 0 };
const CAM_ZOOM = 1.92; // 1.6 * 1.2：场景放大20%
const CAM_FOCUS_MS = 750; // 聚焦动画时长

function camStep() {
  if (cam.mode === 'follow') {
    if (performance.now() >= cam.followUntil) { cam.mode = 'return'; return; }
    if (flying && flying.x !== undefined) {
      // 聚焦进度0→1（0.75秒线性），位置与缩放同步逼近目标
      const p = Math.min(1, (CAM_FOCUS_MS - (cam.followUntil - performance.now())) / CAM_FOCUS_MS);
      cam.s += (1 + (CAM_ZOOM - 1) * p - cam.s) * 0.18;
      const vw = W / cam.s, vh = H / cam.s;
      const tl = Math.max(0, Math.min(W - vw, flying.x - vw / 2));
      const tt = Math.max(0, Math.min(H - vh, flying.y - vh / 2));
      cam.left += (tl - cam.left) * 0.22;
      cam.top += (tt - cam.top) * 0.22;
    }
  } else if (cam.mode === 'return') {
    cam.s += (1 - cam.s) * 0.08;
    cam.left += (0 - cam.left) * 0.08;
    cam.top += (0 - cam.top) * 0.08;
    if (Math.abs(cam.s - 1) < 0.005 && Math.abs(cam.left) < 1 && Math.abs(cam.top) < 1) {
      cam.s = 1; cam.left = 0; cam.top = 0; cam.mode = 'idle';
    }
  }
}

function applyCam() {
  ctx.setTransform(cam.s * RES, 0, 0, cam.s * RES, -cam.left * cam.s * RES, -cam.top * cam.s * RES);
}

/* ---------- 大厅 ---------- */
const $ = id => document.getElementById(id);
const lobbyEl = $('lobby'), roomScreenEl = $('roomScreen'), gameEl = $('game');
let isHost = false, hostSid = null;

$('nameInput').value = localStorage.getItem('ddt_name') || '';
$('quickBtn').onclick = () => { saveName(); socket.emit('quickMatch'); };
$('createBtn').onclick = () => { saveName(); socket.emit('createRoom', $('roomInput').value.trim()); };
$('pveBtn').onclick = () => { saveName(); socket.emit('createRoomPve', $('roomInput').value.trim()); };
$('refreshBtn').onclick = () => socket.emit('lobbyRefresh');
$('nameInput').addEventListener('change', saveName);

function saveName() {
  const n = $('nameInput').value.trim();
  if (n) { myName = n; localStorage.setItem('ddt_name', n); socket.emit('rename', n); }
}

socket.on('lobby', ({ rooms, yourName }) => {
  myName = yourName;
  $('nameInput').value = yourName;
  const ul = $('roomList');
  ul.innerHTML = '';
  if (!rooms.length) {
    ul.innerHTML = '<li class="empty">暂无房间，创建一个吧</li>';
    return;
  }
  for (const r of rooms) {
    const li = document.createElement('li');
    const playing = r.state === 'playing' || r.state === 'over';
    const joinBtn = `<button class="btn small" data-act="join" data-rid="${r.id}" ${playing ? 'disabled' : ''}>加入</button>`;
    const specBtn = `<button class="btn small" data-act="spec" data-rid="${r.id}">观战</button>`;
    li.innerHTML = `<span>🏠 ${r.id}${r.mode === 'pve' ? ' 👾PVE' : ''} · ${r.count}/6 ${playing ? '· 🎮进行中' : ''}</span><span class="row" style="margin:0">${joinBtn}${specBtn}</span>`;
    ul.appendChild(li);
  }
  ul.onclick = (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn || btn.disabled) return;
    saveName();
    socket.emit('joinRoom', btn.dataset.rid);
  };
});

socket.on('err', (m) => { $('lobbyErr').textContent = m; setTimeout(() => $('lobbyErr').textContent = '', 3000); });

socket.on('renamed', (n) => { myName = n; });

/* ---------- 进入房间 ---------- */
socket.on('joined', ({ roomId: rid, isSpectator: spec, inGame }) => {
  roomId = rid;
  isSpectator = spec;
  lobbyEl.classList.add('hidden');
  $('chatLog').innerHTML = '';
  if (inGame) {
    // 直播进行中的对局，直接进入游戏画面
    roomScreenEl.classList.add('hidden');
    gameEl.classList.remove('hidden');
    addChat(null, spec ? `你以观战身份进入房间 ${rid}` : `已进入房间 ${rid}`);
  } else {
    // 进入房间等待界面
    gameEl.classList.add('hidden');
    roomScreenEl.classList.remove('hidden');
  }
});

/* ---------- 房间等待界面 ---------- */
socket.on('room', (r) => {
  hostSid = r.hostSid;
  isHost = r.hostSid === socket.id;
  // 房主开局后，等待界面整体切换到游戏画面
  if (r.state !== 'waiting' && !roomScreenEl.classList.contains('hidden')) {
    roomScreenEl.classList.add('hidden');
    gameEl.classList.remove('hidden');
  }
  if (roomScreenEl.classList.contains('hidden')) return;
  hostSid = r.hostSid;
  isHost = r.hostSid === socket.id;
  $('rsRoomId').textContent = r.id;
  const ul = $('rsPlayers');
  ul.innerHTML = '';
  const actives = r.players.filter(p => !p.spectator);
  for (const p of r.players) {
    const li = document.createElement('li');
    const host = p.sid === r.hostSid ? '<span class="crown">👑房主</span>' : '';
    const teamTag = p.spectator ? '<span class="tag">👀 观战</span>' : `<span class="tag">${p.team === 0 ? '🔴 红队' : '🔵 蓝队'}</span>`;
    li.innerHTML = `<span>${host} ${escapeHtml(p.name)}${p.sid === socket.id ? ' (你)' : ''}</span>${teamTag}`;
    ul.appendChild(li);
  }
  const startBtn = $('rsStartBtn');
  const isPve = r.mode === 'pve';
  const need = isPve ? 1 : 2;
  startBtn.style.display = isHost ? '' : 'none';
  startBtn.disabled = actives.length < need;
  $('rsTip').textContent = actives.length < need
    ? `等待玩家加入…（当前 ${actives.length} 人，${isPve ? 'PVE 1 人即可开局' : '2 人以上可开局'}）`
    : `当前 ${actives.length} 名玩家${isPve ? '（PVE）' : ''}，房主可随时开始`;
});

$('rsStartBtn').onclick = () => socket.emit('startGame');
$('rsLeaveBtn').onclick = () => {
  socket.emit('leaveRoom');
  roomId = null;
  roomScreenEl.classList.add('hidden');
  lobbyEl.classList.remove('hidden');
  socket.emit('lobbyRefresh');
};

$('leaveBtn').onclick = () => {
  socket.emit('leaveRoom');
  roomId = null;
  gameEl.classList.add('hidden');
  lobbyEl.classList.remove('hidden');
  socket.emit('lobbyRefresh');
};

/* ---------- 房间状态 ---------- */
socket.on('state', (st) => {
  // 仅在携带地形时重建纹理（首次加入/重赛）；常规同步不能恢复被破坏的地形
  if (st.terrain) {
    terrain = Float32Array.from(st.terrain);
    platforms = st.platforms || [];
    buildTerrainTexture(terrain);
  }
  mergeMonsters(st.monsters);
  players = st.players;
  wind = st.wind;
  me = players.find(p => p.isYou);
  if (me) {
    mySlot = me.slot;
    dir = me.dir || 1;
  }
  updateHUD();
});

let me = null;

socket.on('turn', (t) => {
  curTurnSid = t.sid;
  curTurnSlot = t.turn;
  wind = t.wind;
  charging = false;
  // 正常流程 shotEnd 先于本事件到达；若异常残留飞行状态，兜底清掉，避免无法开火
  if (animating && flying) { flying = null; animating = false; }
  $('timer').textContent = t.timeLeft;
  $('timer').classList.toggle('urgent', t.timeLeft <= 5);
  if (me) me.moveBudget = 150;
  moveBudget = 150;
  $('moveVal').textContent = 150;
  SFX.play('turn');
  updateHUD();
});

socket.on('timer', (s) => {
  const el = $('timer');
  el.textContent = s;
  el.classList.toggle('urgent', s <= 5);
  if (s <= 5 && s > 0) SFX.play('tick');
});

socket.on('gameover', ({ winner }) => {
  // 我方胜利奏凯歌，失败奏哀乐
  const myTeam = me ? me.team : 0;
  const iWon = winner === '玩家队' || winner === '红队' && myTeam === 0 || winner === '蓝队' && myTeam === 1;
  SFX.play(iWon ? 'win' : 'lose');
  showOverlay(`🏆 ${winner || '无人'} 获胜！`);
  if (isHost && !isSpectator) {
    const btn = document.createElement('button');
    btn.className = 'btn primary big';
    btn.textContent = '再来一局';
    btn.onclick = () => { hideOverlay(); socket.emit('rematch'); };
    $('overlay').appendChild(btn);
  } else {
    const tip = document.createElement('div');
    tip.style.fontSize = '16px';
    tip.style.color = '#cdd8ee';
    tip.textContent = isSpectator ? '等待房主开始新一局…' : '等待房主开始新一局…';
    $('overlay').appendChild(tip);
  }
});

socket.on('msg', (m) => {
  addChat(m.name, m.text);
  if (m.text && m.text.includes('近战攻击')) SFX.play('attack');
  if (m.text && m.text.includes('被消灭')) SFX.play('kill');
  if (m.text && m.text.includes('加入了房间')) SFX.play('join');
});

/* ---------- 聊天 ---------- */
function sendChat() {
  const t = $('chatInput').value.trim();
  if (t) { socket.emit('chat', t); $('chatInput').value = ''; }
}
$('chatBtn').onclick = sendChat;
$('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

function addChat(name, text) {
  const log = $('chatLog');
  const div = document.createElement('div');
  if (name == null) { div.className = 'sys'; div.textContent = text; }
  else { div.innerHTML = `<b>${escapeHtml(name)}:</b> ${escapeHtml(text)}`; }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}
function escapeHtml(s) { return String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }

/* ---------- 操作 ----------
   空格：按住蓄力、松开发射
   A/D：左右移动（每回合有限步数）
   W/S：调整角度，越过 90° 边界自动转身 */
function myTurn() { return !isSpectator && players.length && players[turnIdx()] && players[turnIdx()].isYou && !animating; }
function turnIdx() { return Math.min(curTurnSlot, players.filter(p=>!p.spectator).length - 1); }

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 1500);
}

document.addEventListener('keydown', (e) => {
  if (gameEl.classList.contains('hidden')) return;
  if (document.activeElement === $('chatInput') || document.activeElement === $('nameInput')) return;
  const gameKey = ['KeyA', 'KeyD', 'KeyW', 'KeyS', 'Space', 'ArrowUp', 'ArrowDown'].includes(e.code);
  if (!myTurn()) {
    if (gameKey && !isSpectator && roomId) {
      const cur = players[turnIdx()];
      toast(animating ? '💣 炮弹飞行中…' : cur ? `⏳ 还没到你的回合（${cur.name} 行动中）` : '⏳ 等待回合…');
      if (e.code === 'Space') e.preventDefault();
    }
    return;
  }
  switch (e.code) {
    case 'KeyA': startMove(-1); e.preventDefault(); break;
    case 'KeyD': startMove(1); e.preventDefault(); break;
    case 'KeyW': case 'ArrowUp': startAngleAdj(1); e.preventDefault(); break;
    case 'KeyS': case 'ArrowDown': startAngleAdj(-1); e.preventDefault(); break;
    case 'Space':
      if (!charging) { charging = true; chargeStart = performance.now(); SFX.play('charge'); }
      e.preventDefault();
      break;
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && charging) {
    charging = false;
    if (myTurn()) doFire();
  }
  if (['KeyA', 'KeyD'].includes(e.code)) stopMove();
  if (['KeyW', 'KeyS', 'ArrowUp', 'ArrowDown'].includes(e.code)) stopAngleAdj();
});

// 移动：按住期间持续向服务器发送步进
let moveIv = null;
function startMove(d) {
  if (moveIv) return; // 已在移动
  sendMove(d);
  moveIv = setInterval(() => sendMove(d), 40);
}
function stopMove() { if (moveIv) { clearInterval(moveIv); moveIv = null; } }
function sendMove(d) {
  if (!myTurn() || !me) { stopMove(); return; }
  const dx = d * 5;
  // 移动方向改变朝向（角色转身面对移动方向）
  if (d !== dir) {
    dir = d;
    if (me) me.dir = dir; // 立即翻转自己的贴图
    updateAimHud();
    socket.emit('aim', { angle, power, dir });
  }
  // 本地乐观更新，流畅显示；服务器为最终位置
  me.x = Math.max(30, Math.min(W - 30, me.x + dx));
  me.y = groundBelowLocal(me.x, me.y - 8);
  socket.emit('move', { dx });
}

// 角度：按住W/S期间持续调整（每40ms ±1°，越过90°自动转身）
let angleIv = null;
function startAngleAdj(d) {
  if (angleIv) return;
  angleIv = setInterval(() => {
    if (!myTurn()) { stopAngleAdj(); return; }
    setAngle(angle + d);
  }, 40);
}
function stopAngleAdj() { if (angleIv) { clearInterval(angleIv); angleIv = null; } }

/** 合并怪物列表：按 id 保留旧的渲染坐标（rx/ry），新坐标作为插值目标，移动变为平滑行走而非瞬移 */
function mergeMonsters(list) {
  const old = new Map(monsters.map(m => [m.id, m]));
  monsters = (list || []).map(m => {
    const o = old.get(m.id);
    if (o && o.rx !== undefined) { m.rx = o.rx; m.ry = o.ry; }
    return m;
  });
}

socket.on('monsters', (d) => { mergeMonsters(d.monsters); });

socket.on('facing', ({ slot, dir: d }) => {
  const p = players.find(q => q.slot === slot);
  if (p) p.dir = d;
});

// 重力下落：角色/怪物脚下无地形时逐步下落。
// 炮弹动画播放期间先排队，等弹坑在命中瞬间应用后再落，避免怪物沉进"尚未被炸开"的地面
let pendingFalls = [];
function applyFalls({ players: fp, monsters: fm }) {
  for (const pos of fp || []) {
    const p = players.find(q => q.slot === pos.slot);
    if (p) { p.x = pos.x; p.y = pos.y; }
  }
  for (const m of fm || []) {
    const q = monsters.find(z => z.id === m.id);
    if (q) q.y = m.y;
  }
}
socket.on('fall', ({ players: fp, monsters: fm }) => {
  const data = { players: fp, monsters: fm };
  if (animating && flying) { pendingFalls.push(data); return; }
  applyFalls(data);
});

socket.on('moved', ({ slot, x, y, budget }) => {
  const p = players.find(q => q.slot === slot);
  if (p) { p.x = x; p.y = y; }
  moveBudget = budget;
  $('moveVal').textContent = Math.max(0, Math.round(budget));
});

let moveBudget = 0;

function setAngle(a) {
  // 角度范围 10~90（相对朝向），越过边界触发转身
  if (a > 90) { dir = -dir; a = 180 - a; }
  if (a < 10) { dir = -dir; a = 20 - a; }
  angle = Math.round(a);
  if (me) me.dir = dir; // 同步自己的贴图朝向
  if (myTurn()) socket.emit('aim', { angle, power, dir });
  updateAimHud();
}
function setPower(p) {
  power = Math.max(10, Math.min(100, Math.round(p)));
  if (myTurn()) socket.emit('aim', { angle, power });
  updateAimHud();
}

// 按钮（含长按连调）
function holdBtn(btn, fn) {
  let iv = null;
  const start = (e) => { e.preventDefault(); fn(); iv = setInterval(fn, 60); };
  const stop = () => { if (iv) clearInterval(iv); iv = null; };
  btn.addEventListener('mousedown', start);
  btn.addEventListener('touchstart', start, {passive:false});
  ['mouseup','mouseleave','touchend','touchcancel'].forEach(ev => btn.addEventListener(ev, stop));
}

function doFire() {
  setPower(powerFromCharge());
  socket.emit('fire');
  animating = true;
  stopMove();
}
function powerFromCharge() {
  const held = (performance.now() - chargeStart) / 1000;
  return Math.min(100, 20 + held * 55);
}

function updateAimHud() {
  $('angleVal').textContent = angle;
  $('powerVal').textContent = Math.round(power);
  $('faceVal').textContent = dir === 1 ? '→' : '←';
}

function updateHUD() {
  const active = players.filter(p => !p.spectator);
  for (let team = 0; team < 2; team++) {
    const rows = $('team' + team + 'rows');
    rows.innerHTML = '';
    const mates = active.filter(p => p.team === team);
    for (const p of mates) {
      const row = document.createElement('div');
      row.className = 'hprow' + (team === 1 ? ' right' : '') + (p.alive ? '' : ' dead');
      row.innerHTML = `<span class="hname">${escapeHtml(p.name)}${p.isYou ? '(你)' : ''}</span>` +
        `<div class="hpbar"><div class="hpfill" style="width:${p.hp / 10}%;background:${p.alive ? 'linear-gradient(90deg,#43d96a,#a8e063)' : '#555'}"></div></div>`;
      rows.appendChild(row);
    }
    if (!mates.length) rows.innerHTML = '<div class="hname">等待玩家…</div>';
  }
  const w = Math.abs(wind).toFixed(1);
  $('windVal').textContent = w;
  $('windArrow').textContent = wind > 0.2 ? '→' : wind < -0.2 ? '←' : '·';
  const cur = active[curTurnSlot];
  $('turnLabel').textContent = cur ? (cur.isYou ? '🎯 你的回合！' : `${cur.name} 行动中…`) : '等待玩家…';
  if (me) { angle = 45; power = 0; updateAimHud(); }
}

function showOverlay(html) { const o = $('overlay'); o.innerHTML = `<div>${html}</div>`; o.classList.remove('hidden'); }
function hideOverlay() { $('overlay').classList.add('hidden'); }

/* ---------- 弹道动画（服务器32tick权威模拟，客户端插值渲染） ---------- */
socket.on('shotBegin', (d) => {
  SFX.play('shoot');
  // 当前回合玩家若在本炮中阵亡，立即清除回合指示器
  if (curTurnSlot >= 0) {
    const cur = players.find(p => p.slot === curTurnSlot);
    if (cur && !cur.alive) curTurnSlot = -1;
  }
  flying = { x: d.x, y: d.y, tx: d.x, ty: d.y, trail: [] };
  animating = true;
  cam.mode = 'follow'; // 镜头0.75秒内推近聚焦炮弹
  cam.followUntil = performance.now() + CAM_FOCUS_MS;
});

// 服务器每个tick发来的权威位置：只记为目标点，渲染时逐帧逼近（客户端插值）
socket.on('shotTick', (d) => {
  if (flying) { flying.tx = d.x; flying.ty = d.y; }
});

socket.on('shotEnd', (data) => {
  if (data.explosion) {
    SFX.play('explode'); // 命中爆炸
    explosion = { ...data.explosion, t: 0 };
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 5;
      shots.push({ x: data.explosion.x, y: data.explosion.y, vx: Math.cos(a)*sp, vy: Math.sin(a)*sp - 2, life: 1 });
    }
  }
  if ((data.damage || []).length) SFX.play('hit'); // 有玩家受伤
  // 命中：立即提前恢复到正常视野（若聚焦动画还在进行）
  if (cam.mode === 'follow') cam.mode = 'return';
  // 应用伤害与地形
  for (const d of data.damage || []) {
    const p = players.find(q => q.slot === d.slot);
    if (p) { p.hp = d.hp; p.alive = d.alive; }
  }
  // 应用弹坑（2D 区段擦除）与玩家落点，再补上动画期间积压的重力下落
  applyTerrainRuns(data.terrainRuns || []);
  if (data.monsters) mergeMonsters(data.monsters);
  for (const pos of data.positions || []) {
    const p = players.find(q => q.slot === pos.slot);
    if (p) { p.x = pos.x; p.y = pos.y; }
  }
  while (pendingFalls.length) applyFalls(pendingFalls.shift());
  flying = null;
  updateHUD();
  setTimeout(() => { animating = false; }, 300);
});

/* ---------- 渲染 ---------- */
function draw() {
  camStep();
  ctx.setTransform(RES, 0, 0, RES, 0, 0);
  ctx.save();
  applyCam();
  // 天空（放大画布范围避免镜头移动露边）
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#5fb8f0'); sky.addColorStop(1, '#bfe6ff');
  ctx.fillStyle = sky;
  ctx.fillRect(cam.left - 50, cam.top - 50, W / cam.s + 100, H / cam.s + 100);

  // 云（基础漂移 + 随风速移动，风向决定漂移方向和快慢）
  ctx.fillStyle = 'rgba(255,255,255,.8)';
  for (const c of clouds) {
    c.x += c.s * 0.15 + wind * 0.12 * c.s;
    if (c.x > W + 80) c.x = -80;
    if (c.x < -80) c.x = W + 80;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 24, 0, 7); ctx.arc(c.x + 26, c.y + 6, 18, 0, 7); ctx.arc(c.x - 26, c.y + 8, 16, 0, 7);
    ctx.fill();
  }

  // 太阳
  ctx.fillStyle = '#ffe37e';
  ctx.beginPath(); ctx.arc(1060, 90, 36, 0, 7); ctx.fill();

  // 地形（离屏画布，爆炸会实时擦除出圆形弹坑）
  ctx.drawImage(tcv, 0, 0);

  // 坦克
  const active = players.filter(p => !p.spectator);
  for (const p of active) {
    drawTank(p);
  }
  drawMonsters();

  // 瞄准指示
  if (myTurn() && me && !animating) drawAim(me);

  // 飞行炮弹（服务器位置插值 + 渐隐拖尾）
  if (flying) {
    // 每帧向服务器权威位置逼近（插值），网络抖动不会造成跳帧
    flying.x += (flying.tx - flying.x) * 0.35;
    flying.y += (flying.ty - flying.y) * 0.35;
    const trail = flying.trail;
    const last = trail[trail.length - 1];
    if (!last || Math.hypot(flying.x - last.x, flying.y - last.y) > 8) {
      trail.push({ x: flying.x, y: flying.y });
      if (trail.length > 24) trail.shift();
    }
    for (let i = 0; i < trail.length; i++) {
      const t = trail[i], k = (i + 1) / trail.length;
      ctx.globalAlpha = k * 0.45;
      ctx.fillStyle = i % 2 ? '#ffb347' : '#ff7043';
      ctx.beginPath(); ctx.arc(t.x, t.y, 1.5 + k * 3.5, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#222';
    ctx.beginPath(); ctx.arc(flying.x, flying.y, 5, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,160,40,.5)';
    ctx.beginPath(); ctx.arc(flying.x, flying.y, 9, 0, 7); ctx.fill();
  }

  // 爆炸
  if (explosion) {
    explosion.t += 0.08;
    const k = explosion.t;
    if (k >= 1) explosion = null;
    else {
      const r = explosion.r * (0.3 + k * 0.9);
      ctx.globalAlpha = 1 - k;
      const eg = ctx.createRadialGradient(explosion.x, explosion.y, 0, explosion.x, explosion.y, r);
      eg.addColorStop(0, '#fff3b0'); eg.addColorStop(0.5, '#ff9a3c'); eg.addColorStop(1, 'rgba(255,60,20,0)');
      ctx.fillStyle = eg;
      ctx.beginPath(); ctx.arc(explosion.x, explosion.y, r, 0, 7); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // 粒子
  ctx.fillStyle = '#ffb347';
  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i];
    s.x += s.vx; s.y += s.vy; s.vy += 0.25; s.life -= 0.03;
    if (s.life <= 0) { shots.splice(i, 1); continue; }
    ctx.globalAlpha = s.life;
    ctx.fillRect(s.x, s.y, 4, 4);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  ctx.setTransform(RES, 0, 0, RES, 0, 0);
  // 子弹时间滤镜：炮弹飞行期间叠加轻微冷色调，命中后消失
  if (flying) {
    ctx.fillStyle = 'rgba(70, 130, 255, 0.10)';
    ctx.fillRect(0, 0, W, H);
  }

  // 蓄力条
  if (charging) {
    power = powerFromCharge();
    updateAimHud();
  }
  $('powerBar').style.width = power + '%';

  requestAnimationFrame(draw);
}

function drawTank(p) {
  const x = p.x, y = p.y;
  const d = p.isYou ? dir : (p.dir || (x < W / 2 ? 1 : -1));
  ctx.save();
  ctx.translate(x, y);
  // 角色贴图：按朝向水平翻转（256×256原图缩放为52×52站立于地表）
  if (charImg.complete && charImg.naturalWidth) {
    ctx.save();
    ctx.scale(d, 1);
    ctx.drawImage(charImg, -26, -54, 52, 52);
    ctx.restore(); // restore会同时还原scale，后续文字不会镜像
  } else {
    // 贴图未加载时回退为简单坦克造型
    ctx.fillStyle = '#333';
    ctx.beginPath(); ctx.ellipse(0, -5, 18, 7, 0, 0, 7); ctx.fill();
    ctx.fillStyle = p.team === 0 ? '#e53935' : '#1e88e5';
    ctx.fillRect(-16, -20, 32, 14);
  }
  // 名字与血条
  ctx.fillStyle = 'rgba(0,0,0,.6)';
  ctx.fillRect(-30, -58, 60, 7);
  ctx.fillStyle = '#43d96a';
  ctx.fillRect(-30, -58, 60 * (p.hp / 1000), 7);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(p.name + (p.isYou ? '(你)' : ''), 0, -64);
  // 当前回合标记
  const activeIdx = players.filter(q => !q.spectator).indexOf(p);
  if (activeIdx === curTurnSlot && roomId) {
    ctx.fillStyle = '#ffd54a';
    ctx.beginPath();
    ctx.moveTo(0, -78); ctx.lineTo(-8, -90); ctx.lineTo(8, -90);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

/** 弹道预测轨迹：与服务器相同物理公式的点状抛物线（发射后消失） */
function drawAim(p) {
  const a = (angle * Math.PI) / 180;
  const speed = power * 0.1425;
  let x = p.x + Math.cos(a) * 22 * dir;
  let y = p.y - Math.sin(a) * 22 - 6;
  let vx = Math.cos(a) * speed * dir;
  let vy = -Math.sin(a) * speed;
  ctx.save();
  for (let step = 0; step < 500; step++) {
    x += vx * 0.7;
    y += vy * 0.7;
    vy += 0.28 * 0.7;
    x += wind * 0.012;
    if (x < 0 || x > W || y > H) break;
    if (step > 6 && mask[Math.round(y) * W + Math.round(x)] === 1) break;
    if (step % 4 === 0) {
      ctx.globalAlpha = Math.max(0.3, 1 - step / 320);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(0,0,0,.5)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill(); ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/** PVE怪物：小兵与Boss（渲染坐标逐帧逼近服务器坐标，移动平滑不瞬移） */
function drawMonsters() {
  for (const m of monsters) {
    if (!m.alive) continue;
    if (m.rx === undefined) { m.rx = m.x; m.ry = m.y; }
    const sp = 3; // 每帧最大逼近距离（约180px/秒，略快于怪物步速）
    m.rx += Math.max(-sp, Math.min(sp, m.x - m.rx));
    m.ry += Math.max(-sp, Math.min(sp, m.y - m.ry));
    ctx.save();
    ctx.translate(m.rx, m.ry);
    // 身体
    ctx.fillStyle = m.kind === 'boss' ? '#7b1fa2' : '#ff5252';
    ctx.beginPath(); ctx.arc(0, -m.r, m.r, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 2; ctx.stroke();
    // 眼睛
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(-m.r * 0.32, -m.r * 1.15, m.r * 0.24, 0, 7);
    ctx.arc(m.r * 0.32, -m.r * 1.15, m.r * 0.24, 0, 7);
    ctx.fill();
    ctx.fillStyle = '#222';
    ctx.beginPath();
    ctx.arc(-m.r * 0.32, -m.r * 1.15, m.r * 0.11, 0, 7);
    ctx.arc(m.r * 0.32, -m.r * 1.15, m.r * 0.11, 0, 7);
    ctx.fill();
    // 血条
    const bw = m.kind === 'boss' ? 64 : 36;
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    ctx.fillRect(-bw / 2, -m.r * 2 - 10, bw, 6);
    ctx.fillStyle = m.hp / m.maxHp > 0.4 ? '#ff9800' : '#ff3d00';
    ctx.fillRect(-bw / 2, -m.r * 2 - 10, bw * (m.hp / m.maxHp), 6);
    if (m.kind === 'boss') {
      ctx.fillStyle = '#ffd54a';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('BOSS', 0, -m.r * 2 - 15);
    }
    ctx.restore();
  }
}

buildTerrainTexture(terrain);
updateAimHud();

/* ---------- 音效初始化与开关 ---------- */
// 浏览器要求首次用户交互后才能播放音频
['pointerdown', 'keydown'].forEach(ev =>
  document.addEventListener(ev, () => SFX.init(), { once: false }));
// 所有按钮点击音
document.addEventListener('click', (e) => {
  if (e.target.closest('.btn')) SFX.play('click');
});
// 背景音乐开关
$('bgmBtn').onclick = () => {
  SFX.init();
  const on = SFX.toggleBgm();
  $('bgmBtn').textContent = on ? '🔊 音乐' : '🔇 静音';
};

draw();
