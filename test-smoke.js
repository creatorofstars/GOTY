/* 双人模拟对战冒烟测试 */
const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';

function client(name) {
  const s = io(URL, { transports: ['websocket'] });
  s.name = name;
  return s;
}

const a = client('Alice'), b = client('Bob');
let state = { a: null, b: null };
let done = false;

function fireWhenMyTurn(sock) {
  sock.on('turn', (t) => {
    const st = state[sock === a ? 'a' : 'b'];
    if (!st || !st.players.some(p => p.isYou)) return;
    setTimeout(() => {
      sock.emit('aim', { angle: 40 + Math.random() * 20, power: 45 + Math.random() * 30 });
      setTimeout(() => sock.emit('fire'), 100);
    }, 200);
  });
}

[a, b].forEach(fireWhenMyTurn);

function hook(sock, key) {
  sock.on('joined', (d) => console.log(`[${sock.name}] joined room ${d.roomId}, spectator=${d.isSpectator}, inGame=${d.inGame}`));
  sock.on('room', (r) => {
    console.log(`[${sock.name}] room event: state=${r.state}, host=${r.hostSid === sock.id}, players=${r.players.filter(p=>!p.spectator).length}`);
    if (r.state === 'waiting' && r.hostSid === sock.id && r.players.filter(p => !p.spectator).length >= 2) {
      console.log(`[${sock.name}] starting game!`);
      sock.emit('startGame');
    }
  });
  sock.on('state', (st) => {
    state[key] = st;
    const you = st.players.find(p => p.isYou);
    if (you) sock.mySlot = you.slot;
  });
  sock.on('shot', (d) => {
    if (sock.name === 'Alice')
      console.log(`  shot: ${d.points.length} pts, explosion=${!!d.explosion}, dmg=${JSON.stringify(d.damage)}, terrain=${(d.terrain||[]).length}`);
  });
  sock.on('gameover', ({ winner }) => {
    console.log(`[${sock.name}] 🏆 winner: ${winner}`);
    if (!done) { done = true; console.log('SMOKE TEST PASSED'); }
    a.close(); b.close();
    setTimeout(() => process.exit(0), 200);
  });
  sock.on('msg', (m) => { if (sock.name === 'Alice') console.log(`[chat${m.sys ? '-sys' : ''}] ${m.name || ''}: ${m.text}`); });
  sock.on('err', (e) => console.log(`[${sock.name}] ERR: ${e}`));
}
hook(a, 'a'); hook(b, 'b');

setTimeout(() => a.emit('quickMatch'), 200);
setTimeout(() => b.emit('quickMatch'), 800);
setTimeout(() => { if (!done) { console.log('TIMEOUT: test incomplete'); process.exit(1); } }, 120000);
