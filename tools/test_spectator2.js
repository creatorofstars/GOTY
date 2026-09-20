const { io } = require('socket.io-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const conn = () => new Promise(r => { const s = io('http://localhost:5099', { transports: ['websocket'] }); s.on('connect', () => r(s)); });
(async () => {
  const A = await conn(); const B = await conn();
  A.emit('rename', 'P1'); A.emit('createRoom', 'spectest2');
  await sleep(200);
  B.emit('rename', 'P2'); B.emit('joinRoom', 'spectest2');
  await sleep(200);
  A.emit('startGame'); await sleep(600);
  const S = await conn();
  const states = [];
  S.on('state', s => states.push(!!s.terrain));
  S.emit('rename', 'Spec'); S.emit('joinRoom', 'spectest2', { spectate: true });
  await sleep(600);
  console.log('收到的state带地形情况:', JSON.stringify(states), '=> 最终有快照:', states.includes(true));
  A.close(); B.close(); S.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
