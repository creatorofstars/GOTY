/* 重连机制集成测试：
   场景1: PVE中掉线 → 同一token新连接恢复（席位/HP保留，含地形快照）
   场景3: 掉线超时(30秒) → PVE回等待，房间不残留掉线玩家 */
const { io } = require('socket.io-client');
const URL = 'http://localhost:' + (process.env.PORT || 5000);
const log = (...a) => console.log('[T]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const conn = () => new Promise(r => { const s = io(URL, { transports: ['websocket'] }); s.on('connect', () => r(s)); });

(async () => {
  const A = await conn();
  let aToken = '';
  A.on('session', ({ token }) => aToken = token);
  A.emit('rename', 'TesterA');
  A.emit('createRoomPve', 'rctest');
  await sleep(300);
  A.emit('startGame');
  await sleep(800);
  log('PVE started');

  // 场景1：掉线 → 宽限期 → token恢复
  A.disconnect(); A.close();
  await sleep(400);
  const st1 = await new Promise(r => {
    const B = conn().then(async s => {
      s.emit('resume', aToken);
      s.on('state', st => { if (st.terrain) { s.close(); r(st); } });
      setTimeout(() => r(null), 3000);
    });
  });
  const meA = st1 && st1.players.find(p => p.isYou);
  if (!st1 || !meA || meA.name !== 'TesterA') { console.error('FAIL 场景1: 恢复失败', st1 && st1.players); process.exit(1); }
  log('场景1 PASS: token恢复成功, hp=' + meA.hp + ', 带地形快照=' + !!st1.terrain);
  A.close && A.close();

  // 场景3：恢复者再次掉线且不回来 → 30秒宽限超时 → PVE回waiting
  const watcher = await conn();
  const finalRoom = new Promise(r => watcher.on('room', function h(room) { if (room.id === 'rctest' && room.state === 'waiting') { watcher.off('room', h); r(room); } }));
  watcher.emit('rename', 'W');
  watcher.emit('joinRoom', 'rctest'); // 观战位，观察超时后的房间状态
  await sleep(300);
  // 让局内玩家（TesterA，已在场景1的B连接里断开）真正超时：B已close，等31秒
  log('等待30秒宽限超时…');
  const roomAfter = await Promise.race([finalRoom, sleep(32000).then(() => null)]);
  const names = roomAfter ? roomAfter.players.map(p => p.name).join(',') : '(超时未回waiting)';
  if (!roomAfter || names.includes('TesterA')) { console.error('FAIL 场景3: 超时未正确移除', names); process.exit(1); }
  log('场景3 PASS: 超时后回waiting，剩余玩家=' + names);
  watcher.close();
  console.log('ALL PASS');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
