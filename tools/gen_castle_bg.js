/* 生成城堡地图背景图 public/texture/castle_bg.png（1920x1080）
   纯 Node 无依赖：解析法逐像素绘制 + zlib PNG 编码。
   内容：天空渐变、太阳光晕、云层、远山、远处城堡剪影（前景城堡由可破坏地形渲染）。 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const W = 1920, H = 1080;

// ---------- 小工具 ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = t => t * t * (3 - 2 * t);
// 确定性伪随机
function rnd(i) { const s = Math.sin(i * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }

/** 布尔软边：多个圆的场强叠加，>0 在形体内，值越深越实 */
function blobField(x, y, circles) {
  let f = 0;
  for (const [cx, cy, r] of circles) {
    const d = Math.hypot(x - cx, y - cy) / r;
    if (d < 1) f += (1 - d * d) * 1.6;
  }
  return f;
}

// ---------- 场景元素 ----------
// 云：每朵由一串圆组成，flat底部
const clouds = [
  { s: 1.4, y: 130, xs: [180, 430, 760, 1050, 1400, 1720] },
  { s: 0.9, y: 260, xs: [60, 330, 640, 980, 1260, 1580, 1840] },
  { s: 1.1, y: 70, xs: [520, 900, 1240, 1650] },
];
function cloudAt(x, y) {
  for (let ci = 0; ci < clouds.length; ci++) {
    const c = clouds[ci];
    for (let k = 0; k < c.xs.length; k++) {
      const bx = c.xs[k], by = c.y + (rnd(ci * 31 + k) - 0.5) * 26;
      const rx = 70 * c.s, ry = 30 * c.s;
      // 椭圆 + 三团叠加
      const f = blobField(x, y, [
        [bx, by, ry], [bx - rx * 0.7, by + ry * 0.35, ry * 0.75], [bx + rx * 0.7, by + ry * 0.35, ry * 0.75],
        [bx - rx * 0.3, by - ry * 0.5, ry * 0.7], [bx + rx * 0.35, by - ry * 0.45, ry * 0.65],
      ]);
      if (f > 0) return clamp(f, 0, 1);
    }
  }
  return 0;
}

// 远山：两层正弦叠加曲线
function hillY(x, layer) {
  if (layer === 0) return 640 + Math.sin(x * 0.0021 + 1.2) * 60 + Math.sin(x * 0.0053) * 34;
  return 720 + Math.sin(x * 0.0032 + 4) * 46 + Math.sin(x * 0.008 + 1) * 22;
}

// 远处城堡剪影（x 1060~1420）：塔楼 + 主堡 + 尖顶，整体做旧偏蓝灰
function farCastle(x, y) {
  let inside = false, depth = 0; // depth 用于简单明暗
  const rect = (x0, x1, y0) => x >= x0 && x <= x1 && y >= y0 ? Math.max(depth, 1) : 0;
  const tri = (x0, x1, yTip, yBase) => {
    if (x < x0 || x > x1 || y < yTip) return 0;
    const t = (x - x0) / (x1 - x0);
    const yEdge = yTip + Math.abs(t - 0.5) * 2 * (yBase - yTip);
    return y >= yEdge ? 1 : 0;
  };
  // 左塔
  inside = rect(1064, 1116, 470) || tri(1058, 1122, 386, 472) || inside;
  // 右塔
  inside = rect(1364, 1416, 470) || tri(1358, 1422, 386, 472) || inside;
  // 主堡
  inside = rect(1130, 1350, 520) || tri(1122, 1358, 404, 522) || inside;
  // 侧翼矮墙
  inside = rect(1116, 1130, 600) || rect(1350, 1364, 600) || inside;
  // 小尖塔
  inside = rect(1196, 1224, 470) || tri(1190, 1230, 398, 472) || inside;
  inside = rect(1282, 1310, 470) || tri(1276, 1316, 398, 472) || inside;
  return inside ? 1 : 0;
}

// ---------- 逐像素绘制 ----------
const buf = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const t = y / H;
    // 天空：亮蓝到近地平线的暖白
    let r = mix(0x69, 0xc6, smooth(clamp(t * 1.25, 0, 1)));
    let g = mix(0xb4, 0xe8, smooth(clamp(t * 1.25, 0, 1)));
    let b = mix(0xef, 0xff, smooth(clamp(t * 1.25, 0, 1)));

    // 太阳（左上偏中）
    const sd = Math.hypot(x - 300, y - 190);
    if (sd < 260) { const k = Math.max(0, 1 - sd / 260); r = mix(r, 255, k * 0.5); g = mix(g, 244, k * 0.5); b = mix(b, 200, k * 0.4); }
    if (sd < 58) { const k = 1 - sd / 58; r = mix(r, 255, k); g = mix(g, 250, k); b = mix(b, 225, k); }

    // 云
    const cf = cloudAt(x, y);
    if (cf > 0) { const k = smooth(clamp(cf, 0, 1)) * 0.92; r = mix(r, 255, k); g = mix(g, 255, k); b = mix(b, 255, k); }

    // 远处城堡剪影（带大气透视，偏蓝灰）
    if (y > 380 && farCastle(x, y)) {
      const hz = clamp((y - 380) / 320, 0, 1); // 越低越接近地平线越朦胧
      r = mix(r, 150, 0.55 + hz * 0.15); g = mix(g, 158, 0.55 + hz * 0.15); b = mix(b, 178, 0.55 + hz * 0.15);
    }

    // 远山两层
    for (let l = 0; l < 2; l++) {
      const hy = hillY(x, l);
      if (y > hy) {
        const k = l === 0 ? 0.75 : 0.9;
        const cr = l === 0 ? 148 : 108, cg = l === 0 ? 178 : 158, cb = l === 0 ? 158 : 118;
        r = mix(r, cr, k); g = mix(g, cg, k); b = mix(b, cb, k);
        // 山体细碎明暗
        const n = (rnd(Math.floor(x / 7) + l * 991) - 0.5) * 14;
        r += n; g += n; b += n;
      }
    }

    const i = (y * W + x) * 3;
    buf[i] = clamp(Math.round(r), 0, 255);
    buf[i + 1] = clamp(Math.round(g), 0, 255);
    buf[i + 2] = clamp(Math.round(b), 0, 255);
  }
}

// ---------- PNG 编码 ----------
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// 每行前加 filter byte 0
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0;
  buf.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2; // 8bit truecolor
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'public', 'texture', 'castle_bg.png');
fs.writeFileSync(out, png);
console.log('written', out, png.length, 'bytes');
