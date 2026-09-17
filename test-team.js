/* 3v3 团队战测试：6名玩家分队、交错回合、团队胜负；另测第7/8人观战、第9人被拒 */
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const G = 0.28;

function simulate(x0, y0, angle, power, wind, terrain, dir) {
  const rad = angle * Math.PI / 180;
  const speed = power * 0.1425;
  let x = x0 + Math.cos(rad) * 22 * dir, y = y0 - Math.sin(rad) * 22 - 6;
  const vx = Math.cos(rad) * speed * dir;
  let vy = -Math.sin(rad) * speed;
  for (let step = 0; step < 4000; step++) {
    x += vx * 0.7; y += vy * 0.7; vy += G * 0.7; x += wind * 0.012;
    if (x < -200 || x > 1400 || y > 700) return { x, y };
    const xi = Math.max(0, Math.min(1199, Math.round(x)));
    if (step > 6 && y >= terrain[xi]) return { x, y };
  }
  return { x, y };
}

const bots = [];
let terrain = null, players = [], wind = 0, over = false, shots = 0, hits = 0;
let orderLog = [], spectatorCount = 0, rejected = false, firstRoomId = null;

function makeBot(i) {
  const s = io(URL, { transports: ['websocket'] });
  s.name = 'P' + i;
  s.on('state', (st) => { terrain = st.terrain; players = st.players; });
  s.on('turn', (t) => {
    wind = t.wind;
    const me = players.find(p => p.isYou);
    if (!me || !me.alive || over) return;
    orderLog.push(`${me.name}(T${me.team})`);
    // 找敌方血量最低者轰击
    const foes = players.filter(p => p.team !== me.team && p.alive);
    if (!foes.length) return;
    const foe = foes.sort((a, b) => a.hp - b.hp)[0];
    const dir = me.x < 600 ? 1 : -1;
    let best = { p: 50, err: 1e9 };
    for (let pw = 20; pw <= 100; pw += 0.5) {
      const r = simulate(me.x, me.y, 45, pw, wind, terrain, dir);
      const err = Math.abs(r.x - foe.x);
      if (err < best.err) best = { p: pw, err };
    }
    setTimeout(() => {
      s.emit('aim', { angle: 45, power: best.p, dir });
      setTimeout(() => s.emit('fire'), 100);
    }, 200);
  });
  s.on('shot', (d) => {
    shots++;
    for (const rr of d.terrainRuns || []) {
      for (let y = rr.y0; y <= rr.y1; y++) terrain[y * 1200 + rr.x] = 0;
    }
    for (const pos of d.positions || []) {
      const p = players.find(q => q.slot === pos.slot);
      if (p) { p.x = pos.x; p.y = pos.y; }
    }
    for (const dm of d.damage || []) {
      const p = players.find(q => q.slot === dm.slot);
      if (p) { p.hp = dm.hp; p.alive = dm.alive; }
      if (d.damage.length) { hits++; break; }
    }
  });
  s.on('joined', (d) => { if (d.isSpectator) spectatorCount++; if (!firstRoomId) firstRoomId = d.roomId; });
  s.on('room', (r) => {
    if (r.state === 'waiting' && r.hostSid === s.id && r.players.filter(p => !p.spectator).length >= 6) {
      s.emit('startGame');
    }
  });
  s.on('err', (e) => { if (i === 8) { rejected = true; console.log('P8 rejected as expected:', e); } });
  s.on('gameover', ({ winner }) => {
    if (over) return;
    over = true;
    console.log(`gameover: ${winner}, shots=${shots}, hits=${hits}`);
    console.log('turn order sample:', orderLog.slice(0, 12).join(' -> '));
    const okOrder = orderLog.length >= 4;
    console.log(okOrder && hits > 0 ? 'TEAM TEST PASSED' : 'TEAM TEST FAILED');
    bots.forEach(b => b.close());
    setTimeout(() => process.exit(okOrder && hits > 0 ? 0 : 1), 200);
  });
  return s;
}

for (let i = 0; i < 8; i++) { bots.push(makeBot(i)); }
setTimeout(() => { for (let i = 0; i < 8; i++) setTimeout(() => bots[i].emit('quickMatch'), i * 250); }, 100);
// 第9个客户端尝试加入满员房间，应被拒绝
setTimeout(() => {
  const p9 = io(URL, { transports: ['websocket'] });
  p9.on('err', (e) => { rejected = true; console.log('P9 rejected as expected:', e); process.exit(rejected && over && hits > 0 ? 0 : 1); });
  p9.emit('joinRoom', firstRoomId);
}, 12000);
setTimeout(() => { if (!over) { console.log('TIMEOUT. orderLog=', orderLog.join(',')); process.exit(1); } }, 240000);
