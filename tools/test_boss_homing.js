// 复现：鹰眼(ch=2)炮弹命中Boss是否掉血；对比其他角色
process.env.TEST_EXPORT = 1;
process.env.PORT = '5098';
const S = require('../server.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run(ch) {
  const room = S.createRoom('t' + ch, true);
  room.state = 'playing';
  const p = S.addPlayerToRoom(room, 's1', 'P', false);
  p.char = ch;
  S.spawnMonsters(room);
  const boss = room.monsters.find(m => m.kind === 'boss');
  // 把玩家直接放到Boss旁边，水平直射必中
  p.x = boss.x - 120;
  p.y = S.groundY(room.terrain, p.x);
  p.angle = 0; p.power = 60; p.dir = 1;
  const hp0 = boss.hp;
  const hits = [];
  const origPush = Array.prototype.push; // 记录boomFx不方便，直接监听msg
  S.fire(room, p);
  await sleep(4000); // 等弹道模拟+结算结束
  clearInterval(room.shotTimer); clearInterval(room.gravityTimer);
  clearInterval(room.bossShotTimer); clearInterval(room.timer);
  console.log(`ch=${ch}: boss hp ${hp0} -> ${boss.hp} (damage ${hp0 - boss.hp})`);
  return hp0 - boss.hp;
}

(async () => {
  for (const ch of [0, 1, 2, 3]) await run(ch);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
