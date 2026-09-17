/* 精确命中测试：复算服务器弹道，解算力度命中对手，验证伤害与胜负 */
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const G = 0.28, MAX_DMG = 320, EXPLODE_R = 55;

function simulate(x0, y0, angle, power, wind, mask, dir) {
  const rad = angle * Math.PI / 180;
  const speed = power * 0.1425;
  let x = x0 + Math.cos(rad) * 22 * dir, y = y0 - Math.sin(rad) * 22 - 6;
  const vx = Math.cos(rad) * speed * dir;
  let vy = -Math.sin(rad) * speed;
  const solid = (x, y) => x >= 0 && x < 1200 && y >= 0 && y < 600 && mask[y * 1200 + x] === 1;
  for (let step = 0; step < 4000; step++) {
    x += vx * 0.7; y += vy * 0.7; vy += G * 0.7; x += wind * 0.012;
    if (x < -200 || x > 1400 || y > 700) return { x, y };
    if (step > 6 && solid(Math.round(x), Math.round(y))) return { x, y };
  }
  return { x, y };
}

function buildMask(heightArr) {
  const m = new Uint8Array(1200 * 600);
  for (let x = 0; x < 1200; x++) {
    const g = Math.round(heightArr[x] || 600);
    for (let y = g; y < 600; y++) m[y * 1200 + x] = 1;
  }
  return m;
}

const a = io(URL, { transports: ['websocket'] }), b = io(URL, { transports: ['websocket'] });
let mask = null, players = [], wind = 0, fired = { a: false, b: false };
let shotCount = 0, dmgSeen = 0, over = false, roomId = null, started = false;

function setup(sock, key) {
  sock.on('state', (st) => { mask = buildMask(st.terrain); players = st.players; });
  sock.on('joined', (d) => { roomId = d.roomId; });
  sock.on('room', (r) => {
    // 房主在双方到齐后开始游戏
    if (r.state === 'waiting' && r.hostSid === sock.id && r.players.filter(p => !p.spectator).length >= 2 && !started) {
      started = true;
      sock.emit('startGame');
    }
  });
  sock.on('turn', (t) => {
    wind = t.wind;
    if (!players.length || !players.some(p => p.isYou)) return;
    const me = players.find(p => p.isYou);
    const foe = players.find(p => !p.isYou && !p.spectator);
    if (fired[key] || over) return;
    fired[key] = true;
    setTimeout(() => {
      const dir = me.x < 600 ? 1 : -1;
      let best = { p: 50, err: 1e9 };
      for (let pw = 20; pw <= 100; pw += 0.5) {
        const r = simulate(me.x, me.y, 45, pw, wind, mask, dir);
        const err = Math.abs(r.x - foe.x);
        if (err < best.err) best = { p: pw, err };
      }
      const angle = 45;
      // 反推45°时的误差，若大于40px尝试其他角度
      sock.emit('aim', { angle, power: best.p });
      console.log(`[${key}] aiming power=${best.p} (err=${best.err.toFixed(0)}px)`);
      setTimeout(() => { sock.emit('fire'); setTimeout(() => fired[key] = false, 2500); }, 150);
    }, 300);
  });
  sock.on('shot', (d) => {
    shotCount++;
    for (const r of d.terrainRuns || []) {
      for (let y = r.y0; y <= r.y1; y++) mask[y * 1200 + r.x] = 0;
    }
    for (const pos of d.positions || []) {
      const p = players.find(q => q.slot === pos.slot);
      if (p) { p.x = pos.x; p.y = pos.y; }
    }
    for (const dm of d.damage || []) {
      const p = players.find(q => q.slot === dm.slot);
      if (p) { p.hp = dm.hp; p.alive = dm.alive; }
    }
    if (d.damage.length) {
      dmgSeen++;
      console.log(`[${key}] HIT! damage=${JSON.stringify(d.damage)}`);
    }
  });
  sock.on('gameover', ({ winner }) => {
    over = true;
    console.log(`gameover, winner=${winner}, shots=${shotCount}, hits=${dmgSeen}`);
    console.log(dmgSeen > 0 ? 'HIT TEST PASSED' : 'HIT TEST FAILED: no damage dealt');
    a.close(); b.close();
    setTimeout(() => process.exit(dmgSeen > 0 ? 0 : 1), 200);
  });
}
setup(a, 'a'); setup(b, 'b');
setTimeout(() => a.emit('createRoom'), 200);
setTimeout(() => b.emit('joinRoom', roomId), 800);
setTimeout(() => { if (!over) { console.log('TIMEOUT'); process.exit(1); } }, 180000);
