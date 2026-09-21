// 双卡槽卡牌系统协议测试：开局随机卡 → 主动抽牌三选一 → 出牌 → 非法操作拒绝
const { io } = require('socket.io-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const conn = () => new Promise(r => { const s = io('http://localhost:5099', { transports: ['websocket'] }); s.on('connect', () => r(s)); });
(async () => {
  const A = await conn(); const B = await conn();
  const roomName = 'cardtest-' + Date.now(); // 房间在服务器上持久存在，用唯一名避免残留
  A.emit('rename', 'PA'); A.emit('createRoom', roomName);
  await sleep(200);
  B.emit('rename', 'PB'); B.emit('joinRoom', roomName);
  await sleep(200);
  A.emit('startGame');

  // 1. 开局：每人随机获得1张卡（槽0），槽1为空
  const hA = await new Promise(r => A.on('hand', d => r(d)));
  console.log('1. 开局槽0有卡:', !!hA.slots[0], hA.slots.map(c => c && c.id).join(','));
  if (!hA.slots[0]) throw new Error('开局未发卡');

  const msgs = [];
  A.on('msg', m => msgs.push(m.text));
  B.on('msg', m => msgs.push(m.text));

  // 2. 主动抽牌：三选一
  A.emit('drawDeck');
  const ch = await new Promise(r => A.on('cardChoice', d => { if (d.cards && d.cards.length) r(d); }));
  console.log('2. 抽牌候选3张:', ch.cards.length === 3, ch.cards.map(c => c.id).join(','));
  if (ch.cards.length !== 3) throw new Error('候选数不为3');

  // 3. 选一张填入槽1
  const pick = ch.cards[0].id;
  A.emit('pickCard', pick);
  const h2 = await new Promise(r => A.on('hand', d => r(d)));
  console.log('3. 选牌后槽1:', h2.slots[1] && h2.slots[1].id, '（期望', pick + '）');
  if (!h2.slots[1] || h2.slots[1].id !== pick) throw new Error('选牌未入槽');

  // 4. 槽1已有卡时再抽牌应被拒（仍回发旧候选为空/报错，不应覆盖槽1）
  A.emit('drawDeck');
  await sleep(200);

  // 5. 出牌：等到轮到 A 的回合再打槽0
  await new Promise(r => A.on('turn', t => { if (t.sid === A.id) r(); }));
  A.emit('playCard', 0);
  await sleep(300);
  console.log('4. 出牌广播:', msgs.some(x => x.includes('打出了卡牌') || x.includes('恢复') || x.includes('真实伤害') || x.includes('护盾') || x.includes('狂暴') || x.includes('堡垒') || x.includes('毒') || x.includes('血契')));

  // 6. 非法出牌：槽0已打空，再出应被拒
  const before = msgs.length;
  A.emit('playCard', 0);
  await sleep(200);
  console.log('5. 空槽出牌被拒:', before === msgs.length || !msgs.slice(before).some(x => x.includes('真实伤害')));

  console.log('DONE');
  A.close(); B.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
