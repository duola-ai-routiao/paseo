# Ginit + Paseo 系统设计文档

> 版本：2026-07-29 · 状态：六项架构修正已落地（代码侧）
> 相关文档：[ginit-paseo-complete-architecture.md](ginit-paseo-complete-architecture.md)（部署/操作向）、[architecture.md](architecture.md)、[SECURITY.md](../SECURITY.md)

## 1. 一句话概括

**ginit CLI 在哪台机器跑，Paseo daemon 就在哪台机器跑；daemon 主动出站把「我存在、我有哪些会话」注册到 ginit Hub；手机/网页用飞书账号登录 Hub 发现自己的主机，经 Paseo relay 端到端加密连上去。** 用户全程只需一次飞书授权，不填 host、端口或密码。

## 2. 三个平面

系统严格拆成三个平面，这是全部设计决策的根基：

| 平面       | 承担者                 | 职责                                                               | 不做什么                               |
| ---------- | ---------------------- | ------------------------------------------------------------------ | -------------------------------------- |
| **控制面** | ginit Hub              | 飞书身份、设备归属、在线状态、workspace snapshot、relay 元数据下发 | 不转发 Paseo 业务数据、不当明文隧道    |
| **数据面** | Paseo relay            | 转发 E2E 加密的 agent RPC / terminal / 事件流                      | 无法读取内容（无密钥）、不承担身份授权 |
| **执行面** | A 端（ginit CLI 机器） | 跑 agent、持有代码和工作目录、跑 Paseo daemon                      | 不需要公网 IP、入站端口或 SSH          |

## 3. 角色与拓扑

```text
服务器 A（ginit CLI 所在机）                服务器 B（中继/hub 机）
├── ginit CLI / Claude agent              ├── ginit-server（Hub 控制面）
├── 项目代码、工作目录                      │   ├── HTTP API（8090 → 生产 443）
├── Paseo daemon                          │   └── Hub WS 网关（8235 → 生产 443）
│   ├── Stop hook 导入 CLI 会话             └── paseo-relay（数据面，8234 → 生产 443/WSS）
│   ├── HubConnector ──出站 wss──▶ Hub WS
│   └── relay client ──出站 wss──▶ relay
                                             ▲                    ▲
手机 / 浏览器（C 端）                          │                    │
└── 飞书登录 ──▶ Hub 拉设备列表 ──选主机 ──wss──┴──── relay ─────────┘
```

关键约束：

- **A 端零入站**：daemon 只做两条出站连接（Hub WS、relay WS），NAT/防火墙后也能用。
- **CLI、daemon、代码必须同机**：Paseo 管理的是本地进程和文件；跨机只同步数据会变成「只能看历史」。
- **B 是一台机器上的多个角色**，不是一个叫「中继」的黑盒：Hub HTTP、Hub WS、relay、（测试期的）Web 托管是四个独立服务，各有明确端口和协议。

## 4. 身份与设备模型

### 4.1 两个身份、两套设备公钥，不要混淆

| 身份                     | 凭证                                        | 用途                           |
| ------------------------ | ------------------------------------------- | ------------------------------ |
| **飞书用户**             | `ginit_` user token（device flow 授权获得） | 列自己账号下的设备、读账号 API |
| **Paseo 设备（daemon）** | `pht_` device token + Ed25519 设备密钥对    | daemon 连 Hub WS、上报状态     |

daemon 同时持有两套用途不可互换的公钥：

| 字段                                  | 编码/长度                                               | 用途                                        |
| ------------------------------------- | ------------------------------------------------------- | ------------------------------------------- |
| `public_key` / `publicKey`            | Ed25519 SubjectPublicKeyInfo DER，base64 解码后 44 字节 | Hub 身份认证，以及给运行时 Relay 元数据签名 |
| `relay_public_key` / `relayPublicKey` | NaCl/Curve25519 原始公钥，base64 解码后严格 32 字节     | Relay E2E 握手和客户端 TOFU 固定            |

Hub 身份公钥不能传给 Relay 客户端。两者虽然都来自 daemon，但密钥格式、算法职责和信任生命周期均不同。

### 4.2 设备注册（enrollment）——只绑身份

```text
飞书授权 → ginit user token
  → POST /api/paseo/enrollments        （拿一次性 ticket）
  → POST /api/paseo/enrollments/redeem （ticket + device_id + daemon_id + public_key）
  → pht_ device token，设备绑定到当前飞书账号（union_id）
```

enrollment **只发生一次**，建立「账号 ↔ 设备」归属。同一 device_id 重复 redeem 会被拒绝（`device_id already enrolled`），重复登录走「保留设备凭证、刷新账号 token」分支。

### 4.3 运行时状态——走签名 hello，不走 enrollment

设备上线、relay endpoint、TLS、workspace snapshot 都是**运行时状态**，每次连接由签名 `hub.hello`/`hub.workspace.snapshot` 上报：

```text
daemon → hub.hello { deviceId, daemonId, publicKey, nonce, signature,
                     relay { endpoint, use_tls, public_key, signature } }
hub    → hub.welcome { connectionId, heartbeatIntervalMs }
daemon → hub.workspace.snapshot { workspaces }
daemon → hub.heartbeat（周期保活）
```

外层 `signature` 证明 Hub 连接身份；Relay 块的独立 Ed25519 签名覆盖 canonical tuple
`["relay-v1", endpoint, use_tls, public_key]`，防止 endpoint、TLS 或 E2E 公钥被单独篡改。

这是 2026-07-29 修正的核心：**relay 元数据不再 enroll 时写死**。endpoint 改了，daemon 重连一次 hello 就原子刷新。老 daemon 不发 Relay 块时保留旧值；发送旧式无公钥/无签名 Relay 块时 Hub 忽略它，不允许它和数据库里已有的公钥拼成一组看似可用但未认证的连接信息。只有 `relay_endpoint` 与 `relay_public_key` 同时存在时 `connection_ready=true`。

### 4.4 设备隔离

Hub 的一切设备查询都按当前飞书 user_id 过滤：账号 A 只能看到账号 A 的设备。Web 宿主（paseo-web）**不是设备**——它只托管静态页面 + 用 `cacheOnly` 缓存账号 token 帮浏览器绕 CORS，从不出现在设备列表（2026-07-29 修正）。

## 5. 连接建立与密钥信任

### 5.1 relay E2E

C 端从 Hub 拿到设备的 `relay_endpoint + relay_public_key` 后：

1. C 端与 daemon 都主动连 relay 的同一个 serverId 会话；
2. C 端生成临时 Curve25519 密钥对，发 `e2ee_hello`；
3. 双方 ECDH 出共享密钥，之后全部流量 XSalsa20-Poly1305 加密；
4. relay 只见到密文、sessionId、时序——**relay 被攻破也读不到内容**。

### 5.2 TOFU：Hub 不是公钥的信任根

Hub 可以断言「某 device 的公钥是 X」，但 Hub（或能改库的人）也可能把公钥换成自己的做中间人。所以 C 端对 relay 公钥做 **TOFU（Trust On First Use）**：

- 首次连接某 host 时，计算公钥指纹（原始 32 字节的 NaCl hash，16-hex 分组显示）并固定在本地 HostProfile；
- 之后同一 host 出现**不同指纹直接拒绝**，提示「Daemon key changed … Re-pair」，绝不静默覆盖；
- 唯一的信任转移发生在用户显式重新配对时。

指纹格式示例：`a1b2-c3d4-e5f6-7890`。

### 5.3 凭证边界

- Paseo password **绝不**进入 Hub 设备列表、relay 元数据、URL 或日志；
- ginit user token 只用于账号 API，生产建议进一步换成短期一次性 connection token（`/api/paseo/devices/{id}/connect`，待做）；
- Hub 控制面必须 HTTPS/WSS——裸 IP 明文只允许一次性 demo（当前 testbed 属临时态，迁移步骤见 §7）。

## 6. 配置与环境

环境地址**不再硬编码进 bundle**，运行期解析优先级：

```text
PASEO_GINIT_BASE_URL / PASEO_GINIT_HUB_WS_URL  (env，最高优先)
  → persisted daemon.hub.ginitBaseUrl / url
  → 兜底 https://ginit.opensii.ai（仅 Metro dev）
```

daemon 的 web-ui 把 `window.__PASEO_GINIT_CONFIG__` 注入 index.html，浏览器端 `getGinitBaseUrl()` 读取。`GINIT_PASEO_HUB_WS_PORT` 端口推导已降级为 `COMPAT(ginitHubWsPortEnv)`（2027-01-28 移除）。

relay 端点同理：`daemon.relay.endpoint/publicEndpoint/useTls/publicUseTls`，经 hello 的 relay 块自动下发给所有 C 端。

## 7. 当前部署与生产迁移

### 7.1 testbed 现状（150.5.173.43，临时裸 IP）

| 端口 | 角色                                  |
| ---- | ------------------------------------- |
| 8090 | Hub HTTP API                          |
| 8235 | Hub WS 网关（+飞书 OAuth 回调，待拆） |
| 8234 | paseo-relay 数据面                    |
| 8236 | paseo-web 静态托管（C 端入口）        |

### 7.2 生产迁移步骤（纯部署，代码已就绪）

1. Caddy 终结 TLS：`wss://relay.example.com/ws` → `127.0.0.1:8234`；`https://hub.example.com` → 8090（HTTP）与 8235（WS 路径）；
2. 飞书回调从 8235 挪回 443 域名，并在飞书后台登记；
3. A 端 `daemon.relay.publicEndpoint=relay.example.com:443` + `publicUseTls=true`，hello 自动下发；
4. 验证后公网关掉 8090/8234/8235/8236 裸端口，只留 443；
5. staging 的飞书 SSO 应用 `cli_aacb827247389bde` **必须换成生产专用应用**（IM bot 应用独立，不可混用）。

## 8. 兼容与清理索引

所有向后兼容 shim 均可 `rg "COMPAT\("` 检索：

| 标记                             | 位置              | 移除目标                       |
| -------------------------------- | ----------------- | ------------------------------ |
| `COMPAT(hubLoginGinitCacheOnly)` | protocol messages | v0.2.0-beta.5 起，floor 达标后 |
| `COMPAT(ginitHubWsPortEnv)`      | ginit-enroller.ts | 2027-01-28                     |
| `COMPAT(paseoDeviceRelayPatch)`  | ginit server.py   | 2027-01-28                     |
| `COMPAT(relay-json-ping)`        | relay             | 2026-11-13                     |
| `COMPAT(oldRelayOfferTls)`       | host-runtime.ts   | 2026-11-10                     |

## 9. 已知限制与后续

1. **短期 connection token** 未实现：目前 C 端用长期 ginit user token 列设备，生产应加 `/connect` 一次性凭证；
2. **relay 会话内防重放**未实现（随机 nonce，无计数器，见 SECURITY.md）；
3. **CLI 会话可观测性**：daemon 或 Stop hook 失败时，活跃 CLI 会话会从 C 端「消失」且无告警；
4. `host-runtime.test.ts` 因 expo-constants `__DEV__` 基线导入失败（与本次修正无关），TOFU 由 daemon-fingerprint/host-connection 测试覆盖。
