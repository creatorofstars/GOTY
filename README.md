# The Last Star ⭐

> 🌍 This README is bilingual — English first, Chinese below in every section.
> 本说明文档为双语 — 每个部分先英文，后中文。

**EN:** The Last Star（最后一颗星）— an HTML5 multiplayer online turn-based artillery battle game. It includes a landing page and an opening cinematic, and supports two modes: PVP team battles and PVE monster fights. The interface is bilingual (English / Chinese).

**中文：** The Last Star（最后一颗星）—— HTML5 多人在线回合制炮弹对战游戏。带官网落地页与开篇动画，支持 PVP 团队对战与 PVE 打怪两种模式，界面中英双语。

## Pages | 页面结构

| Path | Content |
| --- | --- |
| `/` | Landing page (The Last Star style intro) — three Play buttons lead to `/intro` |
| `/intro` | Opening cinematic: click Start to play the intro video, then it automatically enters the game (click to skip) |
| `/game` | Game lobby + battle interface |

| 路径 | 内容 |
| --- | --- |
| `/` | 官网落地页（The Last Star 风格介绍页），三个 Play 按钮进入 `/intro` |
| `/intro` | 开篇动画页：点击 Start 播放开场视频，播完自动进入游戏（可点击跳过） |
| `/game` | 游戏大厅 + 战斗界面 |

## How to Play | 玩法

**EN:**

- **PVP**: Red vs Blue teams (up to 3 players each) take turns firing; knock every enemy player's HP to 0 to win. A victory/defeat cinematic video plays before the result screen (click to skip)
- **PVE**: Team up against the Monster Legion (minions + Boss) and win by wiping out all monsters — see the "👾 Monster Legion (PVE)" section below for monster AI behaviour
- Every player has **1500 HP**
- **Host system**: the player who creates (or first joins) a room becomes the host (👑) and presses "Start Game"; PVE can start with a single player, PVP needs at least 2. If the host leaves, the host role is transferred automatically
- The lobby room list shows **Join / Spectate** buttons per room; once a game starts you can only spectate. Disconnects are recovered through a **session-token reconnect** (30-second grace period, full game state restored — terrain craters and destroyed platforms are restored exactly, pixel by pixel, via a bitmask)
- `A`/`D` move left/right (a 150px movement budget per turn), **hold** `W`/`S` to keep adjusting your angle — passing 90° automatically flips your character
- **Hold Space to charge, release to fire** (power depends on how long you hold)
- Wind is randomized every turn (wind gauge at the top) — trajectories are affected by gravity and wind
- Explosions **destroy terrain** and carve craters; enemies can fall in. The closer to the blast center, the higher the damage
- Real-time in-room chat and a "Rematch" option after the match. The UI is **bilingual (EN/中文)** via i18n with instant switching (including cards, upgrades and other dynamic text)

**中文：**

- **PVP**：红蓝两队（每队最多 3 人）轮流开炮，将敌方全员 HP 打到 0 即获胜；胜利/失败会在结算前播放对应的胜负动画视频（可点击跳过）
- **PVE**：玩家组队对抗怪物军团（小兵 + Boss），怪物全灭获胜；怪物 AI 行为详见下方「👾 怪物军团（PVE）」
- 玩家 HP 统一 **1500**
- **房主制度**：创建/第一个进入房间的玩家是房主（👑），由房主点击"开始游戏"；PVE 单人即可开局，PVP 至少 2 人；房主离开自动转移房主身份
- 大厅房间列表每项有 **加入 / 观战** 两个按钮；游戏开始后只能观战；掉线后凭会话令牌**重连恢复**（30 秒宽限期，恢复完整局面——地形弹坑与被破坏平台按像素级掩码原样还原）
- `A`/`D` 左右移动（每回合 150px 移动预算），**按住** `W`/`S` 持续调整角度，越过 90° 会自动转身
- **按住空格蓄力、松开发射**（力度由按住时长决定）
- 每回合随机风力（顶部风力计），弹道受重力与风力影响
- 炮弹爆炸会**摧毁地形**炸出弹坑，敌人可能掉进坑里；离爆心越近伤害越高
- 支持房间内实时聊天、结束后"再来一局"；界面**中英双语**（i18n），可即时切换（含卡牌、强化等动态文案）

### 🧑‍🚀 The Four Fighters (each with a passive) | 四名角色（各带被动）

| Fighter | Passive |
| --- | --- |
| 轰侠 · Boom Hero | Blast radius +40% |
| 影袭 · Shadow Strike | 15% crit chance (crit damage +50%) |
| 鹰眼 · Hawk Eye | Projectiles within 150px automatically home onto the nearest enemy (damage factor 0.75) |
| 疾风 · Gale | Fires three shots at once (0.45 damage factor each) |

| 角色 | 被动 |
| --- | --- |
| 轰侠 | 爆炸范围 +40% |
| 影袭 | 15% 暴击率（暴击伤害 +50%） |
| 鹰眼 | 炮弹在 150px 内自动追踪吸附最近敌人（伤害系数 0.75） |
| 疾风 | 一次三发（每发伤害系数 0.45） |

### 🃏 Card System (dual card slots) | 卡牌系统（双卡槽制）

**EN:** Every player has two card slots: you **get 1 random card at match start**; during the game, click the "🂠 Deck" button at any time to **pick 1 of 3** random cards to fill your second slot (the deck can be drawn **once per match** and disappears once you've chosen). Cards can only be played on your own turn and don't consume your shot; a slot empties after playing — 2 cards per match in total. Both playing and picking cards come with sound effects and pop-in animations:

Heal (+250 HP) / Shield (blocks 250) / Double (+120 true damage) / Revenge (+100 on your next shot, stacks) / Poison (120 poison damage + 60 per turn for 2 more turns, stacks) / Blood Pact (+280 true damage, costs 150 HP, once per match) / Berserk (+70 for 3 turns) / Fortress (25% damage reduction for 3 turns)

> You can play two cards in the same turn: the true damage from Double Trouble / Blood Pact, and poison and Revenge stacks all apply together.

**中文：** 每位玩家有两个卡槽：**开局随机获得 1 张卡**；游戏进行中可随时点击"🂠 牌堆"按钮，从 3 张随机卡中**三选一**填入第二卡槽（牌堆**整局限抽一次**，选定后消失）。卡牌只能在轮到自己时打出，不消耗开火机会；打出后槽位清空，整局共 2 张。出牌与选牌均有卡牌音效与浮现动画：

治疗（+250 生命）/ 护盾（格挡 250）/ Double（+120 真实伤害）/ 复仇（下次炮击 +100，可叠加）/ 涂毒（120 毒伤 + 2 回合每回合 60 持续毒，可叠加）/ 血契（+280 真伤，消耗 150 生命，限一次）/ 狂暴（3 回合 +70）/ 堡垒（3 回合减伤 25%）

> 同回合可以连出两张卡：双重麻烦/血契的真实伤害、毒与复仇的层数均可叠加生效。

### 📈 Point Upgrades (bought in the in-match shop with turn points) | 积分强化（回合积分在局内商店购买）

**EN:** You automatically earn 100 points at the start of every turn. Buy only during your own turn — upgrades take effect for the current turn:

8 upgrades including Extra Projectiles, Crit Chance, Damage Boost, Lifesteal, Precision (no damage falloff over distance) and Double Blast.

**中文：** 每回合开始自动获得 100 积分，仅在自己回合可购买，强化当回合生效：

追加发射物、暴击率、伤害加成、汲血、精准（无距离衰减）、二次爆破等 8 种强化。

### 👾 Monster Legion (PVE) | 怪物军团（PVE）

**EN:** The match starts with **3 minions + 1 Boss** (with 4+ players, minion count scales with players), spawned on the right side of the map, advancing toward the players round by round:

| | Starting minion | Boss airdropped minion | Boss |
| --- | --- | --- | --- |
| HP | 450 | 200 | 1800 |
| Melee damage | 125 | 85 | 250 |
| Movement per action | 200px | same | 100px |

- **Serial actions**: during the monster phase, monsters act one at a time — the next one only starts after the previous has finished moving/attacking/its shell has landed. The player turn begins only after all monsters have acted
- **Attack on contact**: as soon as a monster gets within attack range it melees immediately that same turn without wasting actions; its movement auto-"brakes" at the edge of attack range so it never overshoots a player
- **Climbing**: when a monster runs into a steep wall (like the castle rampart) it switches to climbing — a slow vertical ascent that **also consumes its movement budget**; when the budget runs out it clings to the wall and resumes climbing from that point next round — on the castle map, monsters climb over the walls toward the players across multiple rounds
- **Boss airdrop**: every other action, the Boss lobs a "minion shell" that spawns a reinforcement minion where it lands (max 10 monsters on the field)
- Minions and the Boss always **face the nearest living player**; each monster's health bar shows its `current HP / max HP`

**中文：** 开局刷出 **3 只小兵 + 1 只 Boss**（4 名以上玩家时小兵按人数增加），出生在地图右侧，逐轮向玩家推进：

| | 开局小兵 | Boss 空投小兵 | Boss |
| --- | --- | --- | --- |
| 生命 | 450 | 200 | 1800 |
| 近战伤害 | 125 | 85 | 250 |
| 单次行动距离 | 200px | 同左 | 100px |

- **串行行动**：怪物阶段逐只行动，上一只走完/打完/炮弹落地，下一只才开始；全部行动完毕才轮到玩家回合
- **走到即砍**：贴近到攻击范围内当轮立即近战，不空耗回合；移动自动在攻击范围边缘"刹车"，不会越过玩家
- **攀爬机制**：撞上陡壁（如城堡城墙）转为攀爬，缓慢垂直上行且**同样消耗行动步数**；预算耗尽则挂壁待命，下一轮从断点继续爬——城堡图怪物会分多轮翻越城墙压向玩家
- **Boss 空投**：Boss 每隔一次行动抛射一枚"小兵炮弹"，落地生成增援小兵（场上怪物上限 10 只）
- 小兵与 Boss 始终**面向最近的存活玩家**；怪物血条内直接显示 `当前生命/最大生命`

### 🗺️ Maps | 地图

**EN:** `random` — random terrain (stacked sine layers + floating platforms) / `castle` — castle map (battlements + destructible vines). The host switches maps in the waiting room.

**中文：** `random` 随机地形（多层正弦叠加 + 空中平台）/ `castle` 城堡地图（垛口 + 可破坏藤蔓），房主在等待界面切换。

## Run Locally | 本地运行

**EN:**

```bash
npm install
npm start
# Open http://localhost:5000 (landing → Play → intro cinematic → /game; open two tabs to battle against yourself)
```

**中文：**

```bash
npm install
npm start
# 打开 http://localhost:5000 （落地页 → Play → 开篇动画 → /game；开两个标签页即可对战）
```

## Deployment | 部署

**EN:** The repo ships with `render.yaml` (one-click Render deployment: free Singapore-region node, auto-deploys from GitHub) — see [DEPLOY.md](./DEPLOY.md).

Manual deployment (any Node.js host):

```bash
npm install --production
PORT=80 node server.js        # or use the default port 5000
```

For production hosting, standard solutions like a pm2 daemon or an Nginx reverse proxy work fine (the proxy must support WebSocket), and you'll need to open the port in your cloud server's security group / firewall.

**中文：** 仓库自带 `render.yaml`（Render 一键部署：新加坡区免费节点、自动从 GitHub 部署），步骤见 [DEPLOY.md](./DEPLOY.md)。

手动部署（任意 Node.js 主机）：

```bash
npm install --production
PORT=80 node server.js        # 或使用默认端口 5000
```

生产环境可用 pm2 守护、Nginx 反向代理等常规方案托管（反代需支持 WebSocket），并在云服务器安全组/防火墙放行对应端口。

## Tech Architecture | 技术架构

| Component | Description |
| --- | --- |
| Server | Node.js + Express + Socket.IO, **server-authoritative**: trajectories, collisions, damage, terrain destruction, turn timers and win/loss are all simulated on the server at a unified tick rate — the client only renders and sends input, so cheating is impossible |
| Landing page | Pure static landing page (landing-page/) + opening cinematic page (/intro), deployed from the same origin as the game |
| Client | Native Canvas rendering (terrain, tanks, trajectories, explosion particles, damage popups) with smooth interpolation of server coordinates; Socket.IO realtime sync; i18n bilingual UI; win/lose cinematic videos |
| Terrain | Procedurally generated (random map: layered undulation + floating platforms / castle map: battlements + destructible vines); explosions carve circular craters; reconnects restore craters and destroyed platforms exactly from a snapshot |
| Audio | Web Audio synthesized effects + audio files (two BGM sets for lobby/battle, win/lose stingers, card sounds) |
| Matching | Quick-match queue + custom rooms + spectating + chat + disconnect reconnect (session token + 30s grace period) |

| 部分 | 说明 |
| --- | --- |
| 服务端 | Node.js + Express + Socket.IO，**服务器权威**：弹道、碰撞、伤害、地形破坏、回合计时、胜负判定全部在服务端按统一的 tick 节拍模拟，客户端只负责渲染与输入，无法作弊 |
| 官网 | 纯静态落地页（landing-page/）+ 开篇动画页（/intro），与游戏同源部署 |
| 客户端 | 原生 Canvas 渲染（地形、坦克、弹道、爆炸粒子、伤害飘字），对服务器坐标插值平滑；Socket.IO 实时同步；i18n 中英双语；胜负结算动画视频 |
| 地形 | 程序生成（随机地图多层起伏 + 空中平台 / 城堡地图垛口与可破坏藤蔓），爆炸按圆形破坏；重连时按快照原样还原弹坑与被破坏平台 |
| 音频 | Web Audio 合成音效 + 音频文件（大厅/战斗两套 BGM、胜负结算、卡牌音） |
| 匹配 | 快速匹配队列 + 自定义房间 + 观战 + 聊天 + 掉线重连（会话令牌 + 30 秒宽限） |

## Project Structure | 文件结构

**EN:**

```
server.js                Game server (rooms / turns / physics & damage / cards / upgrades / PVE monster AI / routing)
landing-page/            Landing page (served at /)
public/intro.html        Opening cinematic page (/intro)
public/index.html        Lobby + battle interface (/game)
public/client.js         Canvas rendering and input
public/style.css         UI styles (lobby / cards / deck / pick-one-of-three etc.)
public/i18n.js           Bilingual EN/中文 text
public/sfx.js            Sound effects (Web Audio synthesis + audio files)
public/sound/            Audio files used by the game (BGM / win-lose / card sounds)
sound/                   Audio asset library (full set, including unreferenced originals)
public/texture/          Character / monster textures
public/video/            Win/lose cinematic videos
opening-video/           Opening cinematic video
render.yaml / DEPLOY.md  Render deployment config and guide
test-smoke.js            Two-player random-battle smoke test
test-hit.js              Precise-hit / damage / win-condition integration test
test-team.js             Team battle test
tools/                   Generator scripts and targeted tests (reconnect / spectate / cards / Boss etc.)
```

**中文：**

```
server.js                游戏服务器（房间/回合/物理与伤害/卡牌/强化/PVE 怪物 AI/路由）
landing-page/            官网落地页（/ 根路径）
public/intro.html        开篇动画页（/intro）
public/index.html        大厅 + 战斗界面（/game）
public/client.js         Canvas 渲染与输入
public/style.css         界面样式（大厅/卡牌/牌堆/三选一等）
public/i18n.js           中英双语文案
public/sfx.js            音效（Web Audio 合成 + 音频文件）
public/sound/            游戏引用的音频文件（BGM/胜负/卡牌音）
sound/                   音频素材库（完整素材，含未引用原始文件）
public/texture/          角色/怪物贴图
public/video/            胜负结算动画视频
opening-video/           开篇动画视频
render.yaml / DEPLOY.md  Render 部署配置与指南
test-smoke.js            双人随机对战冒烟测试
test-hit.js              精确命中/伤害/胜负集成测试
test-team.js             组队对战测试
tools/                   生成脚本与专项测试（重连/观战/卡牌/Boss 等）
```
