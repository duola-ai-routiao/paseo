# Ginit + Paseo 完整架构、部署与使用说明

> 更新时间：2026-07-26
>
> 本文汇总 ginit CLI、Paseo daemon、Paseo Web 客户端、ginit Hub 和 Paseo relay 的当前架构、旧版与新版差异、安装配置、登录流程、网络拓扑、地址和待完成事项。

## 1. 结论摘要

当前系统已经从“扫码配对单台 Paseo 主机”逐步升级为“飞书账号发现 Paseo 主机”的架构：

```text
ginit CLI 所在服务器
  ├── ginit CLI / Claude / agent
  ├── Paseo daemon
  ├── Claude Stop hook
  └── relay client
          │
          ├── ginit Hub：账号、设备归属、在线状态
          └── Paseo relay：远程 E2E 数据中继
                    ▲
                    │
手机 / 浏览器 / Web 客户端
  └── 飞书登录 → 获取设备列表 → 选择主机 → relay 自动连接
```

目标使用体验：

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

用户不再需要手动填写：

- host；
- port；
- Paseo password；
- 默认 host 地址；
- pairing link；
- 二维码。

当前实现已经完成了第一阶段的账号设备发现和 relay metadata 传递，但真实 Web 跨域适配、阿里云 relay 正式部署和完整 relay E2E 仍需继续完成，详见[第 14 节](#14-当前遗留事项)。

---

## 2. 当前各服务和地址

### 2.1 远程 Paseo Web 客户端

当前远程 Web 客户端地址：

```text
https://app.paseo.sh
```

打开后目标流程是点击：

```text
Login with Feishu
```

### 2.2 本机 Paseo daemon

当前本机 Docker 部署：

```text
宿主机端口：8234
容器内部端口：6767
```

Docker 映射：

```text
0.0.0.0:8234 → 容器:6767
```

本机访问：

```text
http://127.0.0.1:8234
```

局域网访问：

```text
http://192.168.3.2:8234
```

当前部署目录：

```text
/home/alan/paseo-deploy
```

当前容器：

```text
paseo
```

当前 daemon 内部监听：

```text
127.0.0.1:6767
```

宿主机通过 Docker 将其映射到 8234。8234 是 Paseo daemon/Web UI 的入口，不是 relay 服务地址。

### 2.3 ginit Hub

当前 staging ginit Hub（部署在 ginit-testbed 150.5.173.43）有两组地址：

**裸 IP 直连（当前 A/C 端默认，2026-07-28 起）**：

```text
http://150.5.173.43:8090               (HTTP REST: enrollments/devices/device flow)
ws://150.5.173.43:8235/ws/v1/paseo     (Hub WebSocket)
http://150.5.173.43:8235/auth/feishu/* (飞书 OAuth 浏览器跳转，与 WS 同端口)
```

**域名 + TLS（Caddy→8090/8235，仍需在飞书应用后台登记域名回调才可用于登录）**：

```text
https://staging.ginit.opensii.ai
wss://staging.ginit.opensii.ai/ws/v1/paseo
```

staging 环境说明：

- staging 的飞书 SSO 应用是 `cli_aacb827247389bde`（GAIR 账号可用）；
  **上线生产时必须换成生产专用应用**，不要在生产使用该 app id；
  IM connector (bot) 另有独立应用，不能与 SSO 应用混用。
- 飞书回调当前配置为 `http://150.5.173.43:8235/auth/feishu/callback`
  （8235 端口用 websockets 的 `process_request` 钩子同时服务 WS 升级和
  `/auth/feishu/*` 的普通 HTTP 请求）。该回调地址必须在飞书应用后台
  「安全设置 → 重定向 URL」里登记，否则授权页报 20029。
- 数据面 relay 同机自托管：`ws://150.5.173.43:8234`
  （`/opt/paseo-relay`，systemd `paseo-relay.service`，Node 实现，
  复刻 Cloudflare DO 的 v1/v2 线协议）。

prod ginit Hub WebSocket 地址（旧默认）：

```text
wss://ginit.opensii.ai/ws/v1/paseo
```

ginit Hub 负责控制面：

- 飞书账号身份；
- Paseo device 归属；
- 设备列表；
- 设备在线/离线状态；
- 最近在线时间；
- workspace snapshot；
- relay 连接元数据。

ginit Hub 不等于 Paseo relay，也不应该被当成 Paseo 数据面的明文隧道。

### 2.4 Paseo relay

Paseo relay 负责数据面：

```text
手机/Web Paseo client ↔ Paseo relay ↔ Paseo daemon
```

当前本机配置中 relay 开关已启用，但当前部署还没有明确配置独立公网 relay endpoint。因此，不能把当前本机 8234 端口当作 relay。

后续正式部署应将 relay 放到有公网地址的阿里云服务器，例如：

```text
relay.example.com:443
```

本机 daemon 作为 relay client 主动出站连接阿里云 relay；手机和 Web 客户端也主动连接 relay。

---

## 3. 旧版 Paseo 架构：扫码配对

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

旧版二维码更准确地说是：

```text
设备配对
```

而不是账号登录。二维码/链接中的核心信息是 relay 连接所需信息，例如：

- `serverId`；
- `daemonPublicKeyB64`；
- relay endpoint；
- TLS 配置。

它不应该包含 Paseo password。

旧版的主要缺点：

- 每台机器都要单独扫码；
- 换手机后需要重新配对；
- 新增机器需要重新扫码；
- 没有统一的“我的机器”列表；
- 没有飞书账号和 Paseo device 的统一绑定；
- 不能只通过账号恢复主机列表。

---

## 4. 新版架构：ginit + Paseo + 飞书 + relay

新版将系统拆成控制面和数据面。

### 4.1 控制面：ginit Hub

```text
飞书账号
  ↓
ginit Hub
  ↓
当前账号名下的 Paseo devices
```

ginit Hub 保存：

```text
飞书账号 A
  ├── Paseo server-a
  ├── Paseo server-b
  └── Paseo server-c
```

每台 device 记录包括：

- `device_id`；
- `daemon_id`；
- `name`；
- `status`；
- `public_key`；
- `relay_endpoint`；
- `relay_use_tls`；
- `connection_ready`；
- `last_seen_at`；
- workspace snapshot。

### 4.2 数据面：Paseo relay

relay 负责连接实际数据：

- agent RPC；
- terminal 数据；
- workspace 操作；
- 实时状态；
- agent 事件；
- 加密会话内容。

relay 的理想行为是只转发 E2E 加密数据，不能读取 Paseo 会话正文。

### 4.3 执行面：ginit CLI 和 agent

运行 ginit CLI 的服务器负责：

- 运行 `ginit ccd`；
- 运行 Claude/Codex agent；
- 保存项目代码；
- 保存工作目录；
- 运行 Paseo daemon；
- 运行 Claude Stop hook；
- 将 ginit 会话导入 Paseo。

Paseo daemon 应与 agent、代码和工作目录处于同一台机器，这样才能直接管理进程和文件。

---

## 5. 推荐部署拓扑

### 5.1 服务器 A：ginit CLI 执行服务器

```text
服务器 A
├── ginit CLI
├── ginit runtime
├── Claude/Codex agent
├── 项目代码和工作目录
├── Paseo CLI
├── Paseo daemon
├── Claude Stop hook
└── Paseo relay client
```

服务器 A 不需要公网入站地址，不需要 SSH，只需要出站访问：

```text
A → ginit Hub HTTPS/WebSocket
A → Paseo relay WebSocket
```

### 5.2 阿里云：Paseo relay

```text
阿里云公网服务器
└── Paseo relay
```

relay 对外提供：

```text
relay.example.com:443
```

服务器 A 主动连接 relay，手机/Web 客户端也主动连接 relay。

### 5.3 手机或浏览器

```text
手机 / 浏览器
├── 访问 https://app.paseo.sh
├── 登录飞书
├── 从 ginit Hub 获取设备列表
└── 通过 relay 连接选中的 Paseo daemon
```

### 5.4 网络方向

推荐网络关系：

```text
服务器 A ──出站──> ginit Hub
服务器 A ──出站──> 阿里云 Paseo relay
手机/B ──出站──> ginit Hub
手机/B ──出站──> 阿里云 Paseo relay
```

不需要：

- 服务器 A 公网 IP；
- 服务器 A 入站端口；
- SSH；
- 将 6767 直接暴露到公网；
- 端口映射到互联网。

如果服务器 A 完全无法访问外网，则飞书登录也无法穿透网络，需要 HTTP/SOCKS 代理、内网网关、VPN 或其他出站通道。

---

## 6. ginit 安装时自动配置 Paseo

ginit 已增加：

```bash
ginit paseo install
```

`ginit up` 也会自动触发 Paseo 安装配置。

### 6.1 自动安装内容

该流程负责：

1. 检查 Paseo CLI；
2. 如果不存在，执行：

```bash
npm install --global @getpaseo/cli
```

3. 创建或合并：

```text
~/.paseo/config.json
```

4. 默认配置 daemon：

```text
127.0.0.1:6767
```

5. 启用 relay；
6. 设置 app base URL：

```text
https://app.paseo.sh
```

7. 安装 Claude Stop hook；
8. 合并 `~/.claude/settings.json`；
9. 已登录时执行 Paseo Hub attach。

### 6.2 常用参数

```bash
ginit paseo install
ginit paseo install --no-start
ginit paseo install --no-attach
ginit paseo install --paseo-home /path/to/paseo-home
ginit paseo install --listen 127.0.0.1:6767
ginit paseo install --name my-server
ginit paseo install --paseo-path /path/to/paseo
```

### 6.3 默认配置原则

安装器不会覆盖已有用户配置，会保留：

- Hub token；
- relay 细节；
- provider 配置；
- daemon auth；
- terminal profiles；
- 用户自定义字段。

重复执行应保持幂等，不重复创建 hook，不重复破坏配置。

### 6.4 ginit 安装脚本

ginit release installer 安装完成后会尝试执行：

```bash
ginit paseo install --no-attach
```

如果没有 Node.js/npm：

- ginit 本身仍然正常安装；
- Paseo 集成只输出 warning；
- 用户之后安装 Node.js 后可再次执行：

```bash
ginit paseo install
```

---

## 7. ginit CLI 与 Paseo daemon 的关系

旧方式是 Paseo 直接启动 ginit：

```text
Paseo → ginit ccd → agent
```

当前推荐方式是 ginit 自己运行，Paseo 接收导入：

```text
ginit ccd
  ↓
Claude Stop hook
  ↓
paseo agent import
  ↓
Paseo daemon
```

当前 hook 模板位置：

```text
ginit-cli/paseo_auto_import.sh
```

安装后位置：

```text
~/.local/share/paseo-hooks/paseo-auto-import.sh
```

Claude settings：

```text
~/.claude/settings.json
```

hook 行为：

1. 读取 session ID；
2. 读取 cwd；
3. 读取 transcript；
4. 使用 session ID 写幂等 marker；
5. 执行 `paseo agent import`；
6. 导入到同机 Paseo daemon；
7. 失败不影响 Claude 会话；
8. 如果发现 `PASEO_AGENT_ID`，跳过导入，避免自吞。

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

---

## 8. 飞书登录和自动发现主机

### 8.1 Welcome 页入口

Paseo Welcome 页新增：

```text
Login with Feishu
```

组件位置：

```text
packages/app/src/components/ginit-feishu-welcome.tsx
```

挂载位置：

```text
packages/app/src/components/welcome-screen.tsx
```

### 8.2 登录流程

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

### 8.3 设备列表

设备列表显示：

```text
主机名称
online/offline 状态
Connect / Update host 状态
```

只有满足以下条件才允许自动连接：

```text
status = online
connection_ready = true
```

### 8.4 自动 RelayHostConnection

选择主机后，app 使用：

```text
server_id / daemon_id
relay_endpoint
relay_use_tls
public_key
```

构造现有的：

```ts
RelayHostConnection;
```

核心字段：

```ts
{
  type: "relay",
  relayEndpoint: "relay.example.com:443",
  useTls: true,
  daemonPublicKeyB64: "..."
}
```

之后保存 HostProfile 并通过 relay 连接 daemon。

### 8.5 多台机器行为

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

## 9. ginit Hub 设备注册

### 9.1 首次 enrollment

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

Paseo daemon 上报的信息包括：

- `device_id`；
- `daemon_id`；
- `public_key`；
- `name`；
- `relay.endpoint`；
- `relay.use_tls`。

### 9.2 重复登录

同一台 daemon 重复登录不能重复注册相同 `device_id`。ginit Hub 返回：

```text
device_id already enrolled
```

这是服务端设备唯一性保护，不是测试伪造的错误。

Paseo 端应将其视为重新授权/刷新账号 token，而不是重新创建设备。

### 9.3 设备列表

接口：

```http
GET /api/paseo/devices
Authorization: Bearer ginit_user_token
```

当前返回字段包括：

```text
device_id
daemon_id
name
status
public_key
relay_endpoint
relay_use_tls
connection_ready
last_seen_at
snapshot
```

设备按当前飞书账号隔离，不同账号不能互相看到设备。

### 9.4 数据库迁移

ginit 新增迁移：

```text
ginit-server/migrations/0020_paseo_relay_metadata.sql
```

新增字段：

```text
relay_endpoint
relay_use_tls
```

旧设备没有这些字段时：

```text
connection_ready = false
```

需要重新 enrollment 或更新 daemon 才能被自动 relay 连接。

---

## 10. 当前实现和原始文档的差异

旧文档描述的是：

```text
Paseo CLI 全局安装
  ↓
terminalProfiles 增加 ginit
  ↓
Paseo provider 直接执行 ginit ccd
```

旧配置示例：

```json
{
  "id": "ginit",
  "name": "ginit",
  "command": "IS_SANDBOX=1 ginit claude ccd"
}
```

以及：

```json
{
  "agents": {
    "providers": {
      "claude": {
        "command": ["ginit", "ccd"],
        "env": { "IS_SANDBOX": "1" }
      }
    }
  }
}
```

当前方案则是：

```text
ginit CLI 自己启动 ginit ccd
  ↓
Stop hook 自动 import
  ↓
Paseo daemon 管理导入结果
```

主要差异：

| 项目         | 旧方案             | 当前方案                    |
| ------------ | ------------------ | --------------------------- |
| Paseo 安装   | 手工 npm 安装      | ginit 安装/up 自动安装      |
| ginit 启动者 | Paseo provider     | ginit CLI                   |
| 会话接入     | terminal profile   | Claude Stop hook            |
| agent 导入   | 无自动导入         | `paseo agent import`        |
| Hub          | 无账号设备发现     | 飞书账号绑定设备            |
| Relay        | 可选扫码配对       | daemon 主动连接 relay       |
| 远程访问     | 手动 pairing       | 飞书登录发现设备            |
| host 配置    | 手工 host/password | 目标是自动 RelayHostProfile |
| 端口         | 本机 daemon        | Docker 8234 → 6767          |
| transcript   | 本机直接读取       | 宿主目录挂载/导入           |
| 多机管理     | 每台机器单独配对   | 飞书账号下设备列表          |

---

## 11. 跨服务器场景

### 11.1 推荐

ginit CLI、agent、代码目录和 Paseo daemon 放在同一台服务器 A：

```text
服务器 A
├── ginit CLI
├── agent
├── workspace
└── Paseo daemon
```

手机/Web 通过 relay 连接 A。

### 11.2 不推荐

```text
服务器 A：ginit CLI / agent
服务器 B：Paseo daemon
```

这会导致 B 默认看不到 A 上的：

- agent 进程；
- cwd；
- 项目文件；
- git 仓库；
- transcript；
- terminal；
- 实时 stdout。

ginit Hub 的 workspace snapshot 不是进程迁移协议，Paseo relay 也不是 ginit CLI 到 Paseo 的导入协议。

如果必须这样部署，需要额外增加：

- A 到 B 的安全远程导入 bridge；
- 短期 import token；
- 幂等 import API；
- transcript/metadata 上传；
- 文件系统映射；
- 实时 agent 控制协议。

这会比同机部署复杂很多，而且只能显示历史或通过额外 bridge 控制 A 上的 agent。

---

## 12. 无公网 IP、无法 SSH 的场景

没有公网地址不等于不能远程访问。

只要服务器 A 可以出站访问互联网：

```text
A → 阿里云 Paseo relay
手机/B → 阿里云 Paseo relay
```

即可建立反向连接。

不需要：

- SSH；
- 公网入站端口；
- 端口映射；
- 把 6767 暴露到公网。

可选替代方案：

- Cloudflare Tunnel；
- Tailscale/Headscale；
- FRP；
- 自建反向隧道；
- 公司内网出站网关。

优先使用 Paseo relay，因为它与 Paseo HostProfile 和 E2E 连接模型一致。

如果 A 完全不能出站访问：

```text
飞书登录只能解决身份问题，不能解决网络不可达问题。
```

此时必须提供：

- HTTP/SOCKS 代理；
- VPN；
- 内网网关；
- 能出站的 relay agent；
- 其他反向连接通道。

---

## 13. 安全边界

### 13.1 不传 Paseo password

飞书自动连接方案不应把 Paseo password 放到：

- ginit Hub device 列表；
- URL；
- relay metadata；
- HostProfile relay 字段；
- 日志；
- transcript。

relay 连接使用：

- relay endpoint；
- daemon public key；
- E2E handshake；
- 后续短期 connection token。

### 13.2 ginit token

当前早期实现会在 app 安全存储中保存 ginit user token，用于查询设备列表。正式生产建议增加：

```http
POST /api/paseo/devices/{device_id}/connect
```

返回短期、一次性 connection token，避免长期使用高权限用户 token。

### 13.3 设备隔离

ginit Hub 必须始终按照当前飞书 user_id 过滤：

```text
账号 A 只能看到账号 A 拥有的 Paseo devices
账号 B 不能看到账号 A 的设备
```

### 13.4 Relay 不做明文业务代理

ginit Hub 只做控制面，Paseo relay 负责数据面。不要把完整 Paseo session 明文转发逻辑塞进 ginit Hub。

## 13.5 架构修正基线（2026-07-28）

当前测试部署将多个独立角色放在同一台 testbed，但这些角色不能继续统称为“中继服务器”：

| 角色                        | 当前测试入口        | 目标生产入口                        | 是否产生 Paseo device |
| --------------------------- | ------------------- | ----------------------------------- | --------------------- |
| ginit Hub HTTP 控制面       | `150.5.173.43:8090` | `https://hub.example.com`           | 否                    |
| ginit Hub WebSocket         | `150.5.173.43:8235` | `wss://hub.example.com/ws/v1/paseo` | 否                    |
| Paseo relay 数据面          | `150.5.173.43:8234` | `wss://relay.example.com/ws`        | 否                    |
| Paseo Web client            | `150.5.173.43:8236` | `https://app.example.com`           | **否**                |
| ginit CLI 同机 Paseo daemon | A 端本机            | daemon 主动出站连接 Hub/relay       | **是**                |

必须遵守以下边界：

1. Web client 只是 C 端，不得因为托管 Web UI 而 enroll 成一台空 daemon；设备列表只包含真正运行 agent/workspace 的 A 端 daemon。
2. Hub HTTP、Hub WebSocket 和 relay 是三个协议角色。它们可以同机部署，但必须使用明确的域名和路径，不能依靠“8234/8235 是什么”的隐含约定。
3. 公网控制面必须使用 HTTPS/WSS。当前裸 IP HTTP/WS 仅为临时测试入口，不是可上线架构。
4. enrollment 只建立账号与设备身份绑定；relay endpoint、TLS 和在线状态属于运行时 metadata，应在签名 hello/metadata 更新中刷新。
5. app 不得无条件接受 Hub 返回的新 daemon public key。首次连接应建立 TOFU 信任，后续 key 变化必须显式重新配对或确认轮换。
6. 环境地址必须由运行期配置或服务端下发，不能硬编码在 App bundle，也不能由独立端口环境变量隐式推导。

### 13.6 分阶段迁移顺序

为避免同时破坏旧 daemon、旧 Hub 和现有测试部署，修正顺序固定为：

1. 先统一 HTTPS/WSS endpoint 契约并提供旧配置兼容；
2. 再把 relay metadata 从 enrollment 迁移到签名 hello/heartbeat 更新；
3. 再增加 public key fingerprint、TOFU 和 key rotation；
4. 再将 8236 迁移为 client-only Web，移除空 daemon device；
5. 最后把 relay 公网入口统一到 WSS 443，并下线裸 IP 8234。

每个协议新增字段都必须 optional，并用 `COMPAT(...)` 标记旧协议兼容代码及删除时间。

### 13.7 Web 宿主即设备的拆除（2026-07-28 已完成代码侧）

第 13.6 节第 4 步已在代码侧落地。paseo-web（8234 容器 / B 的 8236）不再 enroll 成 hub device，改成「匿名/只读 hub 会话」：

```text
[旧架构]  paseo-web ──(enroll 作为 Device)──> Hub
[新架构]  paseo-web ──(仅提供静态网页 & JS Bundle)──> 浏览器
                                                    │
                                            (以 User Token 身份/只读)
                                                    ▼
                                                   Hub (只列出真正 Device)
```

代码改动：

1. **协议**：`hub.login_ginit.request` 新增 optional `cacheOnly`（`COMPAT(hubLoginGinitCacheOnly)`，v0.2.0-beta.5）。`cacheOnly: true` 时 daemon 只缓存账号 token，**不 enroll 设备**；新增 `hub.account_token.request/response`（只读账号 token 移交）。
2. **Server**：`GinitHubEnroller` 新增 `cacheAccountToken()`（只写 `ginitBaseUrl`/`ginitToken`，绝不写 `enabled`/`deviceId`/`token`/`url`，HubConnector 保持离线）与 `accountToken()`（只读移交，不要求 enrolled）。
3. **App Welcome 页**（`ginit-feishu-welcome.tsx`）：飞书登录后改为 `hubLoginGinit(..., { cacheOnly: true })` 只缓存账号 token，再用 User Token 直接 `GET /api/paseo/devices` 列设备（CORS 受限时回退 daemon 代理），并显示只读设备列表。**不再调用 enroll**。
4. **App Host 设置页**（`host-page.tsx`）：宿主未 enrolled 但持有账号 token 时渲染只读提示「This web host is read-only — it is not enrolled as a device.」+ 设备列表；`isSelf` 标注只在宿主真正 enrolled 时才显示。
5. **部署**：8234 容器的 `daemon.hub` 已剥掉 `enabled/url/deviceId/token`，只留 `ginitBaseUrl`/`ginitToken`（供只读代理）。重启后日志 `Hub not configured; connector idle until enrollment`，不再作为 device 上线。
6. **脚本**：删除一次性 enroll 脚本 `scripts/ginit-enroll.mjs`、`ginit-enroll-direct.mjs`、`_enroll-bare-ip.mjs`。

8236 这类只托管静态 Web client 的部署还必须设置 `PASEO_WEB_UI_CLIENT_ONLY=true`。
该模式不会向 HTML 注入 `__PASEO_INITIAL_DAEMON_CONNECTION__`，避免浏览器把
静态站点自身误当成 Paseo daemon 后永久显示 `Connecting`。真正托管 daemon Web UI
的实例保持默认值 `false`。

设备列表现在只包含真正跑了 ginit 被控端服务（enroll 过）的 daemon；paseo-web 宿主不再出现在列表里。

### 13.8 运行期 endpoint 配置、hello 中继元数据与 TOFU（2026-07-28 已完成代码侧）

第 13.6 节第 1–3 步已在代码侧落地：

1. **运行期 endpoint（阶段 1）**：daemon 新增 `PASEO_GINIT_BASE_URL` / `PASEO_GINIT_HUB_WS_URL` 环境变量（env → persisted `daemon.hub`），web-ui 把 `window.__PASEO_GINIT_CONFIG__` 注入 index.html，app 经 `getGinitBaseUrl()` 运行期读取，**删掉了 app 里的 `http://150.5.173.43:8090` 硬编码**。`GINIT_PASEO_HUB_WS_PORT` 端口推导降级为 `COMPAT(ginitHubWsPortEnv)`（2027-01-28 移除），`PASEO_GINIT_HUB_WS_URL` 优先级最高。
2. **hello 中继元数据（阶段 2）**：daemon 的 `hub.hello` 现在携带 `relay {endpoint,use_tls}`（来自运行期 `relayPublicEndpoint`/`useTls`，`HubConnector.relayMetadataProvider`）；ginit gateway 在验签后的 hello 上原子刷新 `paseo_devices.relay_endpoint/relay_use_tls`（缺字段保留旧值，老 daemon 不发 relay 块不受影响）。enrollment 回归「只绑身份」，`PATCH /api/paseo/devices/{id}` 标记 `COMPAT(paseoDeviceRelayPatch)`（2027-01-28 移除）。
3. **TOFU 公钥固定（阶段 3）**：`RelayHostConnection` 新增 `trustedKeyFingerprint`（NaCl hash 对原始 32 字节公钥的 16-hex 分组指纹）。`upsertRelayConnection` 首次插入时固定指纹；同一 host 后续出现不同指纹直接抛「Daemon key changed … Re-pair」，**不再静默覆盖被信任的 key**。Hub/offers 不再是无条件信任的公钥传输。

对应提交：Paseo `cae8d51a9`（hello 中继元数据）、`e1b99e61f`（TOFU）；ginit `4ff8a35`（gateway 应用 hello relay metadata）。

### 13.9 Relay 公网入口收敛（阶段 5 部署待定）

代码侧已就位：daemon 默认 relay endpoint 为 `relay.paseo.sh:443` + `useTls`（`DEFAULT_RELAY_ENDPOINT`），hello 上报用 `relayPublicEndpoint`/`publicUseTls`。剩余是**纯部署动作**，不改代码：

1. 给 B 的 `/opt/paseo-relay` 套 Caddy：`wss://relay.example.com/ws` → `127.0.0.1:8234`（TLS 在 Caddy 终止，Node relay 保持明文 WS 不变）。
2. A 端 `daemon.relay` 的 `publicEndpoint` 指到 `relay.example.com:443` + `publicUseTls=true`，经阶段 2 的 hello 自动下发给所有 C 端。
3. 验证 WSS 握手 + E2E 后，公网防火墙关掉 8234 裸端口（只留 443）；内网可保留作健康检查。
4. Hub 控制面同理：`https://hub.example.com` → 8090（HTTP）与 8235（WS）都只在 loopback，飞书回调挪回 443 域名。

当前生产 relay 仍用托管 `relay.paseo.sh:443`；自托管 relay 的 443/WSS 化在 testbed 验证后按上面步骤推进。

剩余部署动作：把含新 bundle/server 的镜像同步到 B（8236 paseo-web）并同样剥掉其 `daemon.hub` 设备身份。

---

## 14. 当前遗留事项

当前已经完成：

- ginit Paseo 自动安装命令；
- ginit `up` 集成本机 Paseo；
- Claude Stop hook 自动导入；
- ginit Hub relay metadata migration；
- ginit 设备列表返回 relay metadata；
- Welcome 页飞书登录入口；
- 设备列表展示；
- relay HostProfile 自动构造基础代码；
- ginit Hub 单测；
- ginit CLI Go 测试；
- Paseo typecheck/lint/format。

当前还需要继续完成：

1. 在生产 ginit 数据库执行 `0020_paseo_relay_metadata.sql`；
2. 将阿里云公网 relay 正式部署并配置 endpoint；
3. 确认每台 Paseo daemon enrollment 时上报正确 relay endpoint；
4. Web 端处理 ginit API CORS 或 OAuth redirect；
5. 使用 Playwright 完成真实飞书授权测试；
6. 使用 Playwright 完成多设备列表测试；
7. 验证点击主机后真实 relay E2E 连接；
8. 验证旧设备没有 relay metadata 时的升级提示；
9. 增加 token 过期和 logout；
10. 增加短期 connection token API；
11. 连接成功后自动路由到正确主机的完整验证；
12. 生产环境部署后再验证公网 relay、无公网 IP 服务器和手机端。

当前不能声称已经完全实现：

```text
仅飞书登录 → 所有主机已经自动可用
```

准确状态是：

```text
飞书登录 → 设备列表 → connection-ready 主机可自动构造 relay 连接
```

完整生产闭环还依赖阿里云 relay、ginit 生产迁移、Web CORS/OAuth 和真实 E2E 验证。

---

## 15. 常用命令

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

### 当前本机 Web 地址

```text
http://127.0.0.1:8234
```

### 当前局域网地址

```text
http://192.168.3.2:8234
```

### 远程客户端地址

```text
https://app.paseo.sh
```

---

## 16. 一句话总结

```text
旧版 Paseo：扫码配对单台主机。

新版 Paseo：ginit 在 CLI 所在服务器同机自动部署 Paseo daemon，daemon 主动连接 ginit Hub 和阿里云 relay；手机通过飞书登录发现当前账号下的 Paseo 主机，选择在线主机后通过 relay 自动连接，不再手动填写 host、port 或 Paseo password。
```
