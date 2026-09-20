/* 弹弹堂 Online 客户端 */
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
ctx.imageSmoothingEnabled = true;
ctx.imageSmoothingQuality = 'high';
const W = 1920, H = 1080;
const RES = 1; // 渲染分辨率与显示尺寸1:1（1920x1080），避免多级缩放带来的锯齿
cv.width = W * RES;
cv.height = H * RES;

const socket = io({ transports: ['websocket', 'polling'] }); // 优先WebSocket，跳过polling起步
let myName = '';
// 断线重连：服务器发放的会话令牌持久保存在本地，重连/刷新后凭它找回对局
let sessToken = localStorage.getItem('ddt_token') || '';
socket.on('session', ({ token }) => { sessToken = token; localStorage.setItem('ddt_token', token); });
// 每次连接建立（含socket.io自动重连、页面刷新后的首次连接）都尝试恢复对局；无有效会话时服务器静默忽略
socket.on('connect', () => {
  $('dcBanner').classList.add('hidden');
  if (sessToken) socket.emit('resume', sessToken);
});
socket.on('disconnect', () => { $('dcBanner').classList.remove('hidden'); });
let roomId = null;
let isSpectator = false;
let terrain = new Float32Array(W);
let mapMode = 'random';                   // 当前地图：random | castle（决定贴图风格与背景）
const castleBg = new Image(); castleBg.src = '/texture/castleBackground.jpg';
// 2D 可破坏地形：离屏画布（显示）+ 实心网格（本地碰撞预估，权威在服务器）
const tcv = document.createElement('canvas');
tcv.width = W; tcv.height = H;
const tctx = tcv.getContext('2d');
tctx.imageSmoothingEnabled = true;
tctx.imageSmoothingQuality = 'high';
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

/** 地面柱体：草皮/泥土/岩石三层，每层带渐变与噪声 */
function drawGroundColumn(x, top) {
  const grassH = 8;
  const dirtH = 38 + Math.round(5 * Math.sin(x * 0.045) + 3 * Math.sin(x * 0.013));
  // 草皮：亮度用低频噪声平滑过渡，形成自然的明暗斑块而非竖条纹
  const gl = 36 + smoothNoise(x, 1) * 7;
  tctx.fillStyle = `hsl(96, 48%, ${gl}%)`;
  tctx.fillRect(x, top, 1, Math.min(grassH, H - top));
  tctx.fillStyle = `hsl(90, 55%, ${gl + 14}%)`;
  tctx.fillRect(x, top, 1, Math.min(3, H - top));
  // 泥土：暖棕，亮度和色相平滑微扰
  const dirtTop = top + grassH;
  const dd = Math.max(0, Math.min(dirtH, H - dirtTop));
  if (dd > 0) {
    const dl = 26 + smoothNoise(x, 2) * 5;
    tctx.fillStyle = `hsl(${24 + smoothNoise(x, 3) * 6}, 42%, ${dl}%)`;
    tctx.fillRect(x, dirtTop, 1, dd);
  }
  // 岩石：冷灰，亮度和色温平滑微扰
  const stoneTop = dirtTop + dd;
  if (stoneTop < H) {
    const sl = 34 + smoothNoise(x, 4) * 7;
    tctx.fillStyle = `hsl(${210 + smoothNoise(x, 5) * 14}, 7%, ${sl}%)`;
    tctx.fillRect(x, stoneTop, 1, H - stoneTop);
  }
}

/** 分层地形贴图：按地图模式绘制城堡石材或地面层 */
function buildTerrainTexture(heightArr) {
  tctx.clearRect(0, 0, W, H);
  for (let x = 0; x < W; x++) {
    const top = Math.max(0, Math.round(heightArr[x] || H)); // 与碰撞网格完全一致
    if (top >= H) continue;
    if (mapMode === 'castle' && top < 790) {
      // 城堡结构柱体：暖灰石材 + 砖缝，画到平地高度为止；底部之下回归地面材质
      const gl = 40 + smoothNoise(x, 1) * 12;
      // 与服务端 genCastleTerrain 平地公式一致：逐列计算当地地面高度，石体与草地严丝合缝
      const groundLvl = Math.round(H * 0.78 + Math.sin(x * 0.006) * 8 + Math.sin(x * 0.021 + 2) * 4);
      const stoneBottom = Math.min(H, groundLvl);
      tctx.fillStyle = `hsl(34, 14%, ${gl + 18}%)`;
      tctx.fillRect(x, top, 1, stoneBottom - top);
      tctx.fillStyle = `hsl(38, 20%, ${gl + 30}%)`;
      tctx.fillRect(x, top, 1, Math.min(5, stoneBottom - top)); // 石帽亮边
      for (let y = top + 14; y < stoneBottom; y += 16) {
        const bandShift = (Math.floor((y - top) / 16) % 2) * 14; // 每行错缝
        tctx.fillStyle = 'rgba(0,0,0,.14)';
        tctx.fillRect(x, y, 1, 1);
        if (((x + bandShift) % 28) === 0) tctx.fillRect(x, y, 1, 15);
      }
      if (stoneBottom < H) drawGroundColumn(x, groundLvl);
    } else {
      // 地面（城堡地图的平地与随机地图通用）：草皮/泥土/岩石三层
      drawGroundColumn(x, top);
    }
  }
  // 噪声斑点：泥土小石子、岩石矿物斑（低透明度点缀）；约6%为2~3px大石块（大颗粒稀疏）
  for (let i = 0; i < 1800; i++) {
    const x = Math.floor(hashN(i, 7) * W);
    const top = Math.max(0, Math.round(heightArr[x] || H));
    const r = hashN(i, 8);
    const bigStone = hashN(i, 11) > 0.94;
    const sw = bigStone ? 2 + Math.floor(hashN(i, 13) * 2) : 1;
    if (r < 0.4) { // 泥土层：深浅石子
      const y = top + 10 + Math.floor(hashN(i, 9) * 34);
      tctx.fillStyle = hashN(i, 10) > 0.5 ? 'rgba(0,0,0,.12)' : 'rgba(255,220,170,.08)';
      tctx.fillRect(x, y, sw, sw);
    } else { // 岩石层：矿物亮斑
      const y = top + 52 + Math.floor(hashN(i, 12) * (H - top - 60));
      if (y >= top + 52 && y < H) {
        tctx.fillStyle = 'rgba(255,255,255,.05)';
        tctx.fillRect(x, y, sw, sw);
      }
    }
  }
  // 细颗粒逐像素噪声（密集小颗粒质感）
  const noiseImg = tctx.getImageData(0, 0, W, H);
  const px = noiseImg.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      if (px[idx + 3] === 0) continue; // 跳过天空
      const n = (hashN(x * 4919 + y * 7919, 21) - 0.5) * 30;
      px[idx]     = Math.max(0, Math.min(255, px[idx] + n));
      px[idx + 1] = Math.max(0, Math.min(255, px[idx + 1] + n));
      px[idx + 2] = Math.max(0, Math.min(255, px[idx + 2] + n * 0.8));
    }
  }
  tctx.putImageData(noiseImg, 0, 0);
  // 中、大斑块：随机旋转的不规则凸多边形（5~7边），只染在已绘制地形上（source-atop裁剪）
  // 中斑块小而密集（~700个，半径6~14px），大斑块大而稀疏（~90个，半径24~52px）
  tctx.globalCompositeOperation = 'source-atop';
  const drawBlotch = (i, rMin, rMax, alpha) => {
    const cx = hashN(i, 31) * W;
    const cy = hashN(i, 32) * H;
    const R = rMin + hashN(i, 33) * (rMax - rMin);
    const sides = 5 + Math.floor(hashN(i, 34) * 3); // 5/6/7边形
    const rot = hashN(i, 35) * Math.PI * 2;          // 随机旋转角
    tctx.fillStyle = hashN(i, 36) > 0.5
      ? `rgba(0,0,0,${(alpha * (0.6 + hashN(i, 37) * 0.4)).toFixed(3)})`
      : `rgba(255,244,220,${(alpha * (0.6 + hashN(i, 37) * 0.4)).toFixed(3)})`;
    tctx.beginPath();
    for (let k = 0; k < sides; k++) {
      const a = rot + (k / sides) * Math.PI * 2;
      const rr = R * (0.72 + hashN(i * 97 + k, 38) * 0.56); // 顶点半径抖动（保持凸性幅度内）
      const vx = cx + Math.cos(a) * rr, vy = cy + Math.sin(a) * rr * 0.8; // 略压扁更自然
      if (k === 0) tctx.moveTo(vx, vy); else tctx.lineTo(vx, vy);
    }
    tctx.closePath();
    tctx.fill();
  };
  for (let i = 0; i < 700; i++) drawBlotch(i, 6, 14, 0.07);        // 中斑块：密集
  for (let i = 0; i < 90; i++) drawBlotch(5000 + i, 24, 52, 0.10); // 大斑块：稀疏
  tctx.globalCompositeOperation = 'source-over';
  if (mapMode === 'castle') drawCastleWindows(heightArr);
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
    } else if (pf.shape === 'vine') {
      // 与服务端 buildMask 完全一致的波状藤干（4px芯）
      const cx = pf.x + pf.w / 2;
      for (let y = Math.max(0, pf.y); y < Math.min(H, pf.y + pf.h); y++) {
        const xc = Math.round(cx + Math.sin((y - pf.y) * 0.08 + (pf.phase || 0)) * 4);
        for (let x = Math.max(0, xc - 2); x <= Math.min(W - 1, xc + 2); x++) mask[y * W + x] = 1;
      }
    } else {
      for (let x = Math.max(0, pf.x); x < Math.min(W, pf.x + pf.w); x++)
        for (let y = Math.max(0, pf.y); y < Math.min(H, pf.y + pf.h); y++) mask[y * W + x] = 1;
    }
  }
}

/** 城堡窗户与大门（纯装饰，不参与碰撞；只画在实心石体内） */
function drawCastleWindows(heightArr) {
  const solid = (cx, y) => (heightArr[Math.max(0, Math.min(W - 1, cx))] || H) < y;
  // 拱形窗：浅色石框 + 深色/暖光窗洞 + 中竖棂
  function archWin(cx, cy, w, h, lit) {
    if (!solid(cx, cy - h / 2)) return;
    const hw = w / 2, arcR = hw;
    const path = new Path2D();
    path.moveTo(cx - hw, cy + h / 2);
    path.lineTo(cx - hw, cy - h / 2 + arcR);
    path.arc(cx, cy - h / 2 + arcR, arcR, Math.PI, 0);
    path.lineTo(cx + hw, cy + h / 2);
    path.closePath();
    // 石框：先填外拱，再用略小的内拱盖出窗洞，边缘自然露出3px框
    tctx.fillStyle = '#ded2ba';
    tctx.fill(path);
    const inner = new Path2D();
    const ihw = hw - 3;
    inner.moveTo(cx - ihw, cy + h / 2);
    inner.lineTo(cx - ihw, cy - h / 2 + ihw);
    inner.arc(cx, cy - h / 2 + ihw, ihw, Math.PI, 0);
    inner.lineTo(cx + ihw, cy + h / 2);
    inner.closePath();
    if (lit) {
      const g = tctx.createLinearGradient(cx, cy - h / 2, cx, cy + h / 2);
      g.addColorStop(0, '#ffe9a8'); g.addColorStop(1, '#ff9d3c');
      tctx.fillStyle = g;
    } else {
      tctx.fillStyle = '#2e3a55';
    }
    tctx.fill(inner);
    // 中竖棂
    tctx.fillStyle = lit ? 'rgba(120,70,20,.55)' : 'rgba(200,210,230,.35)';
    tctx.fillRect(cx - 1, cy - h / 2 + ihw, 2, h - ihw);
  }
  // 左塔 / 右塔：每塔3扇竖窗；主堡：3扇大窗 + 底部大门
  const towerWins = [870, 1290];
  for (const cx of towerWins) {
    archWin(cx, 460, 46, 34, hashN(cx, 41) < 0.4);
    archWin(cx, 540, 46, 34, hashN(cx, 42) < 0.4);
    archWin(cx, 620, 46, 34, hashN(cx, 43) < 0.4);
  }
  archWin(1016, 380, 54, 40, true);
  archWin(1080, 380, 54, 40, hashN(1080, 44) < 0.4);
  archWin(1144, 380, 54, 40, false);
  archWin(1080, 480, 54, 40, hashN(1081, 45) < 0.4);
  // 主堡底部装饰大门（木质双扇 + 拱顶）
  const gx = 1080, gTop = 780, gBot = Math.round(H * 0.78 + Math.sin(1080 * 0.006) * 8 + Math.sin(1080 * 0.021 + 2) * 4) + 4, gw = 88;
  if (solid(gx, gTop)) {
    const door = new Path2D();
    door.moveTo(gx - gw / 2, gBot);
    door.lineTo(gx - gw / 2, gTop + gw / 2);
    door.arc(gx, gTop + gw / 2, gw / 2, Math.PI, 0);
    door.lineTo(gx + gw / 2, gBot);
    door.closePath();
    tctx.fillStyle = '#4a3524';
    tctx.fill(door);
    tctx.fillStyle = 'rgba(255,220,160,.15)';
    tctx.fillRect(gx - 1, gTop + 8, 2, gBot - gTop - 8); // 门缝
    tctx.strokeStyle = 'rgba(30,20,10,.5)'; tctx.lineWidth = 2;
    tctx.stroke(door);
  }
}

/** 空中平台与藤蔓：草绿圆角块 / 波状藤干+叶片 */
function drawPlatforms() {
  // 卡通浮空岛：单一草绿色圆角块 + 噪声斑驳（无描边、无分层）
  for (const pf of platforms) {
    if (pf.shape === 'vine') { drawVine(pf); continue; }
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

/** 藤蔓：波状藤干（与碰撞芯一致）+ 交替叶片 + 底端卷须 */
function drawVine(pf) {
  const cx = pf.x + pf.w / 2, ph = pf.phase || 0;
  const xc = y => cx + Math.sin((y - pf.y) * 0.08 + ph) * 4;
  tctx.save();
  // 藤干：双线描出宽度，深绿描边+亮绿芯
  tctx.beginPath();
  for (let y = pf.y; y <= pf.y + pf.h; y += 2) (y === pf.y) ? tctx.moveTo(xc(y), y) : tctx.lineTo(xc(y), y);
  tctx.strokeStyle = '#2e5b1e'; tctx.lineWidth = 5; tctx.lineCap = 'round'; tctx.stroke();
  tctx.strokeStyle = '#4e8f2f'; tctx.lineWidth = 2.5; tctx.stroke();
  // 叶片：沿藤干两侧交替，五瓣小叶（三短弧近似）
  for (let y = pf.y + 12; y < pf.y + pf.h - 6; y += 18) {
    const side = ((y - pf.y) / 18) % 2 === 0 ? 1 : -1;
    const lx = xc(y) + side * 4, ly = y;
    const ang = side * 0.9;
    tctx.save();
    tctx.translate(lx, ly); tctx.rotate(ang);
    tctx.fillStyle = hashN(y + pf.x, 61) > 0.5 ? '#4e8f2f' : '#3f7d2c';
    tctx.beginPath();
    tctx.ellipse(7, 0, 8, 4.5, 0, 0, 7);
    tctx.fill();
    tctx.fillStyle = 'rgba(255,255,255,.14)';
    tctx.beginPath(); tctx.ellipse(7, -1, 4, 1.6, 0, 0, 7); tctx.fill();
    tctx.restore();
  }
  // 底端卷须：小螺旋
  tctx.beginPath();
  const ex = xc(pf.y + pf.h), ey = pf.y + pf.h;
  for (let ang = 0; ang < 3.14 * 3; ang += 0.2) {
    const r = 5 * (1 - ang / (3.14 * 3));
    const px2 = ex + Math.cos(ang + ph) * r, py2 = ey + 6 + Math.sin(ang + ph) * r * 0.8 + ang * 0.8;
    ang === 0 ? tctx.moveTo(px2, py2) : tctx.lineTo(px2, py2);
  }
  tctx.strokeStyle = '#4e8f2f'; tctx.lineWidth = 2; tctx.stroke();
  tctx.restore();
}

/** 按爆炸圆域整圆擦除贴图与本地mask（藤蔓叶片/卷须比碰撞芯宽，逐run擦会残留装饰像素） */
function eraseBoomCircle(cx, cy, r) {
  tctx.save();
  tctx.beginPath(); tctx.arc(cx, cy, r, 0, 7); tctx.clip();
  tctx.clearRect(cx - r - 1, cy - r - 1, r * 2 + 2, r * 2 + 2);
  tctx.restore();
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H - 1, Math.ceil(cy + r));
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    const dx = x - cx, dy = y - cy;
    if (dx * dx + dy * dy <= r * r) mask[y * W + x] = 0;
  }
}

function applyTerrainRuns(runs) {
  // 1. 先清除弹坑本体（必须在收集烧焦边之前，否则弹坑内部会被误染黑）
  for (const r of runs) {
    tctx.clearRect(r.x, r.y0, 1, r.y1 - r.y0 + 1);
    for (let y = r.y0; y <= r.y1; y++) mask[y * W + r.x] = 0;
  }  // 2. 渐变焦痕带：由坑缘向外4px（4环），透明度逐环递减形成渐变
  const done = new Set();
  let frontier = [];
  for (const r of runs) {
    for (let y = r.y0; y <= r.y1; y++) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = r.x + dx, ny = y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H || mask[ny * W + nx] !== 1) continue;
        const key = ny * W + nx;
        if (done.has(key)) continue;
        done.add(key); frontier.push([nx, ny]);
      }
    }
  }
  const bands = ['rgba(10,10,10,0.9)', 'rgba(10,10,10,0.72)', 'rgba(10,10,10,0.56)', 'rgba(10,10,10,0.42)',
                 'rgba(10,10,10,0.3)', 'rgba(10,10,10,0.2)', 'rgba(10,10,10,0.12)', 'rgba(10,10,10,0.07)', 'rgba(10,10,10,0.03)'];
  for (const color of bands) {
    tctx.fillStyle = color;
    for (const [x, y] of frontier) tctx.fillRect(x, y, 1, 1);
    const next = [];
    for (const [x, y] of frontier) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H || mask[ny * W + nx] !== 1) continue;
        const key = ny * W + nx;
        if (done.has(key)) continue;
        done.add(key); next.push([nx, ny]);
      }
    }
    frontier = next;
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
charImgs.forEach(ci => ci.addEventListener('load', () => {
  ci.trim = trimImage(ci);
  // 高质量烘焙：分两步缩放到显示尺寸（52px），运行时只做温和重采样，消除摩尔纹
  if (ci.trim) {
    const t = ci.trim, h = 52, w = Math.max(1, Math.round(t.w * h / t.h));
    ci.baked = { cv: bakeImage(ci, t, w, h), w, h };
  }
}, { once: true }));
/** 两步高质量缩放烘焙：先对半缩（256→~104），再缩到目标尺寸 */
function bakeImage(srcImg, t, dw, dh) {
  let src = srcImg, sx = t.x, sy = t.y, sw = t.w, sh = t.h;
  if (sw > dw * 2 || sh > dh * 2) {
    const mid = document.createElement('canvas');
    mid.width = Math.max(dw, Math.ceil(sw / 2));
    mid.height = Math.max(dh, Math.ceil(sh / 2));
    const m = mid.getContext('2d');
    m.imageSmoothingEnabled = true; m.imageSmoothingQuality = 'high';
    m.drawImage(srcImg, sx, sy, sw, sh, 0, 0, mid.width, mid.height);
    src = mid; sx = 0; sy = 0; sw = mid.width; sh = mid.height;
  }
  const c = document.createElement('canvas');
  c.width = dw; c.height = dh;
  const b = c.getContext('2d');
  b.imageSmoothingEnabled = true; b.imageSmoothingQuality = 'high';
  b.drawImage(src, sx, sy, sw, sh, 0, 0, dw, dh);
  return c;
}
// 特殊炮弹贴图：四个角色均使用专属贴图（同样做透明裁剪）
const bulletImgs = {
  0: Object.assign(new Image(), { src: '/texture/oneBullet.png' }),
  1: Object.assign(new Image(), { src: '/texture/twoBullet.png' }),
  2: Object.assign(new Image(), { src: '/texture/threeBullet.png' }),
  3: Object.assign(new Image(), { src: '/texture/fourBullet.png' }),
};
Object.values(bulletImgs).forEach(bi => bi.addEventListener('load', () => {
  bi.trim = trimImage(bi);
  // 烘焙到显示尺寸（最长边26px），运行时直接1:1绘制
  if (bi.trim) {
    const t = bi.trim, k = 26 / Math.max(t.w, t.h);
    const w = Math.max(1, Math.round(t.w * k)), h = Math.max(1, Math.round(t.h * k));
    bi.baked = { cv: bakeImage(bi, t, w, h), w, h };
  }
}, { once: true }));
// PVE怪物贴图：小兵用原图，Boss用换色版（载入后离屏合成紫色色调）
const enemyImg = new Image();
enemyImg.src = '/texture/enemy.png';
let bossImg = null;
enemyImg.onload = () => {
  // 烘焙小兵贴图（显示尺寸约58px）
  const et = trimImage(enemyImg);
  if (et) {
    const k = 58 / Math.max(et.w, et.h);
    enemyImg.baked = { cv: bakeImage(enemyImg, et, Math.max(1, Math.round(et.w * k)), Math.max(1, Math.round(et.h * k))), w: Math.max(1, Math.round(et.w * k)), h: Math.max(1, Math.round(et.h * k)) };
  }
  bossImg = document.createElement('canvas');
  bossImg.width = enemyImg.naturalWidth;
  bossImg.height = enemyImg.naturalHeight;
  const bctx = bossImg.getContext('2d');
  bctx.drawImage(enemyImg, 0, 0);
  bctx.globalCompositeOperation = 'source-atop'; // 只叠在非透明像素上
  bctx.fillStyle = 'rgba(150, 60, 255, 0.5)';
  bctx.fillRect(0, 0, bossImg.width, bossImg.height);
  const bt = trimImage(bossImg);
  if (bt) {
    const k = 58 / Math.max(bt.w, bt.h);
    bossImg.baked = { cv: bakeImage(bossImg, bt, Math.max(1, Math.round(bt.w * k)), Math.max(1, Math.round(bt.h * k))), w: Math.max(1, Math.round(bt.w * k)), h: Math.max(1, Math.round(bt.h * k)) };
  }
};
let charging = false, chargeStart = 0;
// 帧率与延迟显示
let fpsFrames = 0, fpsLast = performance.now(), lastPingSent = 0;
let lastRtt = null;
const rttHistory = []; // 最近5次延迟取平均，消除毛刺
function netTick(now) {
  fpsFrames++;
  if (now - fpsLast >= 500) {
    const fps = Math.round(fpsFrames * 1000 / (now - fpsLast));
    fpsFrames = 0; fpsLast = now;
    const transport = (socket.io && socket.io.engine) ? socket.io.engine.transport.name.toUpperCase() : '--';
    const avg = rttHistory.length ? Math.round(rttHistory.reduce((a, b) => a + b, 0) / rttHistory.length) : null;
    $('netHud').textContent = tf('fps_ping', { fps, rtt: avg == null ? '--' : avg + 'ms', tp: transport });
  }
  if (now - lastPingSent >= 2000) {
    lastPingSent = now;
    socket.emit('lat:ping', () => {
      lastRtt = Math.round(performance.now() - lastPingSent);
      rttHistory.push(lastRtt);
      if (rttHistory.length > 5) rttHistory.shift();
    });
  }
}
let lastFiredAngle = null; // 上一次发射的局部角：对局中作为后续回合的默认角度（首发射击前为null=45）
let showColliders = false; // 作弊指令 iseeall：显示全部碰撞体
let lastPower = null; // 上一次发射的蓄力进度（进度条上的淡蓝标记）
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
function addFloat(x, y, text, color, size = 26) {
  floatTexts.push({ x, y, text, t: 0, color: color || '#ff5252', size });
}
let explosions = [];            // 爆炸特效（可能多点）
let flying = null;              // {points, idx, x, y}
let clouds = Array.from({length: 6}, () => ({ x: Math.random()*W, y: 40+Math.random()*160, s: .2+Math.random()*.5 }));

/* ---------- 摄像机 ----------
   发射后镜头在0.75秒内推近聚焦炮弹（跟随飞行）；
   0.75秒后回到正常视野；若子弹提前命中，立即提前恢复 */
const cam = { s: 1, left: 0, top: 0, mode: 'idle', t: 0, ox: 0, oy: 0, shake: null };
const CAM_ZOOM = 1.92; // 1.6 * 1.2：场景放大20%
const CAM_FOCUS_MS = 750; // 聚焦动画时长
const SKY_HEADROOM = 420; // 镜头可上探的天空余量（高飞炮弹仍可见）
const HOLD_TICKS = 28;    // 命中后镜头保持聚焦的时长（tick）

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
      const tt = Math.max(-SKY_HEADROOM, Math.min(H - vh, lead.y - vh / 2)); // 顶部留出天空余量，高飞炮弹可见
      cam.left += (tl - cam.left) * 0.22;
      cam.top += (tt - cam.top) * 0.22;
    }
  } else if (cam.mode === 'shake' && cam.shake) {
    // 命中震屏：保持满变焦聚焦命中点，叠加衰减抖动，结束后才收镜
    const now = performance.now();
    const dt = Math.min(50, now - (cam.lastT || now));
    cam.lastT = now;
    const sh = cam.shake;
    sh.t += dt / (1000 / 32); // 以32tick为计量单位累计震屏时长
    const pr = Math.min(1, sh.t / sh.durTicks);
    cam.s += (CAM_ZOOM - cam.s) * 0.15;
    const vw = W / cam.s, vh = H / cam.s;
    const tl = Math.max(0, Math.min(W - vw, sh.x - vw / 2));
    const tt = Math.max(-SKY_HEADROOM, Math.min(H - vh, sh.y - vh / 2));
    cam.left += (tl - cam.left) * 0.22;
    cam.top += (tt - cam.top) * 0.22;
    const m = sh.mag * (1 - pr) * (1 - pr);
    cam.ox = (Math.random() - 0.5) * 2 * m;
    cam.oy = (Math.random() - 0.5) * 2 * m;
    if (sh.t >= sh.durTicks) {
      cam.ox = 0; cam.oy = 0;
      if (cam.holdTicks > 0) cam.mode = 'hold'; // 保持聚焦命中点，等同轮后续命中
      else { cam.shake = null; cam.mode = 'return'; }
    }
  } else if (cam.mode === 'hold' && cam.shake) {
    // 命中后保持聚焦：等待同轮后续命中（疾风三连发/二次爆破），holdTicks归零才收回
    const now = performance.now();
    const dt = Math.min(50, now - (cam.lastT || now));
    cam.lastT = now;
    cam.holdTicks -= dt / (1000 / 32);
    cam.s += (CAM_ZOOM - cam.s) * 0.15;
    const vw = W / cam.s, vh = H / cam.s;
    const tl = Math.max(0, Math.min(W - vw, cam.shake.x - vw / 2));
    const tt = Math.max(-SKY_HEADROOM, Math.min(H - vh, cam.shake.y - vh / 2));
    cam.left += (tl - cam.left) * 0.22;
    cam.top += (tt - cam.top) * 0.22;
    if (cam.holdTicks <= 0) { cam.shake = null; cam.mode = 'return'; }
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
  const ox = cam.ox || 0, oy = cam.oy || 0;
  ctx.setTransform(cam.s * RES, 0, 0, cam.s * RES, -(cam.left - ox) * cam.s * RES, -(cam.top - oy) * cam.s * RES);
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
    ul.innerHTML = `<li class="empty">${t('no_room')}</li>`;
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
socket.on('joined', ({ roomId: rid, isSpectator: spec, inGame, reconnected }) => {
  roomId = rid;
  isSpectator = spec;
  lobbyEl.classList.add('hidden');
  document.querySelectorAll('.chatLog').forEach(l => l.innerHTML = '');
  if (reconnected) {
    // 掉线重连恢复：直接回到对局画面（快照state随后到达并重建地形）
    roomScreenEl.classList.add('hidden');
    gameEl.classList.remove('hidden');
    $('dcBanner').classList.add('hidden');
    addChat(null, t('reconnected'));
    return;
  }
  if (inGame) {
    // 直播进行中的对局，直接进入游戏画面
    roomScreenEl.classList.add('hidden');
    gameEl.classList.remove('hidden');
    addChat(null, spec ? tf('joined_spec', { r: rid }) : tf('joined_room', { r: rid }));
  } else {
    // 进入房间等待界面
    gameEl.classList.add('hidden');
    roomScreenEl.classList.remove('hidden');
  }
});

/* ---------- 房间等待界面 ---------- */
let lastRoom = null; // 保存最近一次房间广播，语言切换时用它重绘
socket.on('room', (r) => { lastRoom = r; renderRoom(r); });
function renderRoom(r) {
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
  const CHARS_SHORT = CHAR_NAMES();
  const actives = r.players.filter(p => !p.spectator);
  for (let team = 0; team < 2; team++) {
    const ul = $('rsTeam' + team);
    if (!ul) continue;
    ul.innerHTML = '';
    const mates = actives.filter(p => p.team === team);
    for (const p of mates) {
      const li = document.createElement('li');
      const host = p.sid === r.hostSid ? '<span class="crown">👑</span>' : '';
      const cimg = CHARS[(p.char || 0) % CHARS.length];
      li.innerHTML = `<img src="${cimg}" alt=""><div class="pinfo2">${host}${escapeHtml(p.name)}${p.sid === socket.id ? t('you') : ''}</div><span class="chint">${CHARS_SHORT[p.char || 0]}</span>`;
      ul.appendChild(li);
    }
  }
  const vs = $('rsVs');
  if (vs) vs.textContent = isPveRoom(r) ? '👾' : 'VS';
  SFX.setBgm(r.mode === 'pve' && r.state === 'playing' ? 'battle' : 'lobby');
  const startBtn = $('rsStartBtn');
  const isPve = r.mode === 'pve';
  renderCharPick(r);
  renderMapPick(r);
  const need = isPve ? 1 : 2;
  startBtn.style.display = isHost ? '' : 'none';
  startBtn.disabled = actives.length < need;
  const specs = r.players.filter(p => p.spectator);
  $('rsTip').textContent = (specs.length ? tf('spec', { list: specs.map(p => escapeHtml(p.name)).join('、') }) : '') +
    (actives.length < need
      ? tf('tip_wait', { n: actives.length, need: t(isPve ? 'tip_pve_need' : 'tip_pvp_need') })
      : tf('tip_ready', { n: actives.length, mode: isPve ? t('tip_pve') : '' }));
}

function isPveRoom(r) { return r.mode === 'pve'; }

/* 地图选择：下拉框 + 中央弹出面板（打开时从中心放大，选择后缩回中心消失） */
const MAP_LABEL = () => ({ random: t('map_random'), castle: t('map_castle') });
let curMap = 'random';
window.addEventListener('langchange', () => {
  // 语言切换后即时刷新动态文本；房间界面用最近一次广播数据整体重绘
  renderCards(); // 手牌卡牌名称/描述跟随语言切换
  renderPoints(); // 强化商店文案跟随语言切换
  if (lastRoom && !roomScreenEl.classList.contains('hidden')) renderRoom(lastRoom);
  const dd = $('mapDropdown');
  if (dd) dd.textContent = MAP_LABEL()[curMap] + ' ▾';
  const bgm = $('bgmBtn');
  if (bgm) bgm.textContent = /🔇|静音|Muted/.test(bgm.textContent) ? t('music_off') : t('music_on');
});
function renderMapPick(r) {
  const cur = r.map === 'castle' ? 'castle' : 'random';
  curMap = cur;
  const dd = $('mapDropdown');
  dd.textContent = MAP_LABEL()[cur] + ' ▾';
  dd.disabled = !isHost;
  dd.title = isHost ? t('map_dd_hint') : t('map_host_only');
  document.querySelectorAll('.map-mopt').forEach(btn => {
    btn.classList.toggle('primary', btn.dataset.map === cur);
  });
}
function openMapModal() {
  const m = $('mapModal');
  m.classList.remove('hidden', 'closing');
  m.classList.add('opening');
}
function closeMapModal() {
  const m = $('mapModal');
  if (m.classList.contains('hidden')) return;
  m.classList.remove('opening');
  m.classList.add('closing');
  // 缩放动画结束后再隐藏
  m.addEventListener('animationend', () => m.classList.add('hidden'), { once: true });
}
$('mapDropdown').onclick = openMapModal;
document.querySelectorAll('.map-mopt').forEach(btn => {
  btn.onclick = () => { socket.emit('setMap', btn.dataset.map); closeMapModal(); };
});
$('mapModal').addEventListener('click', e => { if (e.target === $('mapModal')) closeMapModal(); });

$('rsStartBtn').onclick = () => {
  // 浏览器要求全屏必须由用户点击触发，挂在"开始游戏"的点击上
  if (document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
  socket.emit('startGame');
};
// 底部栏收纳/展开（进入自己回合时自动收起，之后保持状态直到玩家手动切换）
let barCollapsedByUser = false;
function setBarCollapsed(c) {
  $('game').classList.toggle('collapsed', c);
  $('barToggle').textContent = c ? '▲ 展开' : '▼ 收起';
}
$('barToggle').onclick = () => {
  const g = $('game');
  const collapsed = g.classList.toggle('collapsed');
  $('barToggle').textContent = collapsed ? '▲ 展开' : '▼ 收起';
  barCollapsedByUser = collapsed; // 玩家主动选择的状态，自动收纳不再覆盖
};
// 全屏切换
$('fsBtn').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
};

/** 角色选择：4个头像，点击更换；显示每个角色被谁选用 */
const CHAR_NAMES = () => [t('char_0'), t('char_1'), t('char_2'), t('char_3')];
const CHAR_PASSIVES = () => [t('passive_0'), t('passive_1'), t('passive_2'), t('passive_3')];
function renderCharPick(r) {
  const el = $('charPick');
  if (!el || r.state !== 'waiting') { if (el) el.innerHTML = ''; return; }
  el.innerHTML = '';
  const takerOf = (idx) => r.players.filter(p => !p.spectator && (p.char || 0) === idx).map(p => p.name + (p.sid === socket.id ? t('you') : ''));
  const myChar = (r.players.find(p => p.sid === socket.id) || {}).char || 0;
  for (let i = 0; i < CHARS.length; i++) {
    const div = document.createElement('div');
    div.className = 'cport' + (myChar === i ? ' mine' : '');
    const takers = takerOf(i).join('、');
    div.setAttribute('data-tip', CHAR_PASSIVES()[i]);
    div.innerHTML = `<img src="${CHARS[i]}" alt="${CHAR_NAMES()[i]}"><div class="pname">${CHAR_NAMES()[i]}</div><div class="taker">${takers}</div>`;
    div.onclick = () => {
      if (myChar !== i) socket.emit('setChar', i);
    };
    el.appendChild(div);
  }
}
$('rsLeaveBtn').onclick = () => {
  SFX.setBgm('lobby'); // 回到大厅/房间即切换大厅音乐
  socket.emit('leaveRoom');
  roomId = null;
  roomScreenEl.classList.add('hidden');
  lobbyEl.classList.remove('hidden');
  socket.emit('lobbyRefresh');
};

$('leaveBtn').onclick = () => {
  SFX.setBgm('lobby'); // 离开对局回到大厅音乐
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
    mapMode = st.map === 'castle' ? 'castle' : 'random';
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
  SFX.stopChargeSound();
  // 正常流程 shotEnd 先于本事件到达；无论如何都清掉飞行/动画状态，绝不把输入卡死在上一个回合
  if (animating) { flying = null; animating = false; }
  // 新回合开始意味着对局已在进行：收起胜负结算浮层（非房主不会触发rematch按钮，靠这里关闭）
  hideOverlay();
  cardUsed = false; fBought = false; gBought = false; renderCards(); renderPoints(); // 注意：不清手牌，服务器在本回合开始时已发新牌
  if (curTurnSid === socket.id && !barCollapsedByUser) setBarCollapsed(true); // 自己的回合自动收起底栏
  $('timer').textContent = t.timeLeft;
  $('timer').classList.toggle('urgent', t.timeLeft <= 5);
  if (me && curTurnSid === socket.id) { // 只有自己回合才同步积分/强化到me（观战者/他人回合不覆盖）
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

/* ---------- 结局视频：胜负后先播动画，再显示结算界面 ---------- */
function playEndingVideo(src, onDone) {
  const wrap = $('endingVideo');
  if (!wrap) { onDone(); return; } // 兜底：元素缺失时直接进入结算
  const v = wrap.querySelector('video');
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    wrap.classList.add('hidden');
    v.pause(); v.removeAttribute('src'); v.load();
    onDone();
  };
  wrap.onclick = finish;        // 点击任意处可跳过动画
  v.onended = finish;
  v.onerror = finish;
  let started = false;
  v.onplaying = () => { started = true; }; // 视频真正开始播放
  v.src = src;
  wrap.classList.remove('hidden');
  const p = v.play();
  if (p && p.catch) p.catch(() => { v.muted = true; v.play().catch(finish); }); // 自动播放被拦截时静音重试
  setTimeout(() => { if (!started) finish(); }, 12000); // 12秒内未能开始播放（加载过慢/失败）则跳过
  setTimeout(finish, 45000);    // 安全兜底：异常时最多等待45秒
}

socket.on('gameover', ({ winner }) => {
  SFX.setBgm('lobby');
  lastFiredAngle = null; // 新对局恢复默认45°
  // 我方胜利奏凯歌，失败奏哀乐
  const myTeam = me ? me.team : 0;
  const iWon = winner === '玩家队' || winner === '红队' && myTeam === 0 || winner === '蓝队' && myTeam === 1;
  const showResult = () => {
    SFX.play(iWon ? 'win' : 'lose');
    showOverlay(
      iWon ? "🏆 The players' team wins!"
      : winner === '平局' ? "🤝 It's a draw!"
      : "💀 The players' team loses!"
    );
    if (isHost && !isSpectator) {
      const btn = document.createElement('button');
      btn.className = 'btn primary big';
      btn.textContent = t('rematch');
      btn.onclick = () => { hideOverlay(); socket.emit('rematch'); };
      $('overlay').appendChild(btn);
    } else {
      const tip = document.createElement('div');
      tip.style.fontSize = '16px';
      tip.style.color = '#cdd8ee';
      tip.textContent = 'Waiting for the host to start a new round…';
      $('overlay').appendChild(tip);
    }
  };
  // 胜利播放 Win Sequence，失败播放 defeat sequence，播完后显示胜/负结算
  playEndingVideo(iWon ? 'video/win_sequence.mp4' : 'video/defeat_sequence.mp4', showResult);
});

socket.on('msg', (m) => {
  addChat(m.name, m.text);
  if (m.text && m.text.includes('近战攻击')) SFX.play('attack');
  if (m.text && m.text.includes('被消灭')) SFX.play('kill');
  if (m.text && m.text.includes('加入了房间')) SFX.play('join');
});

/* ---------- 聊天（房间等待界面与游戏内共用，日志同步写入所有面板） ---------- */
function sendChat(input) {
  const t = input.value.trim();
  if (!t) return;
  if (t === 'iseeall') { // 作弊指令：切换碰撞体显示
    showColliders = !showColliders;
    addChat(null, `碰撞体显示：${showColliders ? '开' : '关'}`);
    input.value = '';
    return;
  }
  socket.emit('chat', t);
  input.value = '';
}
for (const [inp, btn] of [['chatInput', 'chatBtn'], ['rsChatInput', 'rsChatBtn']]) {
  $(btn).onclick = () => sendChat($(inp));
  $(inp).addEventListener('keydown', e => { if (e.key === 'Enter') sendChat($(inp)); });
}

function addChat(name, text) {
  const div = document.createElement('div');
  if (name == null) { div.className = 'sys'; div.textContent = text; }
  else { div.innerHTML = `<b>${escapeHtml(name)}:</b> ${escapeHtml(text)}`; }
  document.querySelectorAll('.chatLog').forEach(log => {
    log.appendChild(div.cloneNode(true));
    log.scrollTop = log.scrollHeight;
  });
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
  const ae = document.activeElement;
  if (ae && (ae.id === 'chatInput' || ae.id === 'rsChatInput' || ae.id === 'nameInput')) return;
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
      if (!charging) { charging = true; chargeStart = performance.now(); SFX.play('charge'); SFX.startChargeSound(); }
      e.preventDefault();
      break;
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && charging) {
    charging = false;
    SFX.stopChargeSound();
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

/** 脚下坡面的世界仰角（度，右升为正，平地为0） */
function slopeElevDeg(p) {
  const xa = Math.max(0, Math.min(W - 1, Math.round(p.x - 14)));
  const xb = Math.max(0, Math.min(W - 1, Math.round(p.x + 14)));
  const ya = groundBelowLocal(xa, p.y - 8), yb = groundBelowLocal(xb, p.y - 8);
  if (ya >= H || yb >= H) return 0;
  return Math.atan2(ya - yb, xb - xa) * 180 / Math.PI;
}
function setAngle(a) {
  // 角度 = 与世界水平面的仰角：W永远抬高、S永远压低（单调）。
  // 地形影响边界：面朝上坡时最低仰角被坡面顶高（不能往山体里打），面朝下坡可压到-30往坡下打
  let minE = -30;
  if (me) {
    const se = slopeElevDeg(me);
    const uphill = (dir === 1 && se > 0) || (dir === -1 && se < 0);
    if (uphill) minE = Math.abs(se) + 10;
  }
  angle = Math.max(minE, Math.min(90, Math.round(a)));
  if (me) me.dir = dir; // 同步自己的贴图朝向
  socket.emit('aim', { angle, power, dir }); // 任何时刻都同步，防止预瞄与实际发射不一致
  updateAimHud();
}
function setPower(p) {
  power = Math.max(40, Math.min(160, Math.round(p)));
  socket.emit('aim', { angle, power }); // 任何时刻都同步
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
  lastPower = power; // 记录本次发射力度，进度条上以淡蓝标记显示
  lastFiredAngle = angle; // 记录本次发射角度，作为后续回合的默认角度
  socket.emit('fire');
  // 不再乐观置 animating：等服务器 shotBegin 确认起飞后再锁定输入，
  // 若这一炮被服务器拒绝（如回合恰好超时切换），输入不会被卡死
  stopMove();
}
function powerFromCharge() {
  const held = (performance.now() - chargeStart) / 1000;
  return Math.min(160, 40 + held * 60); // 40起步，约2秒蓄满160
}

/** 最终世界仰角：φ = 坡度倾角tilt + 局部瞄准角（无额外限制，坡度自然影响最终方向） */
function finalWorldAngle() {
  let tilt = 0;
  if (me) tilt = slopeElevDeg(me) * dir; // 面朝上坡为正、下坡为负
  const phi = tilt + angle;
  return { phi, a: angle };
}

function updateAimHud() {
  const fa = finalWorldAngle();
  $('angleVal').textContent = angle;
  $('finalAngleVal').textContent = Math.round(fa.phi);
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
      row.className = 'hprow' + (team === 1 ? ' right' : '') + (p.alive ? '' : ' dead') + (p.dc ? ' dc' : '');
      row.innerHTML = `<span class="hname">${escapeHtml(p.name)}${p.isYou ? t('you') : ''}${p.dc ? t('dc_badge') : ''}</span>` +
        `<div class="hpbar"><div class="hpfill" style="width:${p.hp / 10}%;background:${p.alive ? 'linear-gradient(90deg,#43d96a,#a8e063)' : '#555'}"></div></div>`;
      rows.appendChild(row);
    }
    if (!mates.length) rows.innerHTML = `<div class="hname">${t('waiting_players')}</div>`;
  }
  const w = Math.abs(wind).toFixed(1);
  $('windVal').textContent = w;
  $('windArrow').textContent = wind > 0.2 ? '→' : wind < -0.2 ? '←' : '·';
  const cur = active[curTurnSlot];
  $('turnLabel').textContent = cur ? (cur.isYou ? t('your_turn') : tf('acting', { n: cur.name })) : t('waiting_players');
  if (me) { angle = lastFiredAngle !== null ? lastFiredAngle : 45; power = 40; updateAimHud(); }
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
// 实时爆炸事件（命中瞬间/二次爆破）：火球、音效、暴击标记、伤害飘字即时呈现
let boomMarks = []; // 爆炸落点标记（iseeall观察用）：{x,y,r,t,tag}
socket.on('boomFx', (d) => {
  applyTerrainRuns(d.runs || []); // 命中瞬间立即显示该发弹坑
  eraseBoomCircle(d.x, d.y, d.r); // 按完整圆域再擦一次：藤蔓叶片等无碰撞的装饰像素比mask宽，逐run擦会残留
  boomMarks.push({ x: d.x, y: d.y, r: d.r, t: 0, tag: d.tag || '' });
  explosions.push({ x: d.x, y: d.y, r: d.r, t: 0 });
  SFX.play('hit' + (flying ? flying.char || 0 : d.char || 0));
  for (let i = 0; i < 28; i++) {
    const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 5;
    shots.push({ x: d.x, y: d.y, vx: Math.cos(a)*sp, vy: Math.sin(a)*sp - 2, life: 1 });
  }
  if (d.crit) addFloat(d.x, d.y - 30, '暴击！', '#ffd54a');
  // 命中瞬间立即震屏（聚焦命中点）；强度按角色人设区分
  const SHAKE_BY_CHAR = [
    { durTicks: 18, mag: 14 }, // 轰侠：炸弹，最沉重
    { durTicks: 8,  mag: 4 },  // 影袭：弓箭，轻快短促
    { durTicks: 10, mag: 6 },  // 鹰眼：魔法，中等余韵
    { durTicks: 6,  mag: 3 },  // 疾风：飞镖，最轻最快
  ];
  const shk = SHAKE_BY_CHAR[(flying ? flying.char : d.char) || 0] || SHAKE_BY_CHAR[0];
  cam.mode = 'shake';
  cam.shake = { x: d.x, y: d.y, t: 0, durTicks: shk.durTicks, mag: shk.mag };
  cam.holdTicks = HOLD_TICKS; // 每次命中刷新保持窗口
  for (const dd of d.dmg || []) {
    const p = players.find(q => q.slot === dd.slot);
    if (p) {
      if (dd.tag === 'poison') addFloat(p.x, p.y - 100, '-' + dd.damage, '#b388ff', 22); // 毒伤：紫色，位于炮弹伤害上方错开
      else if (dd.tag === 'true') addFloat(p.x, p.y - 104, '-' + dd.damage, '#ffffff', 30); // 真实伤害：醒目白色，错开显示
      else if (dd.crit) addFloat(p.x, p.y - 64, '-' + dd.damage, '#ffd54a', 32);
      else addFloat(p.x, p.y - 64, '-' + dd.damage);
    }
  }
  for (const md of d.mDmg || []) {
    if (md.tag === 'poison') addFloat(md.x, md.y - 56, '-' + md.damage, '#b388ff', 22); // 毒伤：紫色，位于炮弹伤害上方错开
    else if (md.tag === 'true') addFloat(md.x, md.y - 60, '-' + md.damage, '#ffffff', 30); // 真实伤害：醒目白色，错开显示
    else if (md.tag === 'boom2') addFloat(md.x, md.y - 20, '-' + md.damage, '#40c4ff');
    else if (md.crit) addFloat(md.x, md.y - 20, '-' + md.damage, '#ffd54a', 32);
    else addFloat(md.x, md.y - 20, '-' + md.damage, '#ff9100');
  }
});

// 回合开始/怪物行动时的持续毒伤结算（紫色飘字 + 本地更新HP，无爆炸动画）
socket.on('poisonDmg', (d) => {
  if (d.slot !== undefined) {
    const p = players.find(q => q.slot === d.slot);
    if (p) {
      if (d.damage > 0) addFloat(p.x, p.y - 100, '-' + d.damage, '#b388ff', 22);
      if (d.hp !== undefined) { p.hp = d.hp; p.alive = d.alive; }
      updateHUD();
    }
  } else if (d.monId !== undefined) {
    const m = monsters.find(q => q.id === d.monId);
    if (m) {
      if (d.damage > 0) addFloat(m.rx ?? m.x, (m.ry ?? m.y) - m.r * 2.6 - 36, '-' + d.damage, '#b388ff', 22);
      if (d.hp !== undefined) { m.hp = d.hp; m.alive = d.alive; }
    }
  }
});

// Boss“小兵炮弹”：32tick服务器权威抛射，客户端航位推算平滑飞行，落地生成小兵
let minionShots = {}; // id -> {x, y, sx, sy, st, vx, vy, tx, ty}
const finishedSpawns = new Set(); // 落地动画已完成的小兵：防止闪烁
socket.on('minionShotBegin', (d) => {
  minionShots[d.id] = { x: d.x, y: d.y, sx: d.x, sy: d.y, st: performance.now(), vx: d.vx, vy: d.vy, tx: d.x, ty: d.y, lastT: performance.now() };
});
socket.on('minionShotTick', (d) => {
  const ms = minionShots[d.id];
  if (!ms) return;
  ms.sx = d.x; ms.sy = d.y; ms.st = performance.now();
  ms.tx = d.x; ms.ty = d.y;
  if (d.done) { ms.vx = 0; ms.vy = 0; ms.done = true; } // 落地冻结：不再外推滑行
  else { ms.vx = d.vx; ms.vy = d.vy; }
});
socket.on('minionShotEnd', (d) => {
  delete minionShots[d.id];
  finishedSpawns.add(d.id);
  mergeMonsters([d.minion]); // 小兵在落点现身
});

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
      flying.list[i].done = !!d.pts[i].done;
    }
  }
});

socket.on('shotEnd', (data) => {
  try {
    // 火球/音效/飘字/震屏均已由实时boomFx呈现；shotEnd只负责权威状态结算。
    // 镜头由 hold 窗口到期后自动收回
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
    while (pendingFalls.length) applyFalls(pendingFalls.shift()); // 飘字已由实时boomFx呈现
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
  SFX.stopChargeSound();
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
const UPGRADES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 's'].map(id => ({ id }));
const UPG_COST = { a: 50, b: 15, c: 60, d: 25, e: 35, f: 30, g: 80, s: 200 };
let fBought = false; // 强化F本回合已购买（一次性）
let gBought = false; // 强化G本回合已购买（一次性）
let lastPtsUsable = null;
function renderPoints() {
  const pv = $('pointsVal'), list = $('upgList'), panel = $('pointsPanel');
  if (!pv || !list || !panel) return;
  pv.textContent = t('points') + ' ' + (me ? (me.points || 0) : 0);
  const usable = myTurn();
  // 状态切换时触发进入/退出动画
  if (usable !== lastPtsUsable) {
    panel.classList.remove('anim-in', 'anim-out');
    void panel.offsetWidth; // 强制重排以重启动画
    panel.classList.add(usable ? 'anim-in' : 'anim-out');
    lastPtsUsable = usable;
  }
  list.innerHTML = '';
  for (const u of UPGRADES) {
    const div = document.createElement('div');
    const afford = me && (me.points || 0) >= UPG_COST[u.id];
    const soldOut = (u.id === 'f' && fBought) || (u.id === 'g' && gBought);
    div.className = 'upg' + (usable && afford && !soldOut ? '' : ' disabled');
    div.innerHTML = `<div class="uname"><span>${t('upg_' + u.id)}${soldOut ? t('sold_out') : ''}</span><span class="cost">${UPG_COST[u.id]}</span></div><div class="udesc">${t('upg_' + u.id + '_d')}</div>`;
    if (usable && afford && !soldOut) {
      div.onmouseenter = () => SFX.play('upgHover'); // 仅可用卡片：悬停清脆咔哒
      div.onclick = () => {
        SFX.play('upgClick'); // 金铁点击声
        if (u.id === 'f') fBought = true;
        if (u.id === 'g') gBought = true;
        socket.emit('buyUpgrade', u.id);
        renderPoints();
      };
    };
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
    div.innerHTML = `<div class="cemoji">${c.emoji}</div><div class="cname">${t('card_' + c.id) !== 'card_' + c.id ? t('card_' + c.id) : c.name}</div><div class="cdesc">${t('card_' + c.id + '_d') !== 'card_' + c.id + '_d' ? t('card_' + c.id + '_d') : c.desc}</div>`;
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
  netTick(performance.now());
  camStep();
  ctx.setTransform(RES, 0, 0, RES, 0, 0);
  ctx.save();
  applyCam();
  if (mapMode === 'castle' && castleBg.complete && castleBg.naturalWidth) {
    // 城堡地图：整幅背景图（天空+远景城堡+远山），覆盖镜头可视区
    ctx.drawImage(castleBg, 0, 0, W, H);
  } else {
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
    ctx.beginPath(); ctx.arc(1780, 130, 46, 0, 7); ctx.fill();
  }

  // 地形（离屏画布，爆炸会实时擦除出圆形弹坑）
  ctx.drawImage(tcv, 0, 0);

  // 坦克
  const active = players.filter(p => !p.spectator);
  for (const p of active) {
    drawTank(p);
  }
  drawMonsters();

  // 作弊视图：爆炸落点标记（金色虚线圈+X，约1.6秒渐隐）——用于确认每次爆炸的实际位置
  if (showColliders && boomMarks.length) {
    ctx.save();
    ctx.setLineDash([6, 5]);
    for (let i = boomMarks.length - 1; i >= 0; i--) {
      const bm = boomMarks[i];
      bm.t += 0.01;
      if (bm.t >= 1) { boomMarks.splice(i, 1); continue; }
      ctx.globalAlpha = 1 - bm.t;
      ctx.strokeStyle = bm.tag === 'boom2' ? '#40c4ff' : '#ffd54a';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(bm.x, bm.y, bm.r, 0, 7); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bm.x - 8, bm.y - 8); ctx.lineTo(bm.x + 8, bm.y + 8);
      ctx.moveTo(bm.x + 8, bm.y - 8); ctx.lineTo(bm.x - 8, bm.y + 8);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // 作弊视图：显示全部碰撞体（怪物碰撞圆=红，玩家炮弹命中范围=绿，飞行炮弹碰撞圆=黄）
  if (showColliders) {
    ctx.save();
    ctx.lineWidth = 2;
    if (flying && flying.list) {
      const BR = [0, 8, 8, 8];   // 各角色炮弹的地形采样半径（与服务器一致）
      const ER = [77, 55, 55, 55]; // 各角色炮弹的溅射（爆炸）半径
      ctx.strokeStyle = 'rgba(255, 230, 80, .9)';
      for (const fl of flying.list) {
        if (fl.done) continue;
        ctx.beginPath(); ctx.arc(fl.x, fl.y, BR[flying.char] || 0, 0, 7); ctx.stroke();
        ctx.fillStyle = 'rgba(255, 230, 80, .9)';
        ctx.fillRect(fl.x - 1, fl.y - 1, 2, 2);
        // 淡金色溅射范围：落点在此圆内的目标都会被爆炸波及（轰侠半径+40%）
        ctx.strokeStyle = 'rgba(255, 213, 74, .25)';
        ctx.fillStyle = 'rgba(255, 213, 74, .05)';
        ctx.beginPath(); ctx.arc(fl.x, fl.y, ER[flying.char] || 55, 0, 7); ctx.fill(); ctx.stroke();
      }
    }
    for (const id of Object.keys(minionShots)) {
      const ms = minionShots[id];
      ctx.strokeStyle = 'rgba(200, 130, 255, .9)';
      ctx.beginPath(); ctx.arc(ms.x, ms.y, 5, 0, 7); ctx.stroke();
    }
    for (const p of players.filter(q => !q.spectator && q.alive)) {
      // 与drawTank的贴图旋转完全一致：θ = atan2(yb - ya, xb - xa)（canvas坐标系）
      const dxa = Math.max(0, Math.min(W - 1, Math.round(p.x - 14)));
      const dxb = Math.max(0, Math.min(W - 1, Math.round(p.x + 14)));
      const dya = groundBelowLocal(dxa, p.y - 8), dyb = groundBelowLocal(dxb, p.y - 8);
      const sl = (dya >= H || dyb >= H) ? 0 : Math.atan2(dyb - dya, dxb - dxa);
      const cH = 26;
      const cx = p.x + Math.sin(sl) * cH, cy = p.y - Math.cos(sl) * cH;
      ctx.strokeStyle = 'rgba(80, 255, 120, .85)';
      ctx.beginPath(); ctx.arc(cx, cy, 20, 0, 7); ctx.stroke();
      ctx.fillStyle = 'rgba(80, 255, 120, .9)';
      ctx.fillRect(cx - 1, cy - 1, 2, 2);
    }
    for (const m of monsters) {
      if (m.spawning || !m.alive) continue;
      ctx.strokeStyle = 'rgba(255, 70, 70, .85)';
      const cH = m.r * 1.3;
      const mxa = Math.max(0, Math.min(W - 1, Math.round(m.rx - 14)));
      const mxb = Math.max(0, Math.min(W - 1, Math.round(m.rx + 14)));
      const mya = groundBelowLocal(mxa, m.ry - 8), myb = groundBelowLocal(mxb, m.ry - 8);
      const sl = (mya >= H || myb >= H) ? 0 : Math.atan2(myb - mya, mxb - mxa);
      const cx = m.rx + Math.sin(sl) * cH, cy = m.ry - Math.cos(sl) * cH;
      ctx.beginPath(); ctx.arc(cx, cy, m.r, 0, 7); ctx.stroke();
      ctx.fillStyle = 'rgba(255, 70, 70, .9)';
      ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3); // 碰撞圆心（随坡面旋转）
    }
    ctx.restore();
  }

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
      if (fl.done) continue; // 已命中的弹体不再绘制（爆炸由boomFx呈现）
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
      if (bimg && bimg.baked) {
        // 旋转平滑：目标角取速度方向（服务器同步，平滑变化），显示角度按最短弧指数逼近
        const targetAng = Math.atan2(fl.vy, fl.vx);
        if (fl.ang === undefined) fl.ang = targetAng;
        let aDiff = targetAng - fl.ang;
        aDiff = Math.atan2(Math.sin(aDiff), Math.cos(aDiff));
        fl.ang += aDiff * (1 - Math.exp(-dt / 90));
        ctx.save();
        ctx.translate(fl.x, fl.y);
        ctx.rotate(fl.ang);
        ctx.drawImage(bimg.baked.cv, -bimg.baked.w / 2, -bimg.baked.h / 2, bimg.baked.w, bimg.baked.h);
        ctx.restore();
      } else {
        ctx.fillStyle = '#222';
        ctx.beginPath(); ctx.arc(fl.x, fl.y, 5, 0, 7); ctx.fill();
        ctx.fillStyle = 'rgba(255,160,40,.5)';
        ctx.beginPath(); ctx.arc(fl.x, fl.y, 9, 0, 7); ctx.fill();
      }
    }
  }

  // Boss“小兵炮弹”飞行（航位推算：速度外推+向服务器位置纠偏）
  const nowMs = performance.now();
  for (const id of Object.keys(minionShots)) {
    const ms = minionShots[id];
    const dt = Math.min(50, nowMs - (ms.lastT || nowMs));
    ms.lastT = nowMs;
    const velMs = 0.7 * 0.096; // 服务器速度单位 → 像素/毫秒
    ms.x += ms.vx * velMs * dt;
    ms.y += ms.vy * velMs * dt;
    ms.x += (ms.tx - ms.x) * 0.08;
    ms.y += (ms.ty - ms.y) * 0.08;
    ctx.fillStyle = 'rgba(123, 31, 162, .9)';
    ctx.beginPath(); ctx.arc(ms.x, ms.y, 8, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(186, 104, 200, .45)';
    ctx.beginPath(); ctx.arc(ms.x, ms.y, 12, 0, 7); ctx.fill();
  }

  // 爆炸（支持多个爆炸点，角色three三发各自爆炸）
  for (let i = explosions.length - 1; i >= 0; i--) {
    const ex = explosions[i];
    if (ex.t < 0) { ex.t += 0.08; continue; } // 延迟相位：二次爆破稍后出现
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
  // 伤害飘字：上浮并渐隐（大小按条目）
  ctx.textAlign = 'center';
  for (let i = floatTexts.length - 1; i >= 0; i--) {
    const f = floatTexts[i];
    f.t += 0.012;
    if (f.t >= 1) { floatTexts.splice(i, 1); continue; }
    ctx.font = `bold ${f.size || 26}px sans-serif`;
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
    SFX.updateChargeSound((power - 40) / 120); // 蓄力音调随进度上升
  } else {
    SFX.stopChargeSound();
  }
  $('powerBar').style.width = ((Math.max(40, Math.min(160, power)) - 40) / 120 * 100) + '%'; // 进度条在40~160间插值
  // 上次蓄力标记：淡蓝色竖线
  const mark = $('powerMark');
  if (lastPower !== null) {
    mark.style.display = 'block';
    mark.style.left = ((Math.max(40, Math.min(160, lastPower)) - 40) / 120 * 100) + '%';
  } else {
    mark.style.display = 'none';
  }

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
    if (cimg.baked) {
      // 使用烘焙好的显示尺寸贴图：底部贴合地面，重采样温和无摩尔纹
      ctx.drawImage(cimg.baked.cv, -cimg.baked.w / 2, -cimg.baked.h, cimg.baked.w, cimg.baked.h);
    } else if (cimg.trim) {
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
  // 护盾气泡：淡蓝色半透明罩住角色，随呼吸微微起伏
  if (p.shield > 0) {
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 400);
    ctx.save();
    ctx.rotate(slope);
    ctx.fillStyle = `rgba(100, 180, 255, ${0.10 + pulse * 0.06})`;
    ctx.strokeStyle = `rgba(140, 210, 255, ${0.55 + pulse * 0.3})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, -27, 36 + pulse * 2, 42 + pulse * 2, 0, 0, 7);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore(); // 结束坡度旋转：血条与名字始终保持水平
  // 名字与血条（圆角、水平）
  ctx.fillStyle = 'rgba(0,0,0,.6)';
  rr(ctx, -30, -72, 60, 7, 3.5); ctx.fill();
  if (p.hp > 0) {
    ctx.fillStyle = '#43d96a';
    rr(ctx, -30, -72, Math.max(6, 60 * (p.hp / 1500)), 7, 3.5); ctx.fill();
  }
  // 护盾血条：位于头顶血条上方（有护盾时才显示），名字相应再上移
  if (p.shield > 0) {
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    rr(ctx, -30, -80, 60, 5, 2.5); ctx.fill();
    ctx.fillStyle = '#8cd2ff';
    rr(ctx, -30, -80, Math.max(4, Math.min(60, 60 * (p.shield / 150))), 5, 2.5); ctx.fill();
  }
  ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(p.name + (p.isYou ? t('you') : ''), 0, p.shield > 0 ? -87 : -79);
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

/** 弹道预测轨迹：与世界仰角一致的发射方向 + 相同物理公式，预览长度有限 */
function drawAim(p) {
  // 最终方向 = 世界仰角φ（已含坡度影响并钳制），与服务器换算一致
  const fa = finalWorldAngle();
  const a = (fa.phi * Math.PI) / 180;
  const speed = power * 0.1425;
  let x = p.x + Math.cos(a) * 22 * dir;
  let y = p.y - Math.sin(a) * 22;
  let vx = Math.cos(a) * speed * dir;
  let vy = -Math.sin(a) * speed;
  ctx.save();
  for (let step = 0; step < 130; step++) { // 预览长度限制（约1.4秒飞行）
    x += vx * 0.7;
    y += vy * 0.7;
    vy += 0.28 * 0.7;
    x += wind * 0.012;
    if (x < 0 || x > W || y > H) break;
    if (step > 6 && mask[Math.round(y) * W + Math.round(x)] === 1) break;
    if (step % 4 === 0) {
      ctx.globalAlpha = Math.max(0.3, 1 - step / 130);
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
    if (m.spawning && !finishedSpawns.has(m.id)) continue; // 孵化中的小兵由抛射动画呈现
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
      if (img.baked) ctx.drawImage(img.baked.cv, -size / 2, -size, size, size); // 烘焙贴图立于地表
      else ctx.drawImage(img, -size / 2, -size, size, size);
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
// 音乐询问浮层：用户选择后才开始播放（规避浏览器自动播放限制）
$('mpYes').onclick = () => {
  SFX.setBgmOn(true);
  SFX.setBgm('lobby');
  $('musicPrompt').classList.add('hidden');
  $('bgmBtn').textContent = t('music_on');
};
$('mpNo').onclick = () => {
  SFX.setBgmOn(false);
  $('musicPrompt').classList.add('hidden');
  $('bgmBtn').textContent = t('music_off');
};

// 背景音乐开关
$('bgmBtn').onclick = () => {
  SFX.init();
  const on = SFX.toggleBgm();
  $('bgmBtn').textContent = on ? t('music_on') : t('music_off');
};

draw();
