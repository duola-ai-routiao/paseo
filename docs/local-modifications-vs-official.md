# 本地改动总览（相对官方 getpaseo/paseo）

> 记录本地分支相对官方仓库的总体改动，含功能维度与代码量级。
> 基线：本地分支 `feat_ginit_connect_20260730`；对照官方 `upstream/main`（github.com/getpaseo/paseo）。
> 更新时间：2026-08-06

## 0. 一句话概括

本地相对官方 paseo 的核心改动，是**新增了一条「ginit（飞书）账号 → WebSocket Hub 中继器 → 本地 daemon」的连接链路**：用飞书账号做身份锚点，daemon 主动注册到 Hub，登录一次即可自动发现并一键连上该账号下**所有** daemon。官方 paseo 是逐台机器单独配对的模型，没有这套中心化 Hub 能力。

## 1. 对比基线

| 项                 | 值                                                            |
| ------------------ | ------------------------------------------------------------- |
| 本地当前分支       | `feat_ginit_connect_20260730`                                 |
| 对照官方分支       | `upstream/main`                                               |
| 共同祖先 commit    | `bb3f5c5`                                                     |
| 本地领先官方提交数 | 63（其中约 20 个为实际代码提交，其余为 docs/QW/summery 文档） |
| 官方领先本地提交数 | 175（官方后续版本未合并回本地）                               |

> 说明：本地分支与官方 HEAD 的完整 diff 会非常大（双向漂移造成），真正属于「本地新增」的内容以共同祖先 `bb3f5c5` 之后的净改动为准。

## 2. 代码量级

### 2.1 相对官方基线（merge-base → HEAD）

| 范围                                  | 文件数 | 增 / 删（行）     |
| ------------------------------------- | ------ | ----------------- |
| 全部改动（含文档）                    | 55     | +9,935 / −620     |
| **纯代码**（排除 docs/、\*.md、截图） | 46     | **+6,430 / −620** |
| 文档（QW/summery/部署记录）           | —      | 约 +3,500         |

### 2.2 纯代码按模块分布

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

### 2.3 运维脚本（官方没有）

| 脚本                             | 行数 | 作用                      |
| -------------------------------- | ---- | ------------------------- |
| `scripts/relay-server.mjs`       | 353  | 自建 Paseo 中继服务器     |
| `scripts/paseo-install-local.sh` | 273  | 本地源码 npm 全局安装     |
| `scripts/paseo-enroll.sh`        | 188  | 一键飞书登录 + enrollment |
| `scripts/deploy-local.sh`        | 119  | 本地部署                  |

## 3. 用户可感知的功能维度对比

### 3.1 主机发现 / 导入（核心差异）

| 维度            | 官方 paseo                                   | 本地（ginit 分支）                                        |
| --------------- | -------------------------------------------- | --------------------------------------------------------- |
| 添加远程 daemon | 每个**单独配对/上传**（relay 端点 / 配对码） | 飞书登录一次 → Hub **自动列出该账号下所有 daemon**        |
| 连接多台机器    | 逐个手动添加                                 | 设备列表对在线项点「**Connect here**」一键建立 relay 连接 |
| 账号归属        | 无账号概念，靠机器配对                       | daemon 注册绑定飞书用户（union_id），同一账号设备自动归拢 |

对应代码：app `GinitHubSection`（host-page.tsx）+463 行 —— 登录后 `hubListDevices()` 拉取账号下所有设备，每行「Connect here / Added」，经 `upsertRelayConnection` 一键连接。

### 3.2 登录 / 认证

| 维度     | 官方                 | 本地                                                                             |
| -------- | -------------------- | -------------------------------------------------------------------------------- |
| 认证方式 | 配对码 / relay token | **飞书(Feishu) SSO**，设备授权码流程（`auth/device/start` + `auth/device/poll`） |
| 浏览器端 | 无                   | 飞书登录走 daemon 代理避免 CORS；web/静态主机只读（`cacheOnly`，不注册为设备）   |

### 3.3 连接安全

| 维度     | 官方       | 本地                                                                |
| -------- | ---------- | ------------------------------------------------------------------- |
| 设备身份 | —          | 设备密钥对 + **TOFU 指纹**锁定 relay 公钥                           |
| 中继加密 | relay E2EE | Hub 签名密钥与 relay E2EE 密钥**分离**，hello 签名广播 relay 元数据 |

### 3.4 数据可见性

| 维度         | 官方 | 本地                                                                                        |
| ------------ | ---- | ------------------------------------------------------------------------------------------- |
| 远程看 agent | 单机 | Hub 拉取**工作区快照**，账号下所有机器的 running services 汇总                              |
| 设备状态     | —    | 显示每台 daemon 的 status / lastSeen / **connectionReady**，未就绪禁用「Connect」并提示原因 |

### 3.5 部署 / 运维（管理员向）

本地新增自建中继（`relay-server.mjs`）、一键飞书登录+enrollment（`paseo-enroll.sh`）、本地全局安装（`paseo-install-local.sh`）、本地部署（`deploy-local.sh`）。

## 4. 关键提交（代码部分）

```
feat: add ginit hub enrollment and login flow
feat: connect daemon to ginit hub and report workspace snapshots
feat: connect hosts from ginit account
feat: discover Paseo hosts with Feishu
feat: keep Feishu login as the only welcome action
feat: enroll against bare-IP testbed hub and honor split WS port
feat: separate relay E2EE key from hub signing key with signed relay metadata
feat: pin daemon relay key via TOFU fingerprint
feat: advertise relay metadata on signed hub hello
feat: support client-only Feishu host discovery
feat: dismantle web-host-as-device — paseo-web becomes read-only hub client
feat: adopt existing Paseo sessions / resume collected execution sessions
fix: route welcome Feishu login through daemon hub RPC to avoid CORS
fix: route ginit device auth flow through daemon to avoid CORS
feat(scripts): 新增 paseo-enroll.sh / paseo-install-local.sh
```

## 5. 相关文档

- `docs/ginit-paseo-design.md` — 系统设计（三平面：控制面/数据面/执行面）
- `docs/ginit-paseo-complete-architecture.md` — 部署/操作向架构
- `docs/hub.md` — Paseo Hub relationship（连接权威、会话授权）
- `docs/paseo-hub.md` — Hub 补充说明
- `docs/本地部署方式.md` — 6767 端口 daemon 部署与 Supervisor 机制
- `summery.md` — 逐次任务记录
