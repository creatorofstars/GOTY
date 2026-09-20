# DDTank Online 💣 · 弹弹堂 Online

> 🌍 This README is bilingual — English first, Chinese below in every section.
> 本说明文档为双语 — 每个部分先英文，后中文。

## About | 简介

**EN:** An HTML5 multiplayer online turn-based artillery game that recreates the core gameplay of *DDTank (弹弹堂)*. It includes a landing page and an opening cinematic, and supports two modes: PVP team battles and PVE monster fights. The interface is bilingual (English / Chinese).

**中文：** 复刻《弹弹堂》核心玩法的 HTML5 多人在线回合制炮弹对战游戏。带官网落地页与开篇动画，支持 PVP 团队对战与 PVE 打怪两种模式，界面中英双语。

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
- **PVE**: Team up against the Monster Legion (minions + Boss) and win by wiping out all monsters. The Boss lobs "minion bombs" that land as reinforcements, and uses melee attacks up close
- Every player has **1000 HP**
- **Host system**: the player who creates (or first joins) a room becomes the host (👑) and presses "Start Game"; PVE can start with a single player, PVP needs at least 2. If the host leaves, the host role is transferred automatically
- The lobby room list shows **Join / Spectate** buttons per room; once a game starts you can only spectate. Disconnects are recovered through a **session-token reconnect** (30-second grace period, full game state restored)
- `A`/`D` move left/right (a 150px movement budget per turn), **hold** `W`/`S` to keep adjusting your angle — passing 90° automatically flips your character
- **Hold Space to charge, release to fire** (power depends on how long you hold)
- Wind is randomized every turn (wind gauge at the top) — trajectories are affected by gravity and wind
- Explosions **destroy terrain** and carve craters; enemies can fall in. The closer to the blast center, the higher the damage
- Real-time in-room chat and a "Rematch" option after the match. The UI is **bilingual (EN/中文)** via i18n with instant switching (including cards, upgrades and other dynamic text)

**中文：**

- **PVP**：红蓝两队（每队最多 3 人）轮流开炮，将敌方全员 HP 打到 0 即获胜；胜利/失败会在结算前播放对应的胜负动画视频（可点击跳过）
- **PVE**：玩家组队对抗怪物军团（小兵 + Boss），怪物全灭获胜；Boss 会朝玩家抛射"小兵炮弹"落地增援，靠近后近战攻击
- 玩家 HP 统一 **1000**
- **房主制度**：创建/第一个进入房间的玩家是房主（👑），由房主点击"开始游戏"；PVE 单人即可开局，PVP 至少 2 人；房主离开自动转移房主身份
- 大厅房间列表每项有 **加入 / 观战** 两个按钮；游戏开始后只能观战；掉线后凭会话令牌**重连恢复**（30 秒宽限期，恢复完整局面）
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

### 🃏 Card System (3 cards dealt each turn, play 1 per turn — doesn't use up your shot) | 卡牌系统（每回合发 3 张，每回合限打 1 张，不消耗开火机会）

**EN:** Heal (+150 HP) / Shield (blocks 150) / Double (+100 true damage) / Revenge (+100 on your next shot) / Poison (100 poison damage + poison for 2 more turns) / Blood Pact (+200 true damage, costs 125 HP, once per match) / Berserk (+80 for 3 turns) / Fortress (25% damage reduction for 3 turns)

**中文：** 治疗（+150 生命）/ 护盾（格挡 150）/ Double（+100 真实伤害）/ 复仇（下次炮击 +100）/ 涂毒（100 毒伤 + 2 回合持续毒）/ 血契（+200 真伤，消耗 125 生命，限一次）/ 狂暴（3 回合 +80）/ 堡垒（3 回合减伤 25%）

### 📈 Point Upgrades (bought in the in-match shop with turn points) | 积分强化（回合积分在局内商店购买）

**EN:** 8 upgrades including Extra Projectiles, Crit Chance, Damage Boost, Lifesteal, Precision (no damage falloff over distance) and Double Blast.

**中文：** 追加发射物、暴击率、伤害加成、汲血、精准（无距离衰减）、二次爆破等 8 种强化。

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

For production, a pm2 daemon is recommended:

```bash
npm i -g pm2
pm2 start server.js --name ddtgame
pm2 save && pm2 startup
```

Nginx reverse proxy (WebSocket-capable) reference:

```nginx
server {
    listen 80;
    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

Remember to open the port on your cloud server (security group / firewall).

**中文：** 仓库自带 `render.yaml`（Render 一键部署：新加坡区免费节点、自动从 GitHub 部署），步骤见 [DEPLOY.md](./DEPLOY.md)。

手动部署（任意 Node.js 主机）：

```bash
npm install --production
PORT=80 node server.js        # 或使用默认端口 5000
```

生产环境建议用 pm2 守护进程：

```bash
npm i -g pm2
pm2 start server.js --name ddtgame
pm2 save && pm2 startup
```

Nginx 反向代理（支持 WebSocket）参考配置：

```nginx
server {
    listen 80;
    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

云服务器请放行对应端口（安全组/防火墙）。

## Tech Architecture | 技术架构

| Component | Description |
| --- | --- |
| Server | Node.js + Express + Socket.IO, **server-authoritative**: trajectory simulation, collisions, damage, terrain destruction, turn timers and win/loss are all computed on the server — clients cannot cheat |
| Landing page | Pure static landing page (landing-page/) + opening cinematic page (/intro), deployed from the same origin as the game |
| Client | Native Canvas rendering (terrain, tanks, projectile trails, explosion particles, damage popups) with Socket.IO realtime sync; i18n bilingual UI; win/lose cinematic videos |
| Terrain | 1920-column heightmap generated from stacked random sine layers; explosions carve circular craters and sync incrementally to clients |
| Matching | Quick-match queue + custom rooms + spectating + chat + disconnect reconnect (session token + 30s grace period) |

| 部分 | 说明 |
| --- | --- |
| 服务端 | Node.js + Express + Socket.IO，**服务器权威**：弹道积分、碰撞、伤害、地形破坏、回合计时、胜负判定全部在服务端计算，客户端无法作弊 |
| 官网 | 纯静态落地页（landing-page/）+ 开篇动画页（/intro），与游戏同源部署 |
| 客户端 | 原生 Canvas 渲染（地形、坦克、弹道拖尾、爆炸粒子、伤害飘字），Socket.IO 实时同步；i18n 中英双语；胜负结算动画视频 |
| 地形 | 1920 列高度图，随机多层正弦叠加生成；爆炸按圆形切削并增量同步给客户端 |
| 匹配 | 快速匹配队列 + 自定义房间 + 观战 + 聊天 + 掉线重连（会话令牌 + 30 秒宽限） |

## Project Structure | 文件结构

**EN:**

```
server.js                Game server (rooms / turns / physics / damage / cards / upgrades / PVE monsters / routing)
landing-page/            Landing page (served at /)
public/intro.html        Opening cinematic page (/intro)
public/index.html        Lobby + battle interface (/game)
public/client.js         Canvas rendering and input
public/i18n.js           Bilingual EN/中文 text
public/sfx.js            Sound effects
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
server.js                游戏服务器（房间/回合/物理/伤害/卡牌/强化/PVE 怪物/路由）
landing-page/            官网落地页（/ 根路径）
public/intro.html        开篇动画页（/intro）
public/index.html        大厅 + 战斗界面（/game）
public/client.js         Canvas 渲染与输入
public/i18n.js           中英双语文案
public/sfx.js            音效
public/video/            胜负结算动画视频
opening-video/           开篇动画视频
render.yaml / DEPLOY.md  Render 部署配置与指南
test-smoke.js            双人随机对战冒烟测试
test-hit.js              精确命中/伤害/胜负集成测试
test-team.js             组队对战测试
tools/                   生成脚本与专项测试（重连/观战/卡牌/Boss 等）
```
