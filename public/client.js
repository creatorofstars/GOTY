/* 弹弹堂 Online 客户端 */
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const W = 1600, H = 900;
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

/** 确定性伪随机噪声（同一列每次重建结果一致） */
function hashN(x, seed) {
  const s = Math.sin(x * 12.9898 + seed * 78.233) * 43758.5453;
  return s - Math.floor(s);
}
/** 低频平滑噪声：以24px为段在相邻随机值间线性插值，避免逐列突变产生竖条纹 */
function smoothNoise(x, seed) {
  const seg = 24;
  const i = Math.floor(x / seg), f = (x - i * seg) / seg;
  const a = hashN(i, seed), b = hashN(i + 1, seed);
  return a + (b - a) * (f * f * (3 - 2 * f)); // smoothstep 插值
}

/** 分层地形贴图：草皮/泥土/岩石三层，每层带渐变与噪声，避免单调 */
function buildTerrainTexture(heightArr) {
  tctx.clearRect(0, 0, W, H);
  for (let x = 0; x < W; x++) {
    const top = Math.max(0, Math.round(heightArr[x] || H)); // 与碰撞网格完全一致
    if (top >= H) continue;
    const grassH = 8;
    const dirtH = 38 + Math.round(10 * Math.sin(x * 0.045) + 6 * Math.sin(x * 0.013));
    // 草皮：亮度用低频噪声平滑过渡，形成自然的明暗斑块而非竖条纹
    const gl = 36 + smoothNoise(x, 1) * 14;
    tctx.fillStyle = `hsl(96, 48%, ${gl}%)`;
    tctx.fillRect(x, top, 1, Math.min(grassH, H - top));
    tctx.fillStyle = `hsl(90, 55%, ${gl + 14}%)`;
    tctx.fillRect(x, top, 1, Math.min(3, H - top));
    // 泥土：暖棕，亮度和色相平滑微扰
    const dirtTop = top + grassH;
    const dd = Math.max(0, Math.min(dirtH, H - dirtTop));
    if (dd > 0) {
      const dl = 26 + smoothNoise(x, 2) * 10;
      tctx.fillStyle = `hsl(${24 + smoothNoise(x, 3) * 6}, 42%, ${dl}%)`;
      tctx.fillRect(x, dirtTop, 1, dd);
    }
    // 岩石：冷灰，亮度和色温平滑微扰
    const stoneTop = dirtTop + dd;
    if (stoneTop < H) {
      const sl = 34 + smoothNoise(x, 4) * 14;
      tctx.fillStyle = `hsl(${210 + smoothNoise(x, 5) * 14}, 7%, ${sl}%)`;
      tctx.fillRect(x, stoneTop, 1, H - stoneTop);
    }
  }
  // 噪声斑点：泥土小石子、岩石矿物斑（低透明度点缀）
  for (let i = 0; i < 1800; i++) {
    const x = Math.floor(hashN(i, 7) * W);
    const top = Math.max(0, Math.round(heightArr[x] || H));
    const r = hashN(i, 8);
    if (r < 0.4) { // 泥土层：深浅石子
      const y = top + 10 + Math.floor(hashN(i, 9) * 34);
      tctx.fillStyle = hashN(i, 10) > 0.5 ? 'rgba(0,0,0,.12)' : 'rgba(255,220,170,.08)';
      tctx.fillRect(x, y, 1, 1);
    } else { // 岩石层：矿物亮斑
      const y = top + 52 + Math.floor(hashN(i, 12) * (H - top - 60));
      if (y >= top + 52 && y < H) {
        tctx.fillStyle = 'rgba(255,255,255,.05)';
        tctx.fillRect(x, y, 1, 1);
      }
    }
  }
  // 斑驳噪声：逐像素随机明暗扰动（只作用于已绘制的地形像素），模拟自然斑驳质感
  const noiseImg = tctx.getImageData(0, 0, W, H);
  const px = noiseImg.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      if (px[idx + 3] === 0) continue; // 跳过天空
      const n = (hashN(x * 4919 + y * 7919, 21) - 0.5) * 30
              + (hashN(Math.floor(x / 5) * 131 + Math.floor(y / 5) * 73, 22) - 0.5) * 18; // 细颗粒 + 中尺度斑块
      px[idx]     = Math.max(0, Math.min(255, px[idx] + n));
      px[idx + 1] = Math.max(0, Math.min(255, px[idx + 1] + n));
      px[idx + 2] = Math.max(0, Math.min(255, px[idx + 2] + n * 0.8));
    }
  }
  tctx.putImageData(noiseImg, 0, 0);
  drawPlatforms();
  mask = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    const g = Math.round(heightArr[x] || H);
    for (let y = g; y < H; y++) mask[y * W + x] = 1;
  }
  for (const pf of platforms) {
    if (pf.shape === 'ellipse') {
      const cx = pf.x + pf.w / 2, cy = pf.y + pf.h / 2, rx = pf.w / 2, ry = pf.h / 2;
      for (let x = Math.max(0, pf.x); x < Math.min(W, pf.x + pf.w); x++)
        for (let y = Math.max(0, pf.y); y < Math.min(H, pf.y + pf.h); y++) {
          const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry;
          if (nx * nx + ny * ny <= 1) mask[y * W + x] = 1;
        }
    } else {
      for (let x = Math.max(0, pf.x); x < Math.min(W, pf.x + pf.w); x++)
        for (let y = Math.max(0, pf.y); y < Math.min(H, pf.y + pf.h); y++) mask[y * W + x] = 1;
    }
  }
}

/** 空中平台：卡通风格单色草绿圆角块 */
function drawPlatforms() {
  // 卡通浮空岛：单一草绿色圆角块 + 噪声斑驳（无描边、无分层）
  for (const pf of platforms) {
    const R = 12;
    tctx.save();
    rr(tctx, pf.x, pf.y, pf.w, pf.h, R);
    tctx.clip();
    tctx.fillStyle = '#6fbf44';
    tctx.fillRect(pf.x, pf.y, pf.w, pf.h);
    // 底部淡淡的暗带，增加一点体积感（同色系加深）
    tctx.fillStyle = 'rgba(0,0,0,.12)';
    tctx.fillRect(pf.x, pf.y + pf.h * 0.7, pf.w, pf.h * 0.3);
    // 噪声斑点：确定性伪随机，深浅两种绿
    const dots = Math.floor(pf.w * pf.h / 110);
    for (let i = 0; i < dots; i++) {
      const dx = pf.x + hashN(i * 3 + pf.x, pf.y + 1) * pf.w;
      const dy = pf.y + hashN(i * 5 + pf.y, pf.x + 2) * pf.h;
      tctx.fillStyle = hashN(i, pf.x + pf.y) > 0.5 ? 'rgba(0,0,0,.10)' : 'rgba(255,255,255,.10)';
      tctx.fillRect(dx, dy, 2, 2);
    }
    tctx.restore();
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
let angle = 45, power = 40, dir = 1;   // dir: 1 朝右, -1 朝左
let monsters = [];                     // PVE怪物
// 角色贴图：4种可选角色（房间内选择，局内生效）
const CHARS = ['/texture/char0.png', '/texture/char1.png', '/texture/char2.png', '/texture/char3.png'];
const charImgs = CHARS.map(src => { const i = new Image(); i.src = src; return i; });
const charImg = charImgs[0]; // 回退引用
/** 裁剪掉图片四周的透明像素，返回有效区域 {x,y,w,h}（解决素材居中留白导致的"悬空"） */
function trimImage(img) {
  try {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const cx2 = c.getContext('2d');
    cx2.drawImage(img, 0, 0);
    const d = cx2.getImageData(0, 0, c.width, c.height).data;
    let minX = c.width, minY = c.height, maxX = -1, maxY = -1;
    for (let y = 0; y < c.height; y++) {
      for (let px = 0; px < c.width; px++) {
        if (d[(y * c.width + px) * 4 + 3] > 16) {
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  } catch (e) { return null; }
}
charImgs.forEach(ci => ci.addEventListener('load', () => { ci.trim = trimImage(ci); }, { once: true }));
// 特殊炮弹贴图：四个角色均使用专属贴图（同样做透明裁剪）
const bulletImgs = {
  0: Object.assign(new Image(), { src: '/texture/oneBullet.png' }),
  1: Object.assign(new Image(), { src: '/texture/twoBullet.png' }),
  2: Object.assign(new Image(), { src: '/texture/threeBullet.png' }),
  3: Object.assign(new Image(), { src: '/texture/fourBullet.png' }),
};
Object.values(bulletImgs).forEach(bi => bi.addEventListener('load', () => { bi.trim = trimImage(bi); }, { once: true }));
// PVE怪物贴图：小兵用原图，Boss用换色版（载入后离屏合成紫色色调）
const enemyImg = new Image();
enemyImg.src = '/texture/enemy.png';
let bossImg = null;
enemyImg.onload = () => {
  bossImg = document.createElement('canvas');
  bossImg.width = enemyImg.naturalWidth;
  bossImg.height = enemyImg.naturalHeight;
  const bctx = bossImg.getContext('2d');
  bctx.drawImage(enemyImg, 0, 0);
  bctx.globalCompositeOperation = 'source-atop'; // 只叠在非透明像素上
  bctx.fillStyle = 'rgba(150, 60, 255, 0.5)';
  bctx.fillRect(0, 0, bossImg.width, bossImg.height);
};
let charging = false, chargeStart = 0;
let animating = false;
let shots = [];                 // 粒子特效
let floatTexts = [];            // 伤害飘字 {x,y,text,t,color}
/** 圆角矩形路径 */
function rr(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function addFloat(x, y, text, color) {
  floatTexts.push({ x, y, text, t: 0, color: color || '#ff5252' });
}
let explosions = [];            // 爆炸特效（可能多点）
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
    const lead = flying && flying.list && flying.list[0];
    if (lead) {
      // 聚焦进度0→1（0.75秒线性），位置与缩放同步逼近目标
      const p = Math.min(1, (performance.now() - cam.focusStart) / CAM_FOCUS_MS); // 聚焦进度只由已聚焦时长决定
      cam.s += (1 + (CAM_ZOOM - 1) * p - cam.s) * 0.18;
      const vw = W / cam.s, vh = H / cam.s;
      const tl = Math.max(0, Math.min(W - vw, lead.x - vw / 2));
      const tt = Math.max(0, Math.min(H - vh, lead.y - vh / 2));
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
  // 红蓝两队分列左右，中央VS；每个玩家带角色头像
  const CHARS_SHORT = CHAR_NAMES;
  const actives = r.players.filter(p => !p.spectator);
  for (let t = 0; t < 2; t++) {
    const ul = $('rsTeam' + t);
    if (!ul) continue;
    ul.innerHTML = '';
    const mates = actives.filter(p => p.team === t);
    for (const p of mates) {
      const li = document.createElement('li');
      const host = p.sid === r.hostSid ? '<span class="crown">👑</span>' : '';
      const cimg = CHARS[(p.char || 0) % CHARS.length];
      li.innerHTML = `<img src="${cimg}" alt=""><div class="pinfo2">${host}${escapeHtml(p.name)}${p.sid === socket.id ? ' (你)' : ''}</div><span class="chint">${CHARS_SHORT[p.char || 0]}</span>`;
      ul.appendChild(li);
    }
  }
  const vs = $('rsVs');
  if (vs) vs.textContent = isPveRoom(r) ? '👾' : 'VS';
  SFX.setBgm(r.mode === 'pve' && r.state === 'playing' ? 'battle' : 'lobby');
  const startBtn = $('rsStartBtn');
  const isPve = r.mode === 'pve';
  renderCharPick(r);
  const need = isPve ? 1 : 2;
  startBtn.style.display = isHost ? '' : 'none';
  startBtn.disabled = actives.length < need;
  const specs = r.players.filter(p => p.spectator);
  $('rsTip').textContent = (specs.length ? `👀 观战中：${specs.map(p => escapeHtml(p.name)).join('、')} · ` : '') +
    (actives.length < need
      ? `等待玩家加入…（当前 ${actives.length} 人，${isPve ? 'PVE 1 人即可开局' : '2 人以上可开局'}）`
      : `当前 ${actives.length} 名玩家${isPve ? '（PVE）' : ''}，房主可随时开始`);
});

function isPveRoom(r) { return r.mode === 'pve'; }

$('rsStartBtn').onclick = () => {
  // 浏览器要求全屏必须由用户点击触发，挂在"开始游戏"的点击上
  if (document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
  socket.emit('startGame');
};
// 底部栏收纳/展开
$('barToggle').onclick = () => {
  const g = $('game');
  const collapsed = g.classList.toggle('collapsed');
  $('barToggle').textContent = collapsed ? '▲ 展开' : '▼ 收起';
};
// 全屏切换
$('fsBtn').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
};

/** 角色选择：4个头像，点击更换；显示每个角色被谁选用 */
const CHAR_NAMES = ['轰侠', '影袭', '鹰眼', '疾风'];
const CHAR_PASSIVES = [
  '轰侠 · 被动：大范围爆炸 —— 炮弹爆炸半径+40%，基础伤害100%',
  '影袭 · 被动：致命一击 —— 炮弹有15%几率造成150%伤害（可被强化B叠加），基础伤害100%',
  '鹰眼 · 被动：追踪弹 —— 炮弹靠近敌人(150px内)时自动吸附，基础伤害75%',
  '疾风 · 被动：三连发 —— 每次发射扇形射出三枚炮弹，每发伤害45%',
];
function renderCharPick(r) {
  const el = $('charPick');
  if (!el || r.state !== 'waiting') { if (el) el.innerHTML = ''; return; }
  el.innerHTML = '';
  const takerOf = (idx) => r.players.filter(p => !p.spectator && (p.char || 0) === idx).map(p => p.name + (p.sid === socket.id ? '(你)' : ''));
  const myChar = (r.players.find(p => p.sid === socket.id) || {}).char || 0;
  for (let i = 0; i < CHARS.length; i++) {
    const div = document.createElement('div');
    div.className = 'cport' + (myChar === i ? ' mine' : '');
    const takers = takerOf(i).join('、');
    div.setAttribute('data-tip', CHAR_PASSIVES[i]);
    div.innerHTML = `<img src="${CHARS[i]}" alt="${CHAR_NAMES[i]}"><div class="pname">${CHAR_NAMES[i]}</div><div class="taker">${takers}</div>`;
    div.onclick = () => {
      if (myChar !== i) socket.emit('setChar', i);
    };
    el.appendChild(div);
  }
}
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
  SFX.setBgm(st.mode === 'pve' && st.state === 'playing' ? 'battle' : 'lobby');
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
  // 正常流程 shotEnd 先于本事件到达；无论如何都清掉飞行/动画状态，绝不把输入卡死在上一个回合
  if (animating) { flying = null; animating = false; }
  // 新回合开始意味着对局已在进行：收起胜负结算浮层（非房主不会触发rematch按钮，靠这里关闭）
  hideOverlay();
  cardUsed = false; renderCards(); // 注意：不清手牌，服务器在本回合开始时已发新牌
  $('timer').textContent = t.timeLeft;
  $('timer').classList.toggle('urgent', t.timeLeft <= 5);
  if (me) {
    me.points = t.points; me.extraShots = t.extraShots; me.critBonus = t.critBonus;
    me.dmgPct = t.dmgPct; me.flatDmg = t.flatDmg;
  }
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
  SFX.setBgm('lobby');
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
let aiming = false; // 正在调整角度（期间显示最小力度参考轨迹）
function startAngleAdj(d) {
  if (angleIv) return;
  aiming = true;
  angleIv = setInterval(() => {
    if (!myTurn()) { stopAngleAdj(); return; }
    setAngle(angle + d);
  }, 40);
}
function stopAngleAdj() { if (angleIv) { clearInterval(angleIv); angleIv = null; } aiming = false; }

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
  // 角度范围 10~90（相对朝向）：高于90°越过边界自动转身；低于10°直接钳住，可保持斜下角度不转身
  if (a > 90) { dir = -dir; a = 180 - a; }
  angle = Math.max(10, Math.round(a));
  if (me) me.dir = dir; // 同步自己的贴图朝向
  if (myTurn()) socket.emit('aim', { angle, power, dir });
  updateAimHud();
}
function setPower(p) {
  power = Math.max(40, Math.min(160, Math.round(p)));
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
  // 不再乐观置 animating：等服务器 shotBegin 确认起飞后再锁定输入，
  // 若这一炮被服务器拒绝（如回合恰好超时切换），输入不会被卡死
  stopMove();
}
function powerFromCharge() {
  const held = (performance.now() - chargeStart) / 1000;
  return Math.min(160, 40 + held * 60); // 40起步，约2秒蓄满160
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
  if (me) { angle = 45; power = 40; updateAimHud(); }
  renderCards();
  renderPoints();
}

function showOverlay(html) { const o = $('overlay'); o.innerHTML = `<div>${html}</div>`; o.classList.remove('hidden'); }
function hideOverlay() { $('overlay').classList.add('hidden'); }

/* ---------- 弹道动画（服务器32tick权威模拟，客户端插值渲染） ---------- */
socket.on('shotBegin', (d) => {
  SFX.play('shoot' + (d.char || 0)); // 按角色播放专属开火音效
  // 当前回合玩家若在本炮中阵亡，立即清除回合指示器
  if (curTurnSlot >= 0) {
    const cur = players.find(p => p.slot === curTurnSlot);
    if (cur && !cur.alive) curTurnSlot = -1;
  }
  // 每发发射物独立插值与拖尾（角色three一次三发）
  // 每发发射物：服务器速度用于本地外推（60fps平滑），tx/ty为服务器权威位置用于纠偏
  flying = {
    char: d.char || 0,
    ts: d.ts || 1,
    list: (d.shots || [{ x: d.x, y: d.y, vx: 0, vy: 0 }]).map(s => ({
      x: s.x, y: s.y, sx: s.x, sy: s.y, st: performance.now(), tx: s.x, ty: s.y,
      vx: s.vx || 0, vy: s.vy || 0, trail: [],
    })),
  };
  animating = true;
  cam.mode = 'follow'; // 镜头0.75秒内推近聚焦炮弹
  cam.focusStart = performance.now();
  cam.followUntil = performance.now() + CAM_FOCUS_MS;
});

// 服务器每个tick发来的权威位置：只记为目标点，渲染时逐帧逼近（客户端插值）
socket.on('shotTick', (d) => {
  if (flying) {
    // 炮弹还在飞：镜头聚焦动态续期（子弹时间会拉长飞行，固定750ms会提前收镜）
    cam.followUntil = Math.max(cam.followUntil, performance.now() + 250);
  }
  if (flying && d.pts) {
    for (let i = 0; i < flying.list.length && i < d.pts.length; i++) {
      const fl = flying.list[i];
      fl.sx = d.pts[i].x; fl.sy = d.pts[i].y; fl.st = performance.now(); // 最新服务器权威位置
      fl.tx = d.pts[i].x; fl.ty = d.pts[i].y;
      flying.list[i].vx = d.pts[i].vx || flying.list[i].vx;
      flying.list[i].vy = d.pts[i].vy || flying.list[i].vy;
    }
  }
});

socket.on('shotEnd', (data) => {
  try {
    const exs = data.explosions && data.explosions.length ? data.explosions : (data.explosion ? [data.explosion] : []);
    if (exs.length) {
      SFX.play('hit' + (flying ? flying.char || 0 : 0)); // 按角色播放专属命中音效
      for (const e of exs) {
        explosions.push({ ...e, t: 0 });
        for (let i = 0; i < 28; i++) {
          const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 5;
          shots.push({ x: e.x, y: e.y, vx: Math.cos(a)*sp, vy: Math.sin(a)*sp - 2, life: 1 });
        }
      }
      if (data.crit) {
        const e0 = exs[0];
        addFloat(e0.x, e0.y - 30, '暴击！', '#ffd54a');
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
    // 伤害飘字：在受伤者头顶显示实际伤害
    for (const d of data.damage || []) {
      const p = players.find(q => q.slot === d.slot);
      if (p) addFloat(p.x, p.y - 64, '-' + d.damage);
    }
    for (const md of data.mDmg || []) {
      addFloat(md.x, md.y - 20, '-' + md.damage, '#ff9100');
    }
    while (pendingFalls.length) applyFalls(pendingFalls.shift());
  } finally {
    // 无论处理过程是否出错，都必须释放动画状态，否则永远无法开火
    flying = null;
    updateHUD();
    setTimeout(() => { animating = false; }, 300);
  }
});

// 回合结束（开火或超时）：立即结束行动状态，怪物阶段/他人回合期间不能再蓄力瞄准
socket.on('turnEnd', () => {
  curTurnSlot = -1;
  curTurnSid = null;
  charging = false;
  stopMove();
  stopAngleAdj();
  updateHUD();
});

/* ---------- 卡牌手牌 ---------- */
let hand = [], cardUsed = false;
socket.on('hand', (d) => { hand = d.cards || []; cardUsed = false; renderCards(); });
socket.on('cardPlayed', (d) => {
  if (me && d.slot === me.slot) cardUsed = true;
  if (d.by) addChat(null, `${d.by} 打出了卡牌 ${d.card}`);
  renderCards();
});

/* ---------- 积分强化面板 ---------- */
const UPGRADES = [
  { id: 'a', name: '强化A', cost: 40,  desc: '追加一个发射物(30%伤害,可暴击)' },
  { id: 'b', name: '强化B', cost: 15,  desc: '暴击几率+8%' },
  { id: 'c', name: '强化C', cost: 60,  desc: '所有发射物伤害+30%' },
  { id: 'd', name: '强化D', cost: 25,  desc: '所有发射物伤害+20' },
  { id: 's', name: '强化S', cost: 200, desc: '伤害+100%（蓄积两回合）' },
];
function renderPoints() {
  const pv = $('pointsVal'), list = $('upgList');
  if (!pv || !list) return;
  pv.textContent = '积分 ' + (me ? (me.points || 0) : 0);
  const usable = myTurn();
  list.innerHTML = '';
  for (const u of UPGRADES) {
    const div = document.createElement('div');
    const afford = me && (me.points || 0) >= u.cost;
    div.className = 'upg' + (usable && afford ? '' : ' disabled');
    div.innerHTML = `<div class="uname"><span>${u.name}</span><span class="cost">${u.cost}</span></div><div class="udesc">${u.desc}</div>`;
    if (usable && afford) div.onclick = () => socket.emit('buyUpgrade', u.id);
    list.appendChild(div);
  }
}

function renderCards() {
  const el = $('cardHand');
  el.innerHTML = '';
  if (isSpectator || !hand.length) return;
  const usable = !cardUsed && !!me && me.alive !== false && curTurnSlot === mySlotRef();
  for (const c of hand) {
    const div = document.createElement('div');
    div.className = 'card' + (usable ? '' : ' disabled');
    div.innerHTML = `<div class="cemoji">${c.emoji}</div><div class="cname">${c.name}</div><div class="cdesc">${c.desc}</div>`;
    if (usable) div.onclick = () => socket.emit('playCard', c.id);
    el.appendChild(div);
  }
}
function mySlotRef() {
  const act = players.filter(p => !p.spectator);
  const cur = act[curTurnSlot];
  return cur ? cur.slot : -1;
}

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
  ctx.beginPath(); ctx.arc(1460, 110, 42, 0, 7); ctx.fill();

  // 地形（离屏画布，爆炸会实时擦除出圆形弹坑）
  ctx.drawImage(tcv, 0, 0);

  // 坦克
  const active = players.filter(p => !p.spectator);
  for (const p of active) {
    drawTank(p);
  }
  drawMonsters();

  // 瞄准指示
  // 蓄力时按当前力度显示轨迹；调整角度(W/S)期间显示最小力度(40)的参考轨迹
  if (myTurn() && me && !animating && (charging || aiming)) drawAim(me);

  // 飞行炮弹（支持多发射物：服务器位置插值 + 渐隐拖尾 + 专属贴图）
  if (flying && flying.list) {
    const bimg = bulletImgs[flying.char];
    // 显示平滑：目标 = 最新服务器位置 + 速度外推(距该包已过的时间)，显示坐标指数逼近目标
    const now = performance.now();
    const dt = Math.min(50, now - (flying.lastT || now));
    flying.lastT = now;
    const velMs = 0.7 * flying.ts * 0.096; // 服务器速度单位 → 像素/毫秒
    const smooth = 1 - Math.exp(-dt / 40); // 约40ms时间常数，既跟手又无拉锯
    for (const fl of flying.list) {
      const predX = fl.sx + fl.vx * velMs * (now - fl.st);
      const predY = fl.sy + fl.vy * velMs * (now - fl.st);
      fl.x += (predX - fl.x) * smooth;
      fl.y += (predY - fl.y) * smooth;
      const last = fl.trail[fl.trail.length - 1];
      if (!last || Math.hypot(fl.x - last.x, fl.y - last.y) > 8) {
        fl.trail.push({ x: fl.x, y: fl.y });
        if (fl.trail.length > 24) fl.trail.shift();
      }
      for (let i = 0; i < fl.trail.length; i++) {
        const t = fl.trail[i], k = (i + 1) / fl.trail.length;
        ctx.globalAlpha = k * 0.45;
        ctx.fillStyle = i % 2 ? '#ffb347' : '#ff7043';
        ctx.beginPath(); ctx.arc(t.x, t.y, 1.5 + k * 3.5, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (bimg && bimg.complete && bimg.trim) {
        const t = bimg.trim;
        const sc = 26 / Math.max(t.w, t.h); // 裁剪后最长边归一到26px
        const w = t.w * sc, h = t.h * sc;
        const ang = Math.atan2(fl.ty - fl.y, fl.tx - fl.x);
        ctx.save();
        ctx.translate(fl.x, fl.y);
        ctx.rotate(ang);
        ctx.drawImage(bimg, t.x, t.y, t.w, t.h, -w / 2, -h / 2, w, h);
        ctx.restore();
      } else {
        ctx.fillStyle = '#222';
        ctx.beginPath(); ctx.arc(fl.x, fl.y, 5, 0, 7); ctx.fill();
        ctx.fillStyle = 'rgba(255,160,40,.5)';
        ctx.beginPath(); ctx.arc(fl.x, fl.y, 9, 0, 7); ctx.fill();
      }
    }
  }

  // 爆炸（支持多个爆炸点，角色three三发各自爆炸）
  for (let i = explosions.length - 1; i >= 0; i--) {
    const ex = explosions[i];
    ex.t += 0.08;
    if (ex.t >= 1) { explosions.splice(i, 1); continue; }
    const r = ex.r * (0.3 + ex.t * 0.9);
    ctx.globalAlpha = 1 - ex.t;
    const eg = ctx.createRadialGradient(ex.x, ex.y, 0, ex.x, ex.y, r);
    eg.addColorStop(0, '#fff3b0'); eg.addColorStop(0.5, '#ff9a3c'); eg.addColorStop(1, 'rgba(255,60,20,0)');
    ctx.fillStyle = eg;
    ctx.beginPath(); ctx.arc(ex.x, ex.y, r, 0, 7); ctx.fill();
    ctx.globalAlpha = 1;
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
  // 伤害飘字：上浮并渐隐
  ctx.font = 'bold 26px sans-serif';
  ctx.textAlign = 'center';
  for (let i = floatTexts.length - 1; i >= 0; i--) {
    const f = floatTexts[i];
    f.t += 0.012;
    if (f.t >= 1) { floatTexts.splice(i, 1); continue; }
    ctx.globalAlpha = Math.min(1, (1 - f.t) * 1.6);
    ctx.fillStyle = 'rgba(0,0,0,.7)';
    ctx.fillText(f.text, f.x + 2, f.y - f.t * 56 + 2);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x, f.y - f.t * 56);
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
  $('powerBar').style.width = ((Math.max(40, Math.min(160, power)) - 40) / 120 * 100) + '%'; // 进度条在40~160间插值

  requestAnimationFrame(draw);
}

function drawTank(p) {
  const x = p.x, y = p.y;
  const d = p.isYou ? dir : (p.dir || (x < W / 2 ? 1 : -1));
  ctx.save();
  ctx.translate(x, y);
  // 坡度：取脚下左右两点地面高度，角色随之倾斜而不是保持水平
  const xa = Math.max(0, Math.min(W - 1, Math.round(x - 14)));
  const xb = Math.max(0, Math.min(W - 1, Math.round(x + 14)));
  const ya = groundBelowLocal(xa, y - 8), yb = groundBelowLocal(xb, y - 8);
  const slope = (ya >= H || yb >= H) ? 0 : Math.atan2(yb - ya, xb - xa); // 脚下无地面时保持水平
  ctx.save();
  ctx.rotate(slope);
  // 角色贴图：按所选角色绘制。素材原生朝左，dir=1（朝右）时镜像翻转
  const cimg = charImgs[(p.char || 0) % charImgs.length];
  if (cimg.complete && cimg.naturalWidth) {
    ctx.save();
    ctx.scale(-d, 1);
    if (cimg.trim) {
      // 用修剪后的有效区域绘制：底部贴合地面，整体高度52px
      const t = cimg.trim;
      const sc = 52 / t.h;
      const w = t.w * sc, h = t.h * sc;
      ctx.drawImage(cimg, t.x, t.y, t.w, t.h, -w / 2, -h, w, h);
    } else {
      ctx.drawImage(cimg, -26, -54, 52, 52);
    }
    ctx.restore(); // 还原镜像
  } else {
    // 贴图未加载时回退为简单坦克造型
    ctx.fillStyle = '#333';
    ctx.beginPath(); ctx.ellipse(0, -5, 18, 7, 0, 0, 7); ctx.fill();
    ctx.fillStyle = p.team === 0 ? '#e53935' : '#1e88e5';
    ctx.fillRect(-16, -20, 32, 14);
  }
  ctx.restore(); // 结束坡度旋转：血条与名字始终保持水平
  // 名字与血条（圆角、水平）
  ctx.fillStyle = 'rgba(0,0,0,.6)';
  rr(ctx, -30, -72, 60, 7, 3.5); ctx.fill();
  if (p.hp > 0) {
    ctx.fillStyle = '#43d96a';
    rr(ctx, -30, -72, Math.max(6, 60 * (p.hp / 1000)), 7, 3.5); ctx.fill();
  }
  ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(p.name + (p.isYou ? '(你)' : ''), 0, -79);
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
    // 坡度：与玩家一致，随脚下地面倾斜
    const mxa = Math.max(0, Math.min(W - 1, Math.round(m.rx - 14)));
    const mxb = Math.max(0, Math.min(W - 1, Math.round(m.rx + 14)));
    const mya = groundBelowLocal(mxa, m.ry - 8), myb = groundBelowLocal(mxb, m.ry - 8);
    ctx.save();
    ctx.rotate((mya >= H || myb >= H) ? 0 : Math.atan2(myb - mya, mxb - mxa));
    // 贴图：小兵用原图，Boss用换色版；按朝向水平翻转（站在左侧朝右，右侧朝左）
    const img = m.kind === 'boss' ? bossImg : enemyImg;
    if (img && (img.naturalWidth || img.width)) {
      const d = m.x < W / 2 ? 1 : -1;
      const size = m.r * 2.6;
      ctx.save();
      ctx.scale(d, 1);
      ctx.drawImage(img, -size / 2, -size, size, size); // 立于地表
      ctx.restore();
    } else {
      // 贴图未加载时回退为简单圆球
      ctx.fillStyle = m.kind === 'boss' ? '#7b1fa2' : '#ff5252';
      ctx.beginPath(); ctx.arc(0, -m.r, m.r, 0, 7); ctx.fill();
    }
    ctx.restore(); // 结束坡度旋转：血条始终保持水平
    // 血条（圆角、水平）
    const bw = m.kind === 'boss' ? 64 : 36;
    const by = -m.r * 2.6 - 14;
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    rr(ctx, -bw / 2, by, bw, 6, 3); ctx.fill();
    if (m.hp > 0) {
      ctx.fillStyle = m.hp / m.maxHp > 0.4 ? '#ff9800' : '#ff3d00';
      rr(ctx, -bw / 2, by, Math.max(5, bw * (m.hp / m.maxHp)), 6, 3); ctx.fill();
    }
    if (m.kind === 'boss') {
      ctx.fillStyle = '#ffd54a';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('BOSS', 0, by - 5);
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
