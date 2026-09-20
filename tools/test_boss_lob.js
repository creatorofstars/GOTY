// 吊射场景：各角色从远处抛射命中Boss的掉血统计
process.env.TEST_EXPORT = 1;
process.env.PORT = '5097';
const S = require('../server.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function trial(ch, angle, power) {
  const room = S.createRoom('t', true);
  room.state = 'playing';
  const p = S.addPlayerToRoom(room, 's1', 'P', false);
  p.char = ch;
  S.spawnMonsters(room);
  const boss = room.monsters.find(m => m.kind === 'boss');
  p.x = 300; p.y = S.groundY(room.terrain, p.x);
  p.angle = angle; p.power = power; p.dir = 1;
  const hp0 = boss.hp;
  S.fire(room, p);
  await sleep(5000);
  for (const t of ['shotTimer', 'gravityTimer', 'bossShotTimer', 'timer']) clearInterval(room[t]);
  return hp0 - boss.hp;
}

(async () => {
  // 粗扫参数找能命中Boss的弹道（以ch=0为基准）
  let best = null;
  for (let a = 30; a <= 80; a += 5) {
    for (let pw = 100; pw <= 160; pw += 10) {
      const d = await trial(0, a, pw);
      if (d > 0 && (!best || d > best.d)) best = { a, pw, d };
    }
  }
  console.log('ch=0 最佳弹道:', best);
  if (!best) { console.log('未找到命中弹道'); process.exit(1); }
  for (const ch of [0, 1, 2, 3]) {
    const results = [];
    for (let i = 0; i < 8; i++) results.push(await trial(ch, best.a, best.pw));
    const hits = results.filter(d => d > 0).length;
    console.log(`ch=${ch}: 8次吊射命中Boss掉血次数=${hits}, 伤害=[${results.join(',')}]`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
