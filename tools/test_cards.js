const { io } = require('socket.io-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const conn = () => new Promise(r => { const s = io('http://localhost:5099', { transports: ['websocket'] }); s.on('connect', () => r(s)); });
(async () => {
  const A = await conn(); const B = await conn();
  A.emit('rename', 'PA'); A.emit('createRoom', 'cardtest');
  await sleep(200);
  B.emit('rename', 'PB'); B.emit('joinRoom', 'cardtest');
  await sleep(200);
  A.emit('startGame');
  const handA = await new Promise(r => A.on('hand', h => r(h.cards)));
  // 等到自己回合并检查卡池
  const cardsA = handA.map(c => c.id);
  console.log('1. 手牌不含skip卡:', !cardsA.includes('skip'), cardsA.join(','));
  // 直接让B使用Double/fortress验证：伪造playCard非法卡会被拒
  // 检查B视角消息流：A出double后A的下一次炮击真实伤害
  // 通过监听msg验证出牌广播
  const msgs = [];
  A.on('msg', m => msgs.push(m.text));
  B.on('msg', m => msgs.push(m.text));
  // A使用double（若手牌有）
  if (cardsA.includes('double')) {
    A.emit('playCard', 'double');
    await sleep(300);
    console.log('2. double出牌广播:', msgs.some(x => x.includes('真实伤害')));
  } else console.log('2. 本回合无double卡,跳过');
  console.log('DONE');
  A.close(); B.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
