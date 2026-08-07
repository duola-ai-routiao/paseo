# Paseo_ginit 重构（相对官方 getpaseo/paseo）

> 本文梳理本地分支相对官方 paseo 的整体改动，涵盖：架构总览、与官方版本的差异（功能 + 代码量级）、本地部署方式、飞书登录与主机发现、设备注册、安全边界与分阶段迁移。
>
> 基线：本地分支 `feat_ginit_connect_20260730`；对照官方 `upstream/main`（github.com/getpaseo/paseo）。更新日期：2026-08-07

## 目录

- [0. 一句话概括](#0-一句话概括)
- [1. 对比基线](#1-对比基线)
- [2. 架构总览：官方扫码配对 → ginit 飞书账号发现](#2-架构总览官方扫码配对--ginit-飞书账号发现)
- [3. 与官方版本的差异](#3-与官方版本的差异)
- [4. 部署](#4-部署)
- [5. 飞书登录与自动发现主机](#5-飞书登录与自动发现主机)
- [6. ginit Hub 设备注册](#6-ginit-hub-设备注册)
- [7. ginit CLI 与 Paseo daemon 的关系](#7-ginit-cli-与-paseo-daemon-的关系)
- [8. 跨服务器场景](#8-跨服务器场景)
- [9. 安全边界](#9-安全边界)
- [10. 架构修正与分阶段迁移](#10-架构修正与分阶段迁移)
- [11. 常用命令](#11-常用命令)
- [12. 相关文档](#12-相关文档)
- [13. 附录：核心改动模块](#13-附录核心改动模块)

---

## 0. 一句话概括

本地相对官方 paseo 的核心改动，是**新增了一条「ginit（飞书）账号 → WebSocket Hub 中继器 → 本地 daemon」的连接链路**：用飞书账号做身份锚点，daemon 主动注册到 Hub，登录一次即可自动发现并一键连上该账号下**所有** daemon。官方 paseo 是逐台机器单独配对的模型，没有这套中心化 Hub 能力。

---

## 1. 对比基线

| 项                 | 值                                                            |
| ------------------ | ------------------------------------------------------------- |
| 本地当前分支       | `feat_ginit_connect_20260730`                                 |
| 对照官方分支       | `upstream/main`                                               |
| 共同祖先 commit    | `bb3f5c5`                                                     |
| 本地领先官方提交数 | 63（其中约 20 个为实际代码提交，其余为 docs/QW/summery 文档） |
| 官方领先本地提交数 | 175（官方后续版本未合并回本地）                               |

> 说明：本地分支与官方 HEAD 的完整 diff 会非常大（双向漂移造成），真正属于「本地新增」的内容以共同祖先 `bb3f5c5` 之后的净改动为准。

---

## 2. 架构总览：官方扫码配对 → ginit 飞书账号发现

### 2.1 旧版 Paseo 架构：扫码配对

旧版 Paseo 主要由三个部分组成：

```text
1. Paseo daemon / 本地服务
2. Paseo relay / 中继服务
3. 手机端或 Web 客户端
```

旧版流程：

```text
服务器运行 Paseo daemon
  ↓
daemon 生成 pairing offer
  ↓
电脑显示二维码或 pairing link
  ↓
手机 Paseo 扫码
  ↓
手机拿到 serverId、relay endpoint、daemon public key
  ↓
手机保存 HostProfile
  ↓
手机通过 relay 连接 daemon
```

旧版二维码更准确地说是「**设备配对**」而不是账号登录。二维码/链接中的核心信息是 relay 连接所需信息，例如：

- `serverId`
- `daemonPublicKeyB64`
- relay endpoint
- TLS 配置

它不应该包含 Paseo password。

旧版的主要缺点：

- 每台机器都要单独扫码
- 换手机后需要重新配对
- 新增机器需要重新扫码
- 没有统一的「我的机器」列表
- 没有飞书账号和 Paseo device 的统一绑定
- 不能只通过账号恢复主机列表

### 2.2 新版架构：控制面 / 数据面 / 执行面三平面

新版将系统拆成「控制面 / 数据面 / 执行面」三个平面：

```text
ginit CLI 所在服务器（执行面）
  ├── ginit CLI / Claude / agent
  ├── Paseo daemon
  ├── Claude Stop hook
  └── relay client
          │
          ├── ginit Hub（控制面）：账号、设备归属、在线状态
          └── Paseo relay（数据面）：远程 E2E 数据中继
                    ▲
                    │
手机 / 浏览器 / Web 客户端
  └── 飞书登录 → 获取设备列表 → 选择主机 → relay 自动连接
```

**控制面：ginit Hub**

```text
飞书账号
  ↓
ginit Hub
  ↓
当前账号名下的 Paseo devices
```

ginit Hub 保存一个飞书账号名下的多台设备：

```text
飞书账号 A
  ├── Paseo server-a
  ├── Paseo server-b
  └── Paseo server-c
```

每台 device 记录包括：

- `device_id`
- `daemon_id`
- `name`
- `status`
- `public_key`
- `relay_endpoint`
- `relay_use_tls`
- `connection_ready`
- `last_seen_at`
- workspace snapshot

ginit Hub 负责控制面，负责飞书账号身份、Paseo device 归属、设备列表、在线/离线状态、最近在线时间、workspace snapshot、relay 连接元数据。**ginit Hub 不等于 Paseo relay，也不应该被当成 Paseo 数据面的明文隧道。**

**数据面：Paseo relay**

relay 负责连接实际数据：agent RPC、terminal 数据、workspace 操作、实时状态、agent 事件、加密会话内容。relay 的理想行为是只转发 E2E 加密数据，不能读取 Paseo 会话正文。

**执行面：ginit CLI 和 agent**

运行 ginit CLI 的服务器负责：运行 `ginit ccd`、运行 Claude/Codex agent、保存项目代码、保存工作目录、运行 Paseo daemon、运行 Claude Stop hook、将 ginit 会话导入 Paseo。Paseo daemon 应与 agent、代码和工作目录处于同一台机器，这样才能直接管理进程和文件。

### 2.3 目标使用体验

```text
打开 Paseo
  ↓
点击 Login with Feishu
  ↓
完成飞书授权
  ↓
显示当前账号下的所有 Paseo 主机
  ↓
选择 online 主机
  ↓
通过 relay 自动连接
```

用户不再需要手动填写：host、port、Paseo password、默认 host 地址、pairing link、二维码。

---

## 3. 与官方版本的差异

### 3.1 用户可感知的功能维度对比

#### 3.1.1 主机发现 / 导入（核心差异）

| 维度            | 官方 paseo                                   | 本地（ginit 分支）                                        |
| --------------- | -------------------------------------------- | --------------------------------------------------------- |
| 添加远程 daemon | 每个**单独配对/上传**（relay 端点 / 配对码） | 飞书登录一次 → Hub **自动列出该账号下所有 daemon**        |
| 连接多台机器    | 逐个手动添加                                 | 设备列表对在线项点「**Connect here**」一键建立 relay 连接 |
| 账号归属        | 无账号概念，靠机器配对                       | daemon 注册绑定飞书用户（union_id），同一账号设备自动归拢 |

对应代码：app `GinitHubSection`（host-page.tsx）+463 行 —— 登录后 `hubListDevices()` 拉取账号下所有设备，每行「Connect here / Added」，经 `upsertRelayConnection` 一键连接。

#### 3.1.2 登录 / 认证

| 维度     | 官方                 | 本地                                                                             |
| -------- | -------------------- | -------------------------------------------------------------------------------- |
| 认证方式 | 配对码 / relay token | **飞书(Feishu) SSO**，设备授权码流程（`auth/device/start` + `auth/device/poll`） |
| 浏览器端 | 无                   | 飞书登录走 daemon 代理避免 CORS；web/静态主机只读（`cacheOnly`，不注册为设备）   |

#### 3.1.3 连接安全

| 维度     | 官方       | 本地                                                                |
| -------- | ---------- | ------------------------------------------------------------------- |
| 设备身份 | —          | 设备密钥对 + **TOFU 指纹**锁定 relay 公钥                           |
| 中继加密 | relay E2EE | Hub 签名密钥与 relay E2EE 密钥**分离**，hello 签名广播 relay 元数据 |

#### 3.1.4 数据可见性

| 维度         | 官方 | 本地                                                                                        |
| ------------ | ---- | ------------------------------------------------------------------------------------------- |
| 远程看 agent | 单机 | Hub 拉取**工作区快照**，账号下所有机器的 running services 汇总                              |
| 设备状态     | —    | 显示每台 daemon 的 status / lastSeen / **connectionReady**，未就绪禁用「Connect」并提示原因 |

#### 3.1.5 部署 / 运维（管理员向）

本地新增了官方没有的自建运维脚本：自建中继（`relay-server.mjs`）、一键飞书登录 + enrollment（`paseo-enroll.sh`）、本地源码全局安装（`paseo-install-local.sh`）、本地部署（`deploy-local.sh`）。详见第 4 节。

### 3.2 代码量级

#### 3.2.1 相对官方基线（merge-base → HEAD）

| 范围                                  | 文件数 | 增 / 删（行）     |
| ------------------------------------- | ------ | ----------------- |
| 全部改动（含文档）                    | 55     | +9,935 / −620     |
| **纯代码**（排除 docs/、\*.md、截图） | 46     | **+6,430 / −620** |
| 文档（QW/summery/部署记录）           | —      | 约 +3,500         |

#### 3.2.2 纯代码按模块分布

| 模块           | 文件                                      | 新增行数       | 作用                                               |
| -------------- | ----------------------------------------- | -------------- | -------------------------------------------------- |
| Hub 连接器     | `server/src/server/hub/connector.ts`      | 656            | daemon 连接 Hub 的 WebSocket 连接器                |
| ginit 注册器   | `server/src/server/hub/ginit-enroller.ts` | 405            | 飞书登录 + 设备注册(enrollment)流程                |
| Hub 连接器 v2  | `server/src/server/hub/hub-connector.ts`  | 342            | TOFU 指纹、签名广播、relay 元数据                  |
| 设备密钥对     | `server/src/server/hub/device-keypair.ts` | 148            | 设备 E2EE 密钥 / 签名                              |
| Hub 协议       | `protocol/src/hub.ts`                     | 272            | Hub 协议 schema（v2）                              |
| 协议消息       | `protocol/src/messages.ts`                | +146           | 新增 hub 相关消息                                  |
| daemon 会话    | `server/.../daemon-session.ts`            | 209            | Hub 会话集成                                       |
| daemon 启动    | `server/src/server/bootstrap.ts`          | +122           | 启动时自动拉起 Hub 连接/轮询                       |
| agent 管理     | `server/.../agent-manager.ts`             | +40            | 会话快照上报挂点                                   |
| app 主机页     | `app/.../host-page.tsx`                   | +563           | 「Ginit Hub」区块：登录/设备列表/一键连接          |
| app host 类型  | `app/.../host-connection.ts`              | +54            | 新增字段                                           |
| daemon 指纹    | `app/.../daemon-fingerprint.ts`           | 36（+24 测试） | relay 公钥 TOFU                                    |
| CLI hub 命令   | `cli/.../daemon/hub.ts`                   | 84             | `paseo hub` 相关命令                               |
| WebSocket 服务 | `server/.../websocket-server.ts`          | +7             | hub socket 挂载                                    |
| **配套测试**   | hub/\*.test.ts 等                         | 约 1,900       | connector/enroller/hub-connector/device-keypair 等 |

#### 3.2.3 运维脚本（官方没有）

| 脚本                             | 行数 | 作用                      |
| -------------------------------- | ---- | ------------------------- |
| `scripts/relay-server.mjs`       | 353  | 自建 Paseo 中继服务器     |
| `scripts/paseo-install-local.sh` | 273  | 本地源码 npm 全局安装     |
| `scripts/paseo-enroll.sh`        | 188  | 一键飞书登录 + enrollment |
| `scripts/deploy-local.sh`        | 119  | 本地部署                  |

---

## 4. 部署

### 4.1 推荐生产部署拓扑

```text
服务器 A（执行面，ginit CLI 执行服务器）
├── ginit CLI
├── ginit runtime
├── Claude/Codex agent
├── 项目代码和工作目录
├── Paseo CLI
├── Paseo daemon
├── Claude Stop hook
└── Paseo relay client

阿里云（数据面）
└── Paseo relay（对外 relay.example.com:443）

手机 / 浏览器（C 端）
└── 访问 https://app.paseo.sh → 登录飞书 → 获取设备列表 → 通过 relay 连接
```

**网络方向**：

```text
服务器 A ──出站──> ginit Hub
服务器 A ──出站──> 阿里云 Paseo relay
手机/B ──出站──> ginit Hub
手机/B ──出站──> 阿里云 Paseo relay
```

服务器 A 不需要公网入站地址、不需要 SSH、不需要公网 IP，只需要出站访问互联网。不需要：将 6767 直接暴露到公网、端口映射到互联网。

如果服务器 A 完全无法访问外网，则飞书登录也无法穿透网络，需要 HTTP/SOCKS 代理、内网网关、VPN 或其他出站通道（见 4.3）。

### 4.2 本地部署方式（新增）

> 本机 `/home/alan/paseo` 仓库，Node v24.18.0（nvm）。详细说明见 `docs/本地部署方式.md`。

#### 4.2.1 本机 6767 端口现状

| 项目     | 详情                                                            |
| -------- | --------------------------------------------------------------- |
| 服务     | Paseo Daemon（agent 生命周期管理 + WebSocket API + MCP server） |
| 进程     | `Paseo Daemon`（父进程 `Paseo Supervisor`，负责守护与崩溃重启） |
| 运行时   | `/home/alan/.nvm/versions/node/v24.18.0/bin/node`               |
| 代码来源 | 直接运行 `/home/alan/paseo` 仓库工作区代码（非 npm 全局安装）   |
| 监听地址 | `127.0.0.1:6767`（仅本机回环，不暴露局域网/公网）               |
| 数据目录 | `PASEO_HOME=/home/alan/.paseo`（生产 home）                     |
| 健康检查 | `curl http://127.0.0.1:6767/api/health` → `{"status":"ok"}`     |

同机其他实例：**6769 端口**（另一个 Daemon，由 Supervisor 拉起）；**Docker 容器 `paseo`**（容器内 6767 映射到宿主 8234 端口，与 6767 互不冲突）。

#### 4.2.2 Supervisor 守护机制

Supervisor 本身**不做远程同步**，只有两个纯本地计时器：

| 计时器                       | 周期     | 用途                                       |
| ---------------------------- | -------- | ------------------------------------------ |
| Supervisor → Worker IPC 心跳 | 每 1 秒  | 确认 daemon worker 子进程活着              |
| PID 锁心跳                   | 每 30 秒 | 刷新 `$PASEO_HOME` 下 pid 锁，防多实例冲突 |

远程访问由 daemon 进程通过 **relay 长连接**（E2E 加密 WebSocket）实现，事件实时推送，无固定同步周期。标准部署**不需要 systemd / Docker / pm2**——Paseo 自带 Supervisor 守护机制。

#### 4.2.3 本地部署的两条路线

**路线 A：复现当前部署（仓库代码直跑，ginit 同款）⭐推荐**

与当前 6767 跑的方式完全一致——直接用仓库代码启动，当前分支的 ginit/hub 改动全部生效：

```bash
cd /home/alan/paseo

# 1. 确保依赖和构建产物是最新的
npm install
npm run build:server

# 2. 启动 daemon（后台模式，默认 6767 端口、~/.paseo 数据目录）
PASEO_HOME=/home/alan/.paseo \
PASEO_LISTEN=127.0.0.1:6767 \
npx tsx packages/server/scripts/supervisor-entrypoint.ts

# 或用 ginit 的 CLI 包装方式启动（和现在一模一样）
cd /home/alan/paseo
PASEO_HOME=/home/alan/.paseo ./packages/cli/bin/paseo daemon start
```

> 注意：`packages/cli/bin/paseo` 指向 `dist/index.js`，所以第 1 步的 `npm run build:server` 必须先跑。

验证：

```bash
curl http://127.0.0.1:6767/api/health
# 期望输出: {"status":"ok","timestamp":"..."}
```

**路线 B：官方标准部署（npm 全局安装）**

```bash
# 1. 停掉当前仓库代码跑的 daemon
cd /home/alan/paseo
./packages/cli/bin/paseo daemon stop
# 或： kill <Supervisor PID>（会带着 worker 一起退）

# 2. 用全局 CLI 启动（官方纯净版）
npm install -g @getpaseo/server @getpaseo/cli
paseo daemon start

# 3. 验证
paseo daemon status
curl http://127.0.0.1:6767/api/health
```

**两条路线的区别**

|          | 路线 A（仓库直跑）                             | 路线 B（全局安装）                       |
| -------- | ---------------------------------------------- | ---------------------------------------- |
| 代码内容 | **当前分支的所有改动都生效**（ginit/hub 功能） | 官方纯净版，**没有 ginit 改动**          |
| 更新方式 | `git pull` + `npm run build:server` + 重启     | `npm i -g ...@latest` + `daemon restart` |
| 适合场景 | 正在开发 ginit 接入，需要改动实时生效          | 只想要稳定的官方功能                     |

**⚠️ 关键提醒**：当前分支改动（ginit 连接、hub 密钥分离等）只有在路线 A 下才生效；切到路线 B 后 ginit 相关功能会消失。且 6767 的 daemon 正在管理运行中的 agent，**stop/restart 之前确认没有重要任务在跑**。

#### 4.2.4 常用管理命令

```bash
paseo daemon status                 # 查看状态
paseo daemon restart                # 重启
paseo daemon stop                   # 停止
paseo daemon start --web-ui         # 开启内置 Web UI（http://localhost:6767/）
paseo daemon start --no-relay       # 禁用 relay（仅本机访问）
paseo daemon start --port 6768      # 换端口
paseo daemon start --foreground     # 前台调试模式
```

#### 4.2.5 可选：开机自启（user-level systemd）

官方无内置 systemd unit，如需开机启动：

```ini
# ~/.config/systemd/user/paseo.service
[Unit]
Description=Paseo Daemon
After=network-online.target

[Service]
ExecStart=%h/.nvm/versions/node/v24.18.0/bin/paseo daemon start --foreground
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now paseo
loginctl enable-linger $USER   # 未登录也保持运行
```

注意必须加 `--foreground`：让 systemd 直接管理前台进程，避免 detached 模式下 systemd 误判进程已退出。

#### 4.2.6 本地部署关键设计要点

1. **6767 是生产端口约定**：桌面端、手机 App、CLI 默认都连这个端口；开发用 `npm run dev`（端口 6768，`.dev/paseo-home`），避免与生产实例冲突。
2. **只监听 127.0.0.1**：远程访问走 relay（E2E 加密），不直接开放端口，这是安全模型要求（见 SECURITY.md）。
3. **崩溃自愈**：Supervisor 监听 worker 退出码，异常退出自动拉起，无需 systemd `Restart=always`。
4. **不要手动 `node dist/server/index.js` 裸跑**：那样没有 Supervisor、日志轮转、PID 锁，崩溃不会被托管。
5. **切勿随意重启 6767 端口的 daemon**——它管理着所有运行中的 agent（包括正在执行任务的 AI agent 自身）。

### 4.3 无公网 IP、无法 SSH 的场景

没有公网地址不等于不能远程访问。只要服务器 A 可以出站访问互联网：

```text
A → 阿里云 Paseo relay
手机/B → 阿里云 Paseo relay
```

即可建立反向连接。不需要 SSH、公网入站端口、端口映射、把 6767 暴露到公网。

可选替代方案：Cloudflare Tunnel、Tailscale/Headscale、FRP、自建反向隧道、公司内网出站网关。优先使用 Paseo relay，因为它与 Paseo HostProfile 和 E2E 连接模型一致。

如果 A 完全不能出站访问：飞书登录只能解决身份问题，不能解决网络不可达问题。此时必须提供 HTTP/SOCKS 代理、VPN、内网网关、能出站的 relay agent 或其他反向连接通道。

---

## 5. 飞书登录与自动发现主机

### 5.1 Welcome 页入口

Paseo Welcome 页新增 `Login with Feishu`。组件位置：`packages/app/src/components/ginit-feishu-welcome.tsx`，挂载于 `packages/app/src/components/welcome-screen.tsx`。

### 5.2 登录流程

```text
1. 用户点击 Login with Feishu
2. app 请求 ginit /auth/device/start
3. 打开 verification_uri
4. 用户完成飞书授权
5. app 轮询 /auth/device/poll
6. 拿到 ginit user token
7. app 请求 /api/paseo/devices
8. 显示当前飞书账号下的 Paseo devices
```

### 5.3 设备列表

设备列表显示：主机名称、online/offline 状态、Connect / Update host 状态。

只有满足以下条件才允许自动连接：

```text
status = online
connection_ready = true
```

### 5.4 自动 RelayHostConnection

选择主机后，app 使用 `server_id / daemon_id`、`relay_endpoint`、`relay_use_tls`、`public_key` 构造现有的 `RelayHostConnection`：

```TypeScript
{
  type: "relay",
  relayEndpoint: "relay.example.com:443",
  useTls: true,
  daemonPublicKeyB64: "..."
}
```

之后保存 HostProfile 并通过 relay 连接 daemon。

### 5.5 多台机器行为

飞书登录后会显示当前账号下所有已注册设备：

```text
server-a    online
server-b    online
server-c    offline
```

当前设计不是登录后同时连接所有机器，而是：

```text
飞书登录 → 自动发现所有机器 → 用户选择一台 → 自动连接
```

offline 机器显示但不能连接。

---

## 6. ginit Hub 设备注册

### 6.1 首次 enrollment

```text
飞书授权
  ↓
获得 ginit user token
  ↓
POST /api/paseo/enrollments
  ↓
获得一次性 enrollment ticket
  ↓
POST /api/paseo/enrollments/redeem
  ↓
注册 device_id、public key、relay metadata
```

Paseo daemon 上报的信息包括：`device_id`、`daemon_id`、`public_key`、`name`、`relay.endpoint`、`relay.use_tls`。

### 6.2 重复登录

同一台 daemon 重复登录不能重复注册相同 `device_id`。ginit Hub 返回 `device_id already enrolled`。这是服务端设备唯一性保护，不是测试伪造的错误。Paseo 端应将其视为重新授权/刷新账号 token，而不是重新创建设备。

### 6.3 设备列表

```HTTP
GET /api/paseo/devices
Authorization: Bearer ginit_user_token
```

当前返回字段包括：`device_id`、`daemon_id`、`name`、`status`、`public_key`、`relay_endpoint`、`relay_use_tls`、`connection_ready`、`last_seen_at`、`snapshot`。设备按当前飞书账号隔离，不同账号不能互相看到设备。

### 6.4 数据库迁移

ginit 新增迁移 `ginit-server/migrations/0020_paseo_relay_metadata.sql`，新增字段 `relay_endpoint`、`relay_use_tls`。旧设备没有这些字段时 `connection_ready = false`，需要重新 enrollment 或更新 daemon 才能被自动 relay 连接。

---

## 7. ginit CLI 与 Paseo daemon 的关系

### 7.1 旧方式：Paseo 直接启动 ginit（已废弃）

```text
Paseo → ginit ccd → agent
```

### 7.2 当前推荐方式：ginit 自己运行，Paseo 接收导入

```text
ginit ccd
  ↓
Claude Stop hook
  ↓
paseo agent import
  ↓
Paseo daemon
```

当前 hook 模板位置：`ginit-cli/paseo_auto_import.sh`；安装后位置：`~/.local/share/paseo-hooks/paseo-auto-import.sh`；Claude settings：`~/.claude/settings.json`。

hook 行为：

1. 读取 session ID
2. 读取 cwd
3. 读取 transcript
4. 使用 session ID 写幂等 marker
5. 执行 `paseo agent import`
6. 导入到同机 Paseo daemon
7. 失败不影响 Claude 会话
8. 如果发现 `PASEO_AGENT_ID`，跳过导入，避免自吞

完整链路：

```text
ginit ccd / Claude
  ↓
Claude Stop hook
  ↓
paseo agent import
  ↓
同机 Paseo daemon
  ↓
ginit Hub workspace snapshot
  ↓
远程 Paseo 可见
```

### 7.3 ginit 安装时自动配置 Paseo

ginit 已增加 `ginit paseo install`，`ginit up` 也会自动触发 Paseo 安装配置。

自动安装内容包括：

1. 检查 Paseo CLI；如果不存在，执行 `npm install --global @getpaseo/cli`
2. 创建或合并 `~/.paseo/config.json`
3. 默认配置 daemon `127.0.0.1:6767`
4. 启用 relay
5. 设置 app base URL `https://app.paseo.sh`
6. 安装 Claude Stop hook
7. 合并 `~/.claude/settings.json`
8. 已登录时执行 Paseo Hub attach

常用参数：

```bash
ginit paseo install
ginit paseo install --no-start
ginit paseo install --no-attach
ginit paseo install --paseo-home /path/to/paseo-home
ginit paseo install --listen 127.0.0.1:6767
ginit paseo install --name my-server
ginit paseo install --paseo-path /path/to/paseo
```

安装器不会覆盖已有用户配置，会保留 Hub token、relay 细节、provider 配置、daemon auth、terminal profiles、用户自定义字段。重复执行应保持幂等。

ginit release installer 安装完成后会尝试执行 `ginit paseo install --no-attach`。如果没有 Node.js/npm：ginit 本身仍然正常安装；Paseo 集成只输出 warning；用户之后安装 Node.js 后可再次执行 `ginit paseo install`。

---

## 8. 跨服务器场景

### 8.1 推荐

ginit CLI、agent、代码目录和 Paseo daemon 放在同一台服务器 A：

```text
服务器 A
├── ginit CLI
├── agent
├── workspace
└── Paseo daemon
```

手机/Web 通过 relay 连接 A。

### 8.2 不推荐

```text
服务器 A：ginit CLI / agent
服务器 B：Paseo daemon
```

这会导致 B 默认看不到 A 上的：agent 进程、cwd、项目文件、git 仓库、transcript、terminal、实时 stdout。

ginit Hub 的 workspace snapshot 不是进程迁移协议，Paseo relay 也不是 ginit CLI 到 Paseo 的导入协议。如果必须这样部署，需要额外增加：A 到 B 的安全远程导入 bridge、短期 import token、幂等 import API、transcript/metadata 上传、文件系统映射、实时 agent 控制协议。这会比同机部署复杂很多，而且只能显示历史或通过额外 bridge 控制 A 上的 agent。

---

## 9. 安全边界

### 9.1 不传 Paseo password

飞书自动连接方案不应把 Paseo password 放到：ginit Hub device 列表、URL、relay metadata、HostProfile relay 字段、日志、transcript。relay 连接使用 relay endpoint、daemon public key、E2E handshake、后续短期 connection token。

### 9.2 ginit token

当前早期实现会在 app 安全存储中保存 ginit user token，用于查询设备列表。正式生产建议增加 `POST /api/paseo/devices/{device_id}/connect`，返回短期、一次性 connection token，避免长期使用高权限用户 token。

### 9.3 设备隔离

ginit Hub 必须始终按照当前飞书 user_id 过滤：账号 A 只能看到账号 A 拥有的 Paseo devices，账号 B 不能看到账号 A 的设备。

### 9.4 Relay 不做明文业务代理

ginit Hub 只做控制面，Paseo relay 负责数据面。不要把完整 Paseo session 明文转发逻辑塞进 ginit Hub。

---

## 10. 架构修正与分阶段迁移

### 10.1 架构修正基线（2026-07-28）

当前测试部署将多个独立角色放在同一台 testbed，但这些角色不能继续统称为「中继服务器」。必须遵守以下边界：

1. **Web client 只是 C 端**，不得因为托管 Web UI 而 enroll 成一台空 daemon；设备列表只包含真正运行 agent/workspace 的 A 端 daemon。
2. **Hub HTTP、Hub WebSocket 和 relay 是三个协议角色**。它们可以同机部署，但必须使用明确的域名和路径，不能依靠「8234/8235 是什么」的隐含约定。
3. **公网控制面必须使用 HTTPS/WSS**。当前裸 IP HTTP/WS 仅为临时测试入口，不是可上线架构。
4. **enrollment 只建立账号与设备身份绑定**；relay endpoint、TLS 和在线状态属于运行时 metadata，应在签名 hello/metadata 更新中刷新。
5. **app 不得无条件接受 Hub 返回的新 daemon public key**。首次连接应建立 TOFU 信任，后续 key 变化必须显式重新配对或确认轮换。
6. **环境地址必须由运行期配置或服务端下发**，不能硬编码在 App bundle，也不能由独立端口环境变量隐式推导。

### 10.2 分阶段迁移顺序

为避免同时破坏旧 daemon、旧 Hub 和现有测试部署，修正顺序固定为：

1. 先统一 HTTPS/WSS endpoint 契约并提供旧配置兼容
2. 再把 relay metadata 从 enrollment 迁移到签名 hello/heartbeat 更新
3. 再增加 public key fingerprint、TOFU 和 key rotation
4. 再将 8236 迁移为 client-only Web，移除空 daemon device
5. 最后把 relay 公网入口统一到 WSS 443，并下线裸 IP 8234

每个协议新增字段都必须 optional，并用 `COMPAT(...)` 标记旧协议兼容代码及删除时间。

### 10.3 已落地进度（代码侧）

**Web 宿主即设备的拆除（阶段 4，2026-07-28 已完成代码侧）**：paseo-web（8234 容器 / B 的 8236）不再 enroll 成 hub device，改成「匿名/只读 hub 会话」：

```text
[旧架构]  paseo-web ──(enroll 作为 Device)──> Hub
[新架构]  paseo-web ──(仅提供静态网页 & JS Bundle)──> 浏览器
                                                    │
                                            (以 User Token 身份/只读)
                                                    ▼
                                                   Hub (只列出真正 Device)
```

关键改动：协议 `hub.login_ginit.request` 新增 optional `cacheOnly`；Server 端 `GinitHubEnroller` 新增 `cacheAccountToken()`/`accountToken()`；App Welcome 页登录后 `cacheOnly` 只缓存账号 token，再用 User Token 直接列设备；Host 设置页未 enrolled 时渲染只读提示；8234 容器剥掉 `daemon.hub` 设备身份；删除一次性 enroll 脚本。

8236 这类只托管静态 Web client 的部署还必须设置 `PASEO_WEB_UI_CLIENT_ONLY=true`，避免浏览器把静态站点自身误当成 Paseo daemon 后永久显示 `Connecting`。

**运行期 endpoint 配置、hello 中继元数据与 TOFU（阶段 1–3，2026-07-28 已完成代码侧）**：

1. **运行期 endpoint**：daemon 新增 `PASEO_GINIT_BASE_URL` / `PASEO_GINIT_HUB_WS_URL` 环境变量，web-ui 注入 `window.PASEO_GINIT_CONFIG`，app 经 `getGinitBaseUrl()` 运行期读取，删掉了 app 里的硬编码 IP。
2. **hello 中继元数据**：`hub.hello` 携带 `relay {endpoint,use_tls}`，ginit gateway 验签后原子刷新 `paseo_devices.relay_endpoint/relay_use_tls`；enrollment 回归「只绑身份」。
3. **TOFU 公钥固定**：`RelayHostConnection` 新增 `trustedKeyFingerprint`，首次插入固定指纹，后续 key 变化直接抛「Daemon key changed … Re-pair」，不再静默覆盖被信任的 key。

对应提交：Paseo `cae8d51a9`（hello 中继元数据）、`e1b99e61f`（TOFU）；ginit `4ff8a35`（gateway 应用 hello relay metadata）。

**Relay 公网入口收敛（阶段 5，部署待定）**：代码侧已就位（daemon 默认 relay endpoint `relay.paseo.sh:443` + `useTls`），剩余是纯部署动作：给 `/opt/paseo-relay` 套 Caddy（`wss://relay.example.com/ws` → `127.0.0.1:8234`）；A 端 `daemon.relay` 的 `publicEndpoint` 指到 `relay.example.com:443`；验证 WSS 握手 + E2E 后关掉 8234 裸端口；Hub 控制面同理收敛到 443 域名。

---

## 11. 常用命令

### ginit

```bash
ginit login
ginit paseo install
ginit paseo install --no-attach
ginit paseo attach
ginit paseo status
ginit up
ginit doctor
```

### Paseo 本机

```bash
curl http://127.0.0.1:8234/
docker ps --filter name=paseo
docker logs paseo
```

### 本地部署

```bash
# 路线 A：仓库代码直跑（ginit 同款）
cd /home/alan/paseo
npm install && npm run build:server
PASEO_HOME=/home/alan/.paseo ./packages/cli/bin/paseo daemon start

# 路线 B：npm 全局安装官方版
npm install -g @getpaseo/server @getpaseo/cli
paseo daemon start

# 验证
curl http://127.0.0.1:6767/api/health
```

---

## 12. 相关文档

- `docs/ginit-paseo-design.md` — 系统设计（三平面：控制面/数据面/执行面）
- `docs/ginit-paseo-complete-architecture.md` — 部署/操作向架构
- `docs/local-modifications-vs-official.md` — 本地相对官方改动总览（功能 + 代码量级）
- `docs/hub.md` — Paseo Hub relationship（连接权威、会话授权）
- `docs/paseo-hub.md` — Hub 补充说明
- `docs/本地部署方式.md` — 6767 端口 daemon 部署与 Supervisor 机制
- `summery.md` — 逐次任务记录

---

## 13. 附录：核心改动模块

本地相对官方的核心改动集中在 Hub 连接器、ginit 注册器、设备密钥对、Hub 协议四块，详细代码量级见第 3.2 节。功能上最核心的差异是「主机发现 / 导入」：官方逐台配对，本地飞书登录一次自动发现并一键连接账号下所有 daemon（见第 3.1.1 节）。
