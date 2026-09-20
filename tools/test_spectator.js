const { io } = require('socket.io-client');
const URL = 'http://localhost:5099';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const conn = () => new Promise(r => { const s = io(URL, { transports: ['websocket'] }); s.on('connect', () => r(s)); });
(async () => {
  const A = await conn(); const B = await conn();
  A.emit('rename', 'P1'); A.emit('createRoom', 'spectest');
  await sleep(200);
  B.emit('rename', 'P2'); B.emit('joinRoom', 'spectest');
  await sleep(200);
  A.emit('startGame');
  await sleep(600);
  // 观战者中途加入
  const S = await conn();
  const st = await new Promise(r => { S.on('state', s => r(s)); S.emit('rename', 'Spec'); S.emit('joinRoom', 'spectest', { spectate: true }); });
  const spec = st.players.find(p => p.isYou);
  console.log('1. state含spectator字段:', st.players.every(p => typeof p.spectator === 'boolean'));
  console.log('2. 观战者标记正确:', spec && spec.spectator === true);
  console.log('3. 观战者在客户端过滤后不剩:', st.players.filter(p => !p.spectator).every(p => p.name !== 'Spec'));
  console.log('4. 快照含地形:', !!st.terrain);
  // 观战者伪造aim不应产生facing广播
  let facingFired = false;
  A.on('facing', () => facingFired = true);
  S.emit('aim', { angle: 80, power: 100, dir: -1 });
  await sleep(300);
  console.log('5. 观战者aim被拒绝(无facing广播):', !facingFired);
  A.close(); B.close(); S.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
