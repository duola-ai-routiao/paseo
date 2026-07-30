# Ginit + Paseo 改造问题诊断与任务书

> 本文用于直接提供给大模型。请先完整理解系统边界、历史失败原因和目标架构，再检查代码并制定修改方案。不要只针对某一个报错做局部修补。

## 1. 任务目标

需要实现以下完整链路：

1. A 端运行 ginit CLI 和 Paseo daemon。
2. A 端 daemon 通过飞书账户完成设备注册，并持续向 Ginit Hub 上报在线状态、工作区摘要和 Relay 元数据。
3. B 端部署 Ginit Hub、Paseo Relay 和 Paseo Web。
4. C 端用户通过手机或浏览器访问 Paseo Web。
5. 用户只需登录飞书，即可看到同一飞书账户名下真正运行 ginit CLI 的远程 daemon。
6. 用户选择 daemon 后，通过 Relay 建立端到端加密连接。
7. Paseo Web 本身不应被注册成执行设备。
8. Hub 负责控制面，Relay 负责数据面，A 端 daemon 负责执行面。

目标链路如下：

```text
                         控制面
 A 端 Paseo daemon ─────────────────────> Ginit Hub
   │  ginit CLI                          │
   │  workspace                          │ 飞书账号与设备归属
   │  transcript                         │ 在线状态和 workspace snapshot
   │                                     │ relay endpoint 和设备公钥
   │
   │                     数据面
   └──────── Paseo Relay <──────── 浏览器 / Paseo Web
              E2EE                    飞书用户登录
                                       查询设备列表
                                       选择并连接设备
```

## 2. 必须遵守的系统边界

### 2.1 A 端 Paseo daemon

A 端 daemon 必须和 ginit CLI、工作目录、agent 进程及 transcript 位于同一台机器。

它负责：

- 作为真正的执行设备注册到 Ginit Hub。
- 保存设备身份，包括 `deviceId`、设备 token 和设备私钥。
- 通过签名的 `hub.hello` 上报在线状态和 Relay 元数据。
- 上报 workspace snapshot。
- 主动连接 Relay。
- 接收浏览器经 Relay 转发的加密 RPC。

Ginit Hub 不会自动把 A 端的进程、cwd、文件或 transcript 搬到 B 端。

### 2.2 Ginit Hub

Ginit Hub 是控制面，负责：

- 飞书 OAuth 或 device flow。
- 将飞书用户身份与 daemon 设备绑定。
- 保存设备记录、公钥和必要的发现信息。
- 保存设备在线状态及 workspace snapshot。
- 向已登录用户返回其账号下的设备列表。
- 校验 daemon 发来的签名和设备 token。

Ginit Hub 不负责转发完整的 daemon RPC 数据流，不应替代 Relay。

### 2.3 Paseo Relay

Relay 是数据面，只负责：

- 接受 daemon 主动建立的出站 WebSocket 连接。
- 接受浏览器建立的 WebSocket 连接。
- 按设备或 session 路由加密数据。
- 保持端到端加密，不读取 RPC 明文。

Relay 不是网页服务，也不是设备注册服务。浏览器用普通 HTTP 打开 Relay 根路径返回 `426 Upgrade Required` 属于正常行为。

### 2.4 Paseo Web

Paseo Web 只负责提供静态网页和浏览器应用。

它必须：

- 允许用户通过飞书登录。
- 以飞书用户 token 查询账号下的设备。
- 显示真正的远程 daemon。
- 通过 Relay 连接用户选择的 daemon。

它不得因为用户登录而把承载网页的 B 端 daemon 自动 enroll 成设备。

## 3. 两类身份必须严格分离

### 3.1 用户身份

用户身份来自飞书登录，对应 Ginit 用户 token。

用途：

- 查询当前飞书账号名下的设备。
- 获取设备的在线状态、Relay endpoint 和公钥。

用户 token 不代表某台 daemon 的设备身份。

### 3.2 设备身份

设备身份属于真正运行 CLI 的 daemon，包括：

- `deviceId`
- 设备 token，例如 `pht_*`
- Ed25519 私钥与公钥
- 设备名称和 server ID

用途：

- daemon 连接 Hub。
- 签名 `hub.hello`。
- 上报 workspace snapshot。
- 建立 Relay control connection。

Paseo Web 的飞书登录应采用只缓存用户 token的模式，例如 `cacheOnly`，不能顺带生成设备身份。

## 4. 为什么以前反复失败

长期失败并非单一 Bug，而是以下问题叠加造成的。

### 4.1 控制面、数据面和执行面混淆

历史上曾经：

- 把 Relay 的 8234 端口当成可以直接访问的网页。
- 认为 daemon 应向 Relay 注册飞书账号和设备。
- 把部署 Web 的空 daemon 注册成设备。
- 误以为 Hub 能自动迁移 CLI 进程和工作目录。

这些误解导致某一段 WebSocket 或 API 成功时，被错误地当作整个端到端链路成功。

### 4.2 “Web 宿主是否是设备”的设计反复变化

系统先让 `paseo-web` enroll，后来发现它会产生没有 CLI 和 workspace 的空设备，于是又删除其设备身份。清理过程中还曾误删真正 A 端 daemon 的 enroll 身份，最终不得不重新签发设备 token。

正确结论是：

- A 端 daemon 是设备。
- Paseo Web 不是设备。
- Web 仅持有用户身份并查询设备。

### 4.3 地址、端口和协议混乱

历史环境中出现过：

- `ginit.opensii.ai`
- `staging.ginit.opensii.ai`
- `150.5.173.43:8090`：Hub HTTP API
- `150.5.173.43:8091`：旧 Hub WS
- `150.5.173.43:8235`：测试环境 Hub WS 和飞书回调
- `150.5.173.43:8234`：Relay
- `150.5.173.43:8236`：Paseo Web
- A 端本机 `8234`：另一套 Paseo daemon/Web UI

同时混用 `http/https`、`ws/wss`、域名、裸 IP、容器端口和宿主机端口，导致大量请求打到错误服务。

代码中还曾硬编码 staging 域名或测试 IP。修改源码后，旧 Docker 镜像和旧 Web bundle 仍可能继续使用旧地址。

### 4.4 用户登录与设备 enroll 没有分开

历史实现中，用户为了查询设备而登录飞书，却会把当前 Web 宿主 enroll 成设备。重复登录又可能触发：

```text
device_id already enrolled
```

应当将以下操作分开并保证幂等：

- 用户登录和 token 缓存。
- 新设备 enrollment。
- 已有设备 token 刷新。
- Relay metadata 更新。
- 设备撤销。

### 4.5 状态散落且缺少稳定状态机

状态分散在：

- 浏览器 localStorage
- daemon `config.json`
- Hub 数据库
- 设备 token hash
- Relay session
- Docker volume
- Web 静态 bundle

历史问题包括：

- daemon 本地设备 token 被删除，但 Hub 只保存 hash，无法还原。
- 老设备缺少 Relay metadata，始终 `connection_ready=false`。
- revoked 或幽灵设备仍被列表返回。
- `config.json` 被截断成空文件。
- 容器 UID 改变导致配置文件无权限读取。
- 公钥发生变化时缺少明确的重新配对流程。

### 4.6 浏览器启动流程存在循环依赖

为了绕过 CORS，飞书登录通过当前页面的 daemon RPC 代理。但 daemon 又有密码保护，导致干净浏览器出现：

```text
飞书登录需要 daemon client
→ daemon client 需要密码
→ 页面没有密码入口
→ daemon client 为 null
→ 飞书登录组件不显示或报 Password required
```

当前修正方向是：

- 识别 `Password required`。
- 显示密码输入框。
- 带密码重新探测 daemon。
- 持久化 host 连接信息。
- 优先复用当前页面已经连接的 client。

需要进一步评估：Paseo Web 的用户登录是否应继续依赖其承载 daemon，还是应通过同源后端代理提供一个不要求设备连接的登录通道。

### 4.7 源码、构建产物和实际部署版本不一致

历史上多次出现：

- 源码已修改，但没有重新构建 Web UI。
- Web UI 已构建，但 Docker 镜像未重建。
- A 端镜像是新的，B 端仍运行旧镜像。
- 新环境变量已配置，但静态 bundle 仍有旧硬编码。
- npm 安装、文件权限或 UID 问题导致镜像内容不完整。

因此必须把“部署版本一致性”纳入验收，不能只看源代码和单元测试。

## 5. 当前已完成的主要修正

截至现有总结，已经完成或基本完成：

1. Paseo Web 登录采用 `cacheOnly`，用户 token 与设备身份分离。
2. Web 宿主不再默认 enroll 成执行设备。
3. 设备列表只显示真正 daemon，并过滤 revoked 设备。
4. Relay metadata 改由签名 `hub.hello` 动态上报。
5. Ginit endpoint 改为运行期环境变量：
   - `PASEO_GINIT_BASE_URL`
   - `PASEO_GINIT_HUB_WS_URL`
6. Web UI 通过 `window.__PASEO_GINIT_CONFIG__` 获取运行期配置。
7. Relay 连接增加 TOFU 公钥指纹验证。
8. A 端 daemon 已恢复有效的设备身份。
9. Hub 能看到 A 端 daemon online、`connection_ready=true`。
10. Relay E2EE 已通过 RPC 验证。
11. 8236 Welcome 页已补回 daemon 密码输入流程。

但不能仅根据这些局部结果宣称生产链路已经全部完成。

## 6. 当前测试环境

测试服务器：

```text
150.5.173.43
```

当前端口语义：

| 地址                                       | 作用                         |
| ------------------------------------------ | ---------------------------- |
| `http://150.5.173.43:8090`                 | Ginit Hub HTTP API           |
| `ws://150.5.173.43:8235/ws/v1/paseo`       | 测试环境 Ginit Hub WebSocket |
| `http://150.5.173.43:8235/auth/feishu/...` | 测试阶段飞书登录及回调       |
| `ws://150.5.173.43:8234`                   | Paseo Relay                  |
| `http://150.5.173.43:8236`                 | Paseo Web                    |

测试阶段使用裸 IP 和非 TLS 端口。生产环境最终应收敛到域名、443、HTTPS/WSS。

飞书测试应用是临时测试配置，上线生产必须更换为生产专用应用；SSO 应用与 IM Bot 应用应保持独立。

## 7. 要求大模型执行的工作

请基于实际代码和部署配置完成以下工作，不要假设总结中的实现一定完全正确。

### 第一阶段：建立真实现状

1. 阅读 Paseo 与 Ginit 相关实现。
2. 找出所有 Hub、Relay、Web、daemon 和飞书登录入口。
3. 搜索所有硬编码的域名、IP、端口、`http/ws/https/wss`。
4. 梳理用户 token、设备 token、device ID、设备密钥的生成、保存、刷新和撤销路径。
5. 检查实际运行的 Docker 镜像、Web bundle 和代码 commit 是否一致。
6. 输出当前真实拓扑和状态机，不得只复述本文。

### 第二阶段：检查架构边界

重点确认：

- Paseo Web 是否仍可能被 enroll 成设备。
- 用户登录是否会修改 daemon 的设备身份。
- A 端 daemon 是否能独立重启并恢复 Hub 和 Relay 连接。
- Hub 是否只承担控制面。
- Relay 是否只承担数据转发。
- workspace 和 transcript 是否始终来自 A 端 daemon。
- revoked 设备是否会从正常设备列表中消失。
- Relay metadata 是否以 heartbeat/hello 为准，而不是依赖一次性 enrollment。

### 第三阶段：修复配置系统

要求：

- 不在 bundle 中硬编码测试 IP 或 staging 域名。
- HTTP API、Hub WS、Relay、Web 和 OAuth callback 分别配置。
- 明确区分容器内部地址与外部访问地址。
- 环境变量缺失时应明确报错，避免静默回退到错误的生产或 staging 地址。
- 页面应能显示当前使用的 endpoint，便于诊断。

### 第四阶段：修复登录与连接状态机

应明确实现并测试：

```text
未登录用户
→ 飞书授权
→ 获得用户 token
→ 查询设备列表
→ 选择在线且 connection_ready 的设备
→ 校验或首次信任设备公钥
→ 经 Relay 建立 E2EE 连接
→ 获取 workspace
```

设备端状态机应为：

```text
未 enroll daemon
→ 飞书授权绑定设备
→ 保存 deviceId、设备 token、密钥
→ 连接 Hub
→ 签名 hello
→ Hub 标记 online 并更新 Relay metadata
→ daemon 连接 Relay
→ 可被浏览器发现和连接
```

所有步骤必须考虑：

- 重复执行。
- 网络中断。
- daemon 重启。
- token 过期。-设备被撤销。
- 公钥改变。
- Relay endpoint 改变。
- Hub 和 Relay暂时不可用。

### 第五阶段：部署与端到端验证

不能只跑单测。必须从干净状态验证：

1. 清理浏览器 localStorage 后打开 8236。
2. 页面能够明确引导完成必要的 Web daemon 密码验证。
3. 点击飞书登录。
4. 完成真实飞书授权。
5. 登录后仅看到真实 A 端 daemon，不出现 Web 空设备。
6. 设备状态为 online、`connection_ready=true`。
7. 浏览器选择 A 端设备。
8. 第一次连接记录 TOFU 公钥指纹。
9. 经 Relay 建立 E2EE 连接。
10. 浏览器读取 A 端真实 workspace。
11. 启动一个新的 ginit CLI 会话。
12. 新会话或 workspace 自动出现在远程页面。
13. 重启 A 端 daemon 后能够自动恢复。
14. 重启 Hub、Relay 和 Web 后链路仍能恢复。
15. 修改设备公钥后，客户端必须拒绝静默连接并要求重新信任。
16. 撤销设备后，设备不能继续连接，也不能继续作为正常设备显示。

## 8. 验收标准

只有同时满足以下条件，才可以宣称改造成功：

- 飞书用户身份和 daemon 设备身份完全分离。
- Web 宿主不会因为飞书登录而成为设备。
- 设备列表只包含账号名下未撤销的真实 daemon。
- A 端 daemon 重启后自动恢复 Hub 与 Relay 连接。
- Hub、Relay、Web、daemon 的职责和端口清晰且没有交叉误用。
- 所有 endpoint 都由运行期配置决定。
- 运行中的 bundle 不包含不应存在的硬编码测试或 staging 地址。
- 浏览器从干净状态能够完成登录、发现设备和连接。
- Relay 连接使用端到端加密。
- 设备公钥通过 TOFU 或更强机制验证。
- 浏览器实际读取到 A 端 workspace，而不是 B 端空 daemon 的数据。
- 重复登录、重复 enroll、网络重连和服务重启不会制造幽灵设备。
- 单元测试、类型检查、lint、协议兼容测试和真实端到端测试全部通过。

## 9. 实施原则

请遵守以下原则：

1. 先画出现状，再修改代码。
2. 先固定身份模型和状态机，再修 UI。
3. 每个修复都说明影响的是控制面、数据面还是执行面。
4. 不以“某个接口返回 200”代替端到端成功。
5. 不以“源码已修改”代替“部署已生效”。
6. 不通过手工修改数据库掩盖协议缺陷，除非是明确的一次性数据迁移。
7. 不清除未知设备或 token，除非先确认其归属并提供恢复方案。
8. 保持兼容字段时标注 `COMPAT` 和清理条件。
9. 所有关键状态变化必须有可诊断日志，但不得输出明文 token、密码或私钥。
10. 测试环境跑通后，再制定域名、TLS、WSS 和 443 的生产迁移方案。

## 10. 期望输出格式

请按以下结构输出并执行：

1. **现状审计**：代码版本、部署版本、拓扑、配置和状态。
2. **问题清单**：按 P0/P1/P2 排序，每项给出证据。
3. **根因分析**：区分架构问题、实现问题、配置问题和部署问题。
4. **修改方案**：列出涉及文件、协议和迁移风险。
5. **实施结果**：说明实际修改，不只给建议。
6. **测试证据**：单测、集成测试、真实浏览器和 Relay E2E。
7. **剩余风险**：明确未完成事项，不得过度宣称。
8. **回滚方案**：说明配置、数据库和部署如何恢复。

最终目标不是让某个按钮显示出来，而是让下面这条链路在干净环境、服务重启和重复登录后仍然稳定成立：

```text
ginit CLI
→ A 端真实 daemon
→ Ginit Hub 绑定飞书账号并发布设备状态
→ 浏览器飞书登录发现设备
→ Relay E2EE 连接 A 端 daemon
→ 查看和控制真实 workspace
```
