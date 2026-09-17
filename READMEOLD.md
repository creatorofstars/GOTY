# 弹弹堂 Online 💣

复刻《弹弹堂》核心玩法的 HTML5 多人在线回合制炮弹对战游戏。

## 玩法

- 两名玩家各控制一辆坦克，轮流开炮，将对方 HP 打到 0 即获胜
- **房主制度**：创建/第一个进入房间的玩家是房主（👑），由房主点击"开始游戏"；2~6 人可开局，人数不够需等待；房主离开自动转移房主身份
- 大厅房间列表每项有 **加入 / 观战** 两个按钮；游戏开始后只能观战
- `A`/`D` 左右移动（每回合 150px 移动预算），**按住** `W`/`S` 持续调整角度，越过 90° 会自动转身
- **按住空格蓄力、松开发射**（力度由按住时长决定）
- 每回合随机风力（顶部风力计），弹道受重力与风力影响
- 炮弹爆炸会**摧毁地形**炸出弹坑，敌人可能掉进坑里；离爆心越近伤害越高
- 房间满 2 人自动开局，其他玩家可进入房间**观战**；支持房间内实时聊天、结束后"再来一局"

## 本地运行

```bash
npm install
npm start
# 打开 http://localhost:3000 （开两个浏览器标签页即可对战）
```

## 部署到服务器

服务器已安装 Node.js，执行：

```bash
# 上传本项目目录到服务器后
npm install --production
PORT=80 node server.js        # 或使用默认端口 3000
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
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

云服务器请放行对应端口（安全组/防火墙）。

## 技术架构

| 部分  | 说明                                                                                |
| --- | --------------------------------------------------------------------------------- |
| 服务端 | Node.js + Express + Socket.IO，**服务器权威**：弹道积分、碰撞、伤害、地形破坏、回合计时、胜负判定全部在服务端计算，客户端无法作弊 |
| 客户端 | 原生 Canvas 渲染（地形、坦克、弹道拖尾、爆炸粒子），Socket.IO 实时同步                                      |
| 地形  | 1200 列高度图，随机多层正弦叠加生成；爆炸按圆形切削并增量同步给客户端                                             |
| 匹配  | 快速匹配队列 + 自定义房间 + 观战 + 聊天                                                          |

## 文件结构

```
server.js            游戏服务器（房间/回合/物理/伤害）
public/index.html    大厅 + 战斗界面
public/client.js     Canvas 渲染与输入
public/style.css     样式
test-smoke.js        双人随机对战冒烟测试
test-hit.js          精确命中/伤害/胜负集成测试
```
