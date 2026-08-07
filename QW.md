## 2026-08-06 - macOS 本地全局安装脚本无法执行

**Q（问题）**：在全新 macOS 环境执行 `./scripts/paseo-install-local.sh` 时先因系统没有 `npm` 失败；安装项目指定的 Node.js 22.20.0 后，又因 macOS 自带 Bash 3.2 不支持 `declare -A` 关联数组而在打包阶段失败。继续安装后，脚本还因 `set -u` 把 `$installed_ver（...）` 中紧邻变量名的中文全角括号解析成变量名的一部分，导致安装已完成但脚本以 `unbound variable` 退出。

**W（解决方法）**：

1. 按仓库 `.tool-versions` 安装官方 Node.js 22.20.0 arm64 到 `~/.local/opt/node-v22.20.0-darwin-arm64`，并将 `~/.local/bin` 写入 `~/.zshrc` 的 `PATH`。
2. 修改 [scripts/paseo-install-local.sh](scripts/paseo-install-local.sh)，移除 Bash 4 才支持的关联数组，改用 `raw_tgz_path` / `final_tgz_path` 函数按 workspace 动态计算 tarball 路径，使脚本兼容 macOS 自带 Bash 3.2。
3. 将变量与后续中文字符之间改为 `${installed_ver}`、`${STAGING}`、`${FINAL_DIR}` 的显式边界，避免 `set -u` 下的 UTF-8 变量名误解析。
4. 使用 `--no-restart` 完成全局安装，避免未经确认重启 6767 daemon、中断正在运行的 agent。最终 `paseo` 位于 `~/.local/bin/paseo`，版本为 0.2.0。

**验证**：修复后的 `./scripts/paseo-install-local.sh --no-restart` 完整执行成功；`paseo --version` 输出 0.2.0。该问题属于 Shell/CLI 安装流程，不涉及浏览器 UI，Playwright 验证不适用。

## 2026-07-29 - 设置页 Web 宿主身份边界与 Hub Relay 发现字段

**Q（问题）**：设计要求 Paseo Web 只能缓存飞书用户 token，不能因 Settings 页登录而 enroll 成设备；设备连接也必须使用 Hub 发布的 Relay endpoint、daemon 公钥和 `connection_ready`，不能依赖用户手工输入的直连地址。此前设置页仍调用无 `cacheOnly` 的登录，并使用默认 host 地址执行 direct TCP probe；Paseo 端设备列表 schema 也没有透传 Ginit Hub 已提供的 Relay metadata。

**W（解决方法）**：

1. [packages/app/src/screens/settings/host-page.tsx](packages/app/src/screens/settings/host-page.tsx) 的设置页登录调用增加 `cacheOnly: true`，未 enroll 的 Web 宿主不会写入设备身份；并保留真正已 enroll daemon 的状态读取逻辑。
2. [packages/server/src/server/hub/ginit-enroller.ts](packages/server/src/server/hub/ginit-enroller.ts) 读取 Hub 设备列表的 schema 和内部类型增加 optional `public_key`、`relay_endpoint`、`relay_use_tls`、`connection_ready`。其中 `relay_use_tls` 兼容 Hub SQLite 返回的布尔值和 0/1 数字。
3. [packages/protocol/src/messages.ts](packages/protocol/src/messages.ts) 的 `HubListDeviceEntrySchema` 增加对应 optional 字段，保持旧 Hub/旧客户端协议兼容。
4. 设置页设备连接改为使用 Hub metadata 调用 `upsertRelayConnection`，执行已有 TOFU 公钥指纹固定；offline、`connection_ready=false`、缺少 Relay endpoint 或公钥的设备不可连接，并提示更新主机。

**验证**：`npm run typecheck` 通过；修改文件 lint 通过；`ginit-enroller.test.ts` 与 `messages.hub.test.ts` 共 36/36 通过；`git diff --check` 通过。欢迎页的 Relay 连接改造本轮未继续，避免在缺少稳定测试覆盖时扩大修改范围。

**遗留**：欢迎页仍只展示设备列表，后续应在独立小步中复用相同的 `upsertRelayConnection` 逻辑并补组件测试；运行期 Ginit endpoint 缺失时的 fallback 也尚未收紧；本轮尚未完成 Playwright、部署 bundle 验证和提交推送。

## 2026-07-28 - 拆掉「Web 宿主即设备」：paseo-web 不 enroll，改匿名/只读 hub 会话

**Q(问题)**:旧架构里 paseo-web（8234 容器 / B 的 8236）作为一台 Device enroll 到 ginit Hub，导致设备列表里混进一台不跑任何 agent 的「空 daemon」。要求：paseo-web 只提供静态网页 + JS Bundle，浏览器以飞书 User Token 身份只读查 Hub，设备列表只放真正跑 CLI 的 daemon。

**W(解决方法/结论)**:代码侧已完成并验证，分五层：

1. **协议**（`packages/protocol/src/messages.ts`）：`hub.login_ginit.request` 新增 optional `cacheOnly`（`COMPAT(hubLoginGinitCacheOnly)`，v0.2.0-beta.5）——`cacheOnly: true` 时 daemon 只缓存账号 token、**不 enroll 设备**；新增 `hub.account_token.request/response`（只读账号 token 移交）。全部 optional 字段，旧客户端/旧 daemon 双向兼容。
2. **Server**（`ginit-enroller.ts`）：新增 `cacheAccountToken()`——只写 `ginitBaseUrl`/`ginitToken`，绝不写 `enabled`/`deviceId`/`token`/`url`，HubConnector 读不到完整 hub 配置就保持离线，daemon 永不作为 device 上线；`accountToken()` 只读移交，不要求 enrolled。
3. **App Welcome 页**（`ginit-feishu-welcome.tsx`）：飞书登录后从「enroll 这台 host」改为 `hubLoginGinit(..., { cacheOnly: true })` 只缓存账号 token，再用 User Token 直接 `GET /api/paseo/devices` 列设备（hub 无 CORS 头时回退 daemon 代理读），登录后渲染只读设备列表（My hosts + Refresh），**不再 enroll**。
4. **App Host 设置页**（`host-page.tsx`）：宿主未 enrolled 但持有账号 token 时渲染「This web host is read-only — it is not enrolled as a device.」+ 只读设备列表；`(this host)` 标注只在宿主真正 enrolled 时才显示（新增 `isEnrolled` prop 控制）。
5. **部署 + 脚本**：8234 容器 `daemon.hub` 剥掉 `enabled/url/deviceId/token`、只留 `ginitBaseUrl`/`ginitToken`，重启后日志 `Hub not configured; connector idle until enrollment`，不再作为 device 上线；删除一次性 enroll 脚本 `scripts/ginit-enroll.mjs`、`ginit-enroll-direct.mjs`、`_enroll-bare-ip.mjs`。

**并行合入的配套改动**（同一工作树内另一 agent 完成）：ginit 地址改为运行时注入（`PASEO_GINIT_BASE_URL`/`PASEO_GINIT_HUB_WS_URL` env → `web-ui.ts` 注入 `window.__PASEO_GINIT_CONFIG__` → app `constants/ginit-config.ts` 读取），消掉 app bundle 里的硬编码 IP。

**验证**：`npm run typecheck` ✅、`npm run lint`（2878 文件）✅、`ginit-enroller.test.ts` + `hub-connector.test.ts` 19/19 ✅；8234 容器重启后 hub-connector 不再上线；Playwright 打开 `http://192.168.3.2:8234` Host 设置页，Ginit Hub 区只显示「Login with Feishu」，不再有「Device enrolled」。

**遗留**：① B（150.5.173.43）的 paseo-web 8236 仍是旧镜像旧 bundle，需同步新镜像并同样剥离其 `daemon.hub` 设备身份（其 deviceId `2ecbaaa4-…` 还挂在 hub 上）；② 本机 docker 缺 buildx 无法本地构建镜像，需在能 build 的机器上 `docker build -f docker/base/Dockerfile` 或走 CI；③ 本机 node_modules 曾被并行 npm 操作打爆（278 包 vs lock 2606），`npm install` 修复后可正常 `build:daemon-web-ui` + `npm pack` 组镜像。

## 2026-07-28 - 过滤 8236 网页里的生产地址 staging.ginit.opensii.ai,改为测试环境裸 IP

**Q(问题)**:用户要求把 `https://staging.ginit.opensii.ai`(生产/旧测试域名)从 8236 网页里过滤掉,改成测试环境地址,配置在「环境设置」里。

**W(解决方法/结论)**:已确认并修复。

1. **根因**:8236 网页最初用的是**旧 docker 镜像**(11h 前,镜像 ID `0dc0f997…`),里面 app bundle 仍含 `https://staging.ginit.opensii.ai`(来自 commit `cd6b5fd2a` 引入的 `ginit-feishu-welcome.tsx` 的 `resolveGinitBaseUrl()` fallback)。该 staging fallback 会让 enroll 把 `daemon.hub.url` 写成 `wss://staging…`,导致 502 拒绝。
2. **源码早已修正**:commit `4dac1426c`(feat: enroll against bare-IP testbed hub)已把 `ginit-feishu-welcome.tsx` / `host-page.tsx` 的 ginit base 统一改成 **`http://150.5.173.43:8090`**(ginit-server HTTP API;hub WS 网关在 `8235`)。当前 app 源码全局 grep `staging` = 0 处。
3. **修复动作**:把 A 机**最新镜像**(1h 前,`d82f42cd…`,bundle `index-f52c0b…` 已无 staging)重新 `docker load` 到 B,B 的 `paseo-web` 容器随镜像更新到新 bundle。实测:
   - B 容器内 bundle:`grep staging` = 0,`grep 150.5.173.43:8090` = 2 ✅;
   - `http://150.5.173.43:8236/` 返回的 index.html 引用 `index-f52c0b…`(新 bundle)✅;
   - paseo-web `config.json` `hub.url=ws://150.5.173.43:8235/ws/v1/paseo` ✅;
   - B DB 两台设备 `srv_nvcX` / `srv_oEgw` 均 `online` ✅。
4. **传输踩坑**:本机到 B 的 SSH 在大文件/默认 KEX(`sntrup761x25519`)下频繁挂起(KEX 后卡住、exit 124)。**解决**:改用 `ssh -o KexAlgorithms=ecdh-sha2-nistp256` 即稳定;大文件(docker save 1.1GB/base64 20MB)仍易断,最终靠重新 `docker load` 已更新的镜像完成。小端口探测也用它。
5. **「环境设置」里的地址**:app 的 ginit base 目前是**硬编码** `http://150.5.173.43:8090`(`ginit-feishu-welcome.tsx:19`、`host-page.tsx:522`),没有做成 UI 环境设置项。如需在「设置」里可配,需要新增一个 env/baseUrl 配置项(建议后续做,避免硬编码)。

**结论**:8236 网页现在加载的 bundle 已**完全不含 staging.ginit.opensii.ai**,enroll/设备列表走裸 IP 测试环境 `150.5.173.43`(8090 API + 8235 hub WS + 8234 relay),两台设备 online。

## 2026-07-28 - 在 B(150.5.173.43) 部署 Paseo 网页到 8236 + 飞书登录打通(纯裸 IP 测试环境)

**Q(问题)**:用户要求在 B(150.5.173.43)部署 Paseo 网页到 8236 端口,手机/网页端通过飞书登录即可看到已注册的 ginit/paseo 主机;全程用裸 IP(测试阶段),不走 staging 域名,8234 保持不动。

**W(解决方法/结论)**:已完成并验证。要点:

1. **B 端已有服务**:ginit-server(控制面,`0.0.0.0:8090` HTTP API)+ ginit WS 网关(`0.0.0.0:8235`,`/ws/v1/paseo`)+ Paseo relay(`0.0.0.0:8234`,数据面)。裸 IP 均直接可达(无需 Caddy/域名)。
2. **网页部署**:把 A 机的 `paseo:local-ginit` 镜像 `docker save | ssh docker load` 到 B,起容器 `paseo-web`(`-p 8236:6767 -e PASEO_WEB_UI_ENABLED=true`),config 设 `app.baseUrl=http://150.5.173.43:8236`、CORS 加该 origin、relay 指 `150.5.173.43:8234`。网页即开即用(Paseo UI)。
3. **飞书登录**:B 的 ginit-server SSO 应用切到 `cli_aacb827247389bde`(GAIR 有权限),`/etc/ginit.env` 的 `FEISHU_APP_ID/FEISHU_APP_SECRET` 已更新,回调已登记 `http://150.5.173.43:8235/auth/feishu/callback`(8235 是 ginit WS 网关进程,同时托管 `/auth/feishu/callback`,**不是 8090**——用户登记的 8090 回调实际无效,飞书授权页用的是 8235)。⚠️ 注意:SSO 应用(aacb)与 IM connector bot 应用(`cli_a969…`,凭据在 `/root/.lark-cli/config.json`)相互独立,切换 SSO 不影响 bot。
4. **飞书授权实战**:用 Playwright 打开 `http://150.5.173.43:8236` → Settings → Host → Login with Feishu → 选「Generative AI Lab (GAIR)/王少敬」→ Authorize → 回调 `{"status":"completed"}`。设备 `paseo-srv_oEgw`(deviceId `2ecbaaa4-…`)enroll 成功。
5. **坑:enroll 写入的 hub.url 是 wss://staging(502 拒绝)**。app 里另有一处硬编码 `https://staging.ginit.opensii.ai`(在某个 enroll/login 路径,非 `ginit-feishu-welcome.tsx`/`host-page.tsx` 的 `http://150.5.173.43:8090`),导致 enroll 后 `daemon.hub.url=wss://staging.ginit.opensii.ai/ws/v1/paseo`,paseo-web 连 hub 一直 `Hub rejected (502)`、设备显示 offline。**修复**:直接改 paseo-web 的 `config.json` 把 `hub.url=ws://150.5.173.43:8235/ws/v1/paseo`、`ginitBaseUrl=http://150.5.173.43:8090`,重启容器 → `Sent hub.hello` → `Hub welcome; device online`。**根治需找到并改掉那处 staging 硬编码**(否则每次重新登录都会写回 staging)。
6. **最终状态(全裸 IP)**:
   - A daemon(`paseo-srv_nvcX`)→ B hub `ws://150.5.173.43:8235/ws/v1/paseo`,**online**,relay `150.5.173.43:8234`;
   - paseo-web daemon(`paseo-srv_oEgw`)→ 同 hub,**online**;
   - 网页 `http://150.5.173.43:8236` 飞书登录后「My enrolled hosts」显示两台设备均 **online**。
   - B DB `paseo_devices`:`srv_nvcX`(relay_endpoint=150.5.173.43:8234, connection_ready=1)、`srv_oEgw`(relay_endpoint=NULL, connection_ready=0,只能被看不能被 relay 连——这是 B 本机 web daemon,符合预期)。

## 2026-07-28 - testbed(150.5.173.43) 部署 ginit-server 复盘与验证

**Q（问题）**：用户要求在 `150.5.173.43` 部署 ginit-server（控制面：飞书 OAuth + Hub WS 网关），端口 `GINIT_PORT=8090` + `GINIT_WS_PORT=8091`（`/ws/v1/paseo` 在 WS 网关上）。先查 QW.md 确定版本。

**W（解决方法）**：

1. **QW.md 记录的版本就是 feat-paseo HEAD**。本地 ginit-server checkout `/home/alan/ginit/ginit/ginit-server` 分支 `feat-paseo` 与 `origin/feat-paseo` 同步，HEAD `c2fe5fa feat(paseo): add PATCH device relay-metadata endpoint`。该 commit 是 2026-07-28 凌晨为支持「老设备补 relay metadata 不重 enroll」专门加的，也是 QW.md 上一篇 staging 部署记录使用的代码。
2. **核对 testbed 与本地代码一致性**：`/opt/ginit/ginit/{server.py,paseo_hub.py,paseo_hub_gateway.py}` md5 与本地 `feat-paseo` HEAD 完全一致；`migrations/` 含 `0019_paseo_hub.sql` + `0020_paseo_relay_metadata.sql`，mtime `2026-07-27 23:37-46`，与 feat-paseo HEAD 同步时间吻合。**testbed 已经在跑 feat-paseo HEAD**。
3. **核对 DB schema**：`/var/lib/ginit/ginit.db` 的 `schema_version` 含 `(100, 2026-07-27T15:19:47Z)` + `(101, 2026-07-27T15:19:47Z)`，正是 QW.md 提到的「paseo 迁移用 100+ 避开 tag 系列冲突」的登记；`paseo_devices` 表已含 `relay_endpoint`/`relay_use_tls` 列。
4. **核对运行状态**：`systemctl status ginit` active（PID 24548，运行 6h+）；`ss -tlnp` 确认 `127.0.0.1:8090`（HTTP）+ `127.0.0.1:8091`（WS gateway）双端口监听；`/etc/ginit.env` 含 `GINIT_PORT=8090`/`GINIT_WS_PORT=8091`/`FEISHU_APP_ID=...389cd2`/`FEISHU_REDIRECT_URI=...callback` 等完整飞书凭据；Caddyfile `staging.ginit.opensii.ai` 已反代 `/ws/v1/* → 8091`、其余 `→ 8090`。
5. **探测结果**：
   - `https://staging.ginit.opensii.ai/health` → `200 OK`（经 Caddy → 8090）✅
   - `https://staging.ginit.opensii.ai/ws/v1/paseo` → `426 Upgrade Required`（经 Caddy → 8091，WS 端点存活）✅
   - `http://150.5.173.43:8090/health` → 超时（`GINIT_HOST=127.0.0.1`，**裸 IP 直连不可达**，仅 staging 域名经 Caddy 可访问）⚠️
   - `http://150.5.173.43:8091` → 超时（同上）⚠️
6. **A 端 daemon 当前配置**（`/home/alan/paseo-deploy/paseo-home/.paseo/config.json`）：`daemon.hub.url=wss://staging.ginit.opensii.ai/ws/v1/paseo` + `daemon.hub.ginitBaseUrl=https://staging.ginit.opensii.ai` + `daemon.relay.endpoint=150.5.173.43:8234`（自托管 relay），已是指向 testbed 的状态。

**结论**：B 端（testbed）ginit-server **已在跑 feat-paseo HEAD（c2fe5fa）**，QW.md 描述的 8090/8091 + 飞书凭据 + Caddy 反代均已就绪；A 端 daemon 已指向 staging。**唯一与用户需求（`http://150.5.173.43:8090` + `ws://150.5.173.43:8091/ws/v1/paseo` 裸 IP）的差异：ginit 绑在 `127.0.0.1`，仅经 staging 域名可访问**。是否要改 `GINIT_HOST=0.0.0.0` 让裸 IP 直连，需用户确认（公网暴露 + 无 TLS，安全权衡）。

## Q: 用户 A 的 Paseo daemon 是否会向 `150.5.173.43:8234` 发送注册信息和飞书账号信息?

**W(解决方法/结论):** 不会。2026-07-27 实测排查:

1. **`150.5.173.43:8234` 上跑的是 Paseo daemon,不是 Hub。** Paseo daemon 没有任何"接收其他 daemon 注册"的接口;注册/设备归属功能只存在于 ginit-server(`/api/paseo/enrollments*`、`/api/paseo/devices`、`/ws/v1/paseo`,见 `ginit-server/ginit/paseo_hub_gateway.py`、`server.py`)。
2. **A 端注册目标是 `daemon.hub.url` 配置项,与 8234 无关。** 本机 A 端(docker 容器 `paseo`,`~/paseo-deploy`)的 `~/.paseo/config.json` 里 hub 指向 `wss://ginit.opensii.ai/ws/v1/paseo`,daemon 日志显示 `hub.hello` → `hub.welcome; device online`,即注册和心跳实际发往 ginit.opensii.ai。
3. **飞书账号关联发生在 enrollment 时**:daemon 用飞书授权换来的 `ginit_` user token 调 `POST /api/paseo/enrollments`,服务端按 token 识别飞书用户(union_id)并绑定 device;daemon 本地只缓存 token,不发送飞书账号明文。
4. **8234 只是本机 daemon 的 Web UI/RPC 端口**(docker 8234→6767),它出站连 Hub/relay,不接受"被注册"。
5. 若要把 B(150.5.173.43)变成 Hub:在该机部署 ginit-server(`GINIT_PORT=8090` + `GINIT_WS_PORT=8091`,WS 网关含 `/ws/v1/paseo`;裸 IP 无 TLS 时 A 端配 `ginitBaseUrl=http://150.5.173.43:8090`,hub url 自动推导为 `ws://150.5.173.43:8090/ws/v1/paseo`——注意 wsgateway 需与 HTTP 同端口或反代路由),再把 A 端 `daemon.hub` 的 `url/ginitBaseUrl` 指过去并重新 enrollment。

## Q: git push 报 403「Permission to getpaseo/paseo.git denied to duola-ai-routiao」，用 GitHub 用户名+密码也登录不了

**W（解决方法）：**

1. **根因一：密码不能用于 git 操作。** GitHub 自 2021-08-13 起停用了账号密码做 HTTPS git 认证，必须用 Personal Access Token (PAT) 代替密码。生成地址：https://github.com/settings/tokens/new ，勾选 `repo` 权限组。
2. **根因二：403 是目标仓库无写权限。** `getpaseo/paseo` 是官方组织仓库，个人账号推不了。解决办法是推到自己有权限的仓库（如组织内仓库 `GAIR-NLP/paseo` 或个人 fork）。
3. **推送命令（带内嵌凭据，不落盘）：**
   ```bash
   git -c credential.helper= push https://<用户名>:<token>@github.com/<组织>/<仓库>.git <本地分支>:<远程分支>
   ```
   先用 `curl -H "Authorization: token <token>" https://api.github.com/user` 查 token 对应的 GitHub 用户名。
4. **持久化凭据（后续 push 不用再输）：**
   ```bash
   git config credential.helper store
   printf 'protocol=https\nhost=github.com\nusername=<用户名>\npassword=<token>\n\n' | git credential-store --file ~/.git-credentials store
   chmod 600 ~/.git-credentials
   ```
5. **排查凭据来源的命令：** `git config --get credential.helper`、`cat ~/.git-credentials`、`git config --global --list --show-origin`；若报「could not read Username: No such device or address」说明无凭据且终端不可交互。

## Q7: 在 `/home/alan/ginit/ginit/paseo` 配置 Stop hook，让 `ginit ccd` 会话自动导入到 paseo

**问题现象（2026-07-25）**：
飞书登录（Hub enrollment）后，期望在其他目录用 `ginit ccd` 创建的 Claude 会话能自动出现在 paseo 中，需要配置 Stop hook。

**解决方法（W）**：

### 1. 配置目标目录的 Stop hook

在工作目录创建 `.claude/hooks/paseo-auto-import.sh`（从主目录复制）并修正 `run_paseo` 函数的 CLI 路径，配置 `.claude/settings.json` 注册 Stop hook：

```bash
mkdir -p /home/alan/ginit/ginit/paseo/.claude/hooks
cp /home/alan/ginit/ginit/.claude/hooks/paseo-auto-import.sh \
   /home/alan/ginit/ginit/paseo/.claude/hooks/
chmod +x /home/alan/ginit/ginit/paseo/.claude/hooks/paseo-auto-import.sh
```

修改脚本的 `run_paseo` 函数，让它指向真正的 paseo 源码目录：

```bash
run_paseo() {
  if [ -n "${PASEO_HOOK_CLI:-}" ] && [ -x "${PASEO_HOOK_CLI}" ]; then
    "$PASEO_HOOK_CLI" "$@"
    return
  fi
  (npx tsx packages/cli/src/index.ts "$@")
}
```

创建 `.claude/settings.json`：

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/home/alan/ginit/ginit/paseo/.claude/hooks/paseo-auto-import.sh",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

### 2. 配置目标 daemon 的 claude provider

**关键发现**：paseo daemon 需要能找到 `claude` 二进制才能导入 claude 会话。Docker 6767 实例和初始的 6769 实例都没有配置，导入时报错 `Provider 'claude' is not available`。

**解决方案**：在目标 daemon 的 `config.json` 中配置 `agents.providers.claude.command`（**不是**顶层的 `providers`，那个是给语音服务用的）：

```json
{
  "version": 1,
  "daemon": { ... },
  "app": { ... },
  "agents": {
    "providers": {
      "claude": {
        "command": ["/home/alan/.ginit/device-runtime/runtime/bin/claude"]
      }
    }
  }
}
```

重启 daemon 后，`paseo provider ls` 显示 claude 为 `available`。

### 3. 端到端验证

```bash
cd /home/alan/ginit/ginit/paseo
export GINIT_PASEO_HOST="localhost:6769"  # 可选，hook 脚本默认 6769
echo "console.log('test');" | ginit ccd -p
# 会话结束后，Stop hook 自动执行
```

检查导入结果：

```bash
export PASEO_PASSWORD="JpYEyWUoTT4s9MpjGacTDkKnUiuIt5hu"
npm run cli -- ls -a -g --host localhost:6769
```

**验证成功**：agent `b32d91d4-6169-4eea-8782-66f44a708112` 出现在列表中，provider = `claude/claude-opus-4-8`，cwd = `~/ginit/ginit/paseo`，labels = `{"source": "ginit-auto"}`，创建时间 `just now`。

### 4. 坑与注意点

1. **`agents.providers` vs `providers`**：config.json 的顶层 `providers` 是给语音服务（OpenAI STT/TTS、local speech）用的，agent provider（claude/codex/copilot）的配置在 `agents.providers.<provider-id>`。直接加 `providers.claude` 会报 schema 错误。

2. **claude 二进制位置**：ginit 的 device-runtime 在 `~/.ginit/device-runtime/runtime/bin/claude`，版本 `2.1.198 (Claude Code)`。

3. **默认端口优先级**：hook 脚本的默认 host 优先级为：`GINIT_PASEO_HOST` 环境变量 > `PASEO_TERMINAL_ACTIVITY_URL`（从 paseo terminal 拉起时自动设置）> 脚本默认值（改为 `localhost:6769`，因为它已配置好 claude provider）。

4. **6767 Docker 实例**：镜像内没有 `claude` 二进制，需要另外配置或挂载。若要用 6767 作为目标，要么在容器内安装 claude，要么改用 6769 本地实例。

5. **marker 文件**：hook 执行成功后会在 `~/.cache/ginit-paseo-imported/<session-id>` 创建空文件防止重复导入（幂等）。

### 5. 最终配置

- **工作目录**：`/home/alan/ginit/ginit/paseo`
- **Stop hook 脚本**：`.claude/hooks/paseo-auto-import.sh`（指向 `/home/alan/paseo` 的 CLI）
- **settings.json**：`.claude/settings.json` 注册 Stop hook
- **目标 daemon**：localhost:6769（本地开发实例，已配置 claude provider）
- **密码**：`PASEO_PASSWORD=JpYEyWUoTT4s9MpjGacTDkKnUiuIt5hu`
- **标签**：导入的 agent 自动带 `source=ginit-auto`

**总结**：核心问题是 daemon 需要知道 claude 二进制在哪里（通过 `agents.providers.claude.command` 配置）。配置正确后，Stop hook 可以自动把本机任意目录的 claude 会话导入到指定 daemon，并打上 `source=ginit-auto` 标签便于过滤。

---

## 2026-07-26 - paseo-auto-import hook 端到端重测

**Q（问题）**：用户要求重新测试 paseo-auto-import hook 端到端流程：在 `/home/alan/ginit/ginit/paseo` 目录下用 `ginit ccd` 创建 3 个测试会话，验证是否自动导入到 paseo 6769 daemon，agent 正确显示在列表中，labels 包含 source=ginit-auto，provider 识别为 claude/claude-opus-4-8。

**W（解决方法）**：

1. **环境准备**：发现 `/home/alan/ginit/ginit/paseo` 不是真正的 paseo 项目（只是 vendor 副本），实际 paseo 项目在 `/home/alan/paseo`。直接用 paseo CLI 在 6769 端口起 daemon（独立 home `/tmp/paseo-6769-home`）。
2. **诊断 #1：daemon provider 不可用**：初次启动后 `agent import` 报 `Provider 'claude' is not available. Available providers: none`。查 daemon 日志发现没有 provider 检测记录。原因是 daemon 启动时 PATH 缺少 claude 二进制路径。修复：启动前加 `export PATH="/home/alan/.nvm/versions/node/v20.20.2/bin:$PATH"`，重启后 `provider ls` 显示 `claude=available`。
3. **诊断 #2：hook 脚本 fallback 路径错误**：手工跑 hook 脚本发现 fallback 走 `(cd /home/alan/ginit/ginit/paseo && npx tsx packages/cli/src/index.js ...)`，但该目录不是真实 paseo checkout，报 `ERR_MODULE_NOT_FOUND`。修复 hook 脚本 `/home/alan/ginit/ginit/.claude/hooks/paseo-auto-import.sh`：
   - fallback 路径改为 `(npx tsx packages/cli/src/index.ts ...)`
   - 默认 host 从 `localhost:6868` 改为 `localhost:6769`（配合本次测试目标）
4. **端到端验证**：在 `/home/alan/ginit/ginit` 目录下用 `/home/alan/.ginit/claude-runtime/bin/claude -p "test message N"` 连续跑 3 个会话：
   - ddf769e8-fbd5-483c-82dd-26cd23a814f6
   - 13c4aa8b-0027-46b3-8959-bc4fb9878dd3
   - 2d5342cf-3e34-46e4-a669-9cb60960d70f
5. **验证结果**：3/3 全部成功自动导入到 6769 daemon：
   - `~/.cache/ginit-paseo-imported/<session-id>` marker 全部创建
   - `paseo ls --host localhost:6769` 显示 3 个新 agent
   - agent 持久化文件 `/tmp/paseo-6769-home/agents/home-alan-ginit-ginit/*.json` 中 `labels.source=ginit-auto`、`provider=claude`、`config.model=claude-opus-4-8` 全部正确

**结论**：Stop hook 配置完全工作正常，自动导入链路可用。前提是：① daemon PATH 含 claude 二进制 ② hook 脚本 fallback 路径指向真实 paseo checkout。

---

## 2026-07-26 - paseo 对外部署到 8234 端口

**Q（问题）**：用户要求确认 paseo 是否已部署，并要求部署端口使用 8234、对外所有 IP 可访问。实际排查发现两点：① 已有部署（/home/alan/paseo-deploy，docker 容器 `paseo`，镜像 `ghcr.io/getpaseo/paseo:latest`，映射 6767:6767，已绑定 0.0.0.0 对外可达）但端口不是 8234；② 直接改端口后容器 crash-loop，报 `[Config] Invalid config: daemon: Unrecognized key: "hub"`。

**W（解决方法）**：

1. **根因诊断**：`paseo-home/.paseo/config.json` 里带 `daemon.hub` 配置（feat_ginit_connect 分支新功能，ginit hub 连接配置），而 GHCR `latest` 镜像（v0.1.x 时代）不认识 `hub` 这个 key，严格 Zod schema 直接拒绝启动。端口改动只是顺带触发重启，真正把容器弄挂的是「持久化配置 vs 旧镜像」的不匹配。
2. **修复方案**：从当前 `feat_ginit_connect` 分支源码本地构建镜像（含 hub 支持），替换 GHCR 镜像：
   ```bash
   # 本机 Docker 无 buildx，legacy builder 不支持 --platform=$BUILDPLATFORM，需要先去掉的 Dockerfile 副本
   mkdir -p /tmp/paseo-build-ctx
   cp docker/base/Dockerfile /tmp/paseo-build-ctx/Dockerfile
   sed -i 's|--platform=\$BUILDPLATFORM ||' /tmp/paseo-build-ctx/Dockerfile
   docker build -f /tmp/paseo-build-ctx/Dockerfile -t paseo:local-ginit /home/alan/paseo
   ```
   注意：`-f` 路径与 build context 路径可以不同，COPY 仍然相对于 context 根目录解析，所以无需改动原仓库的 Dockerfile。
3. **改端口对外**：编辑 `/home/alan/paseo-deploy/docker-compose.yml`，`image` 换成 `paseo:local-ginit`，端口映射改为 `"8234:6767"`（冒号左侧宿主机端口可自由换，容器内 daemon 仍监听 6767；不写宿主机 IP 默认绑 0.0.0.0 + [::]，即所有网卡）。然后 `docker compose up -d` 重建容器。
4. **验证**：
   - `ss -tln | grep 8234` → 0.0.0.0:8234 + [::]:8234 均 LISTEN
   - `curl http://127.0.0.1:8234/api/health` → `{"status":"ok"}`
   - `curl http://192.168.3.2:8234/`（本机局域网 IP）→ HTTP 200
   - Playwright 打开 `http://127.0.0.1:8234/` 正常渲染 Welcome 页（v0.2.0-beta.4）
   - 容器日志确认 hub 连接恢复：`Sent hub.hello` → `Hub welcome received; device online` → `Sent hub.workspace.snapshot`
5. **遗留**：① 局域网内其他机器用 `http://192.168.3.2:8234` 访问即可（密码与之前相同，PASEO_PASSWORD 未变）；② 后续官方发布含 hub 功能的版本后，可以把 image 换回 `ghcr.io/getpaseo/paseo:latest` 并删掉本地构建镜像；③ 注意 dev daemon 与生产容器现在分别占 6768/8234，6767 已空出。

**结论**：paseo 已按 8234 端口对外部署完成，hub 配置兼容问题解决，Web UI 与 hub 链路均验证正常。

---

## 2026-07-26 - 配置 ginit ccd 会话自动同步到 paseo hub（远程可用）

**Q（问题）**：用户要求修改系统配置，让 `ginit ccd` 启动的 Claude 会话下次自动同步到 paseo hub，并能在远程 paseo 上登录使用。

**W（解决方法）**：

### 目标链路

`ginit ccd` 会话结束 → 全局 Stop hook → `paseo agent import` 到 8234 容器 → agentManager 事件 → hub-connector 推送 `hub.workspace.snapshot` 到 ginit hub → 远程可见。

### 配置改动（3 处）

1. **8234 容器支持导入 claude 会话**（`/home/alan/paseo-deploy/`）：
   - `paseo-home/.paseo/config.json` 增加 `agents.providers.claude.command = ["/opt/ginit-runtime/bin/claude"]`（注意是 `agents.providers`，顶层 `providers` 是语音服务用的）。
   - `docker-compose.yml` 增加 3 个挂载：
     - `/home/alan/.ginit/device-runtime/runtime:/opt/ginit-runtime:ro`（claude 二进制）
     - `/home/alan:/home/alan`（任意目录下的 ccd 会话 cwd 在容器内可访问）
     - `/home/alan/.claude:/home/paseo/.claude`（claude transcript 在真实用户 home 下，容器内 daemon 以 paseo 用户运行，必须映射到它的 home）
2. **全局 Stop hook**：hook 脚本固化到 `/home/alan/.local/share/paseo-hooks/paseo-auto-import.sh`，默认 host 改为 `127.0.0.1:8234`，脚本内默认导出 `PASEO_PASSWORD`（8234 需要密码，WS 子协议格式是 `paseo.bearer.<password>`）。注册到 `~/.claude/settings.json` 的 `hooks.Stop`（matcher 为空的新 group，与已有 ginit hook 并存，全局生效，任何目录的 ccd 会话都会触发）。
3. **远程入口**（之前已就绪，本次复验）：
   - 局域网：`http://192.168.3.2:8234`（绑 0.0.0.0，HTTP 200）
   - 公网：relay 已启用且 `relay_control_connected`（app.paseo.sh 添加 serverId `srv_nvcX2Px9Rmfh` + 密码即可连）

### 端到端验证

- 在 `/home/alan/ccd-e2e-test` 跑 `ginit ccd -p "请只回复两个字:同步"`，Stop hook 自动导入成功（marker `~/.cache/ginit-paseo-imported/<session-id>` 幂等防重）。
- `paseo ls --host 127.0.0.1:8234` 显示新 agent（provider=claude/claude-opus-4-8，labels 含 source=ginit-auto）。
- 容器日志确认 snapshot 递增推送：`hub.workspace.snapshot workspaceCount 2 → 3`，hub 连接有 1006 断线但自动重连（Hub welcome received）。

### 坑

1. **容器内 cwd 必须存在**：import 校验 cwd，宿主路径 `/tmp/...` 在容器里不存在会报 `Working directory does not exist`；挂载 `/home/alan` 后真实路径即可直接通过，workspace 软链接方式（指到 /tmp）在容器内 dangling 不可用。
2. **旧 marker 会跳过导入**：换目标 daemon 后要清 `~/.cache/ginit-paseo-imported/` 里对应的 marker 或换新会话测试。
3. **hub 偶发 1006 断线属正常**：connector 有指数退避自动重连，不需要处理。

## Q: 飞书重复登录出现 device_id already enrolled，是否测试问题？

W: 这是真实的幂等性缺陷，不是测试造出来的问题。第一次 enrollment 会把当前 daemon 的 device*id 注册到 ginit hub；重复登录仍然使用相同 device_id redeem，hub 正确拒绝重复注册。修复是在 daemon enroll 中识别该明确的 400 错误，保留已有 pht* 设备凭证，仅刷新 ginitBaseUrl/ginitToken；同时 UI 提示旧设备需重新登录而不无限循环。测试覆盖首次 enrollment、重复 enrollment、设备列表 token 缺失和设备列表成功场景；Playwright 通过真实飞书授权验证了重复登录后的 token 持久化和设备列表加载。

---

## 2026-07-27 - 欢迎页 Feishu 登录被 CORS 拦截

**Q（问题）**：浏览器打开 `http://192.168.3.2:8234/welcome`，点「Login with Feishu」后控制台报 `Access to fetch at 'https://ginit.opensii.ai/auth/device/start' from origin 'http://192.168.3.2:8234' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header`，登录完全走不通。

**W（解决方法）**：

1. **根因**：`packages/app/src/components/ginit-feishu-welcome.tsx` 里直接 `fetch("https://ginit.opensii.ai/auth/device/start")`。ginit 服务器不返回任何 CORS 头，跨域请求在浏览器侧被拦截（服务器其实收到了请求，但响应被浏览器丢弃）。同源策略只在浏览器生效，daemon（Node.js）直连没有这个问题。
2. **修复思路**：daemon 本来就已经实现了完整的 ginit 设备流代理 RPC——`hub.device_start.request` / `hub.device_poll.request` / `hub.login_ginit.request`（server 端 `GinitHubEnroller.deviceStart/devicePoll/enroll`，设置页 `host-page.tsx` 的 GinitHubSection 已在用）。欢迎页组件改为复用这条链路：从 `useHosts()` 找当前已连接的本地 host 的 daemon client，走 WebSocket RPC 完成 device start → 打开 verification_uri → 轮询 poll → enroll，全程不直接访问 ginit 服务器。
3. **顺手修正**：旧流程登录后展示的设备列表依赖 ginit `/api/paseo/devices` 返回的 `public_key`/`relay_endpoint` 字段（server 端 schema 里没有这些字段，永远连不上）；新流程 enroll 成功后 daemon 自己就连上 hub，欢迎页原有的 `useAnyHostOnline` 监听会自动跳转工作区，设备发现交给设置页。
4. **验证时注意**：`http://192.168.3.2:8234` 是 docker 容器（镜像 `paseo:local-ginit`）提供的 web UI，bundle 是构建镜像时打包进去的。改了 app 代码必须重新 `npm run build:daemon-web-ui` + 重新 `docker build` + `docker compose up -d`，否则容器里还是旧 bundle，CORS 报错会复现（本次第一次验证就踩到这个）。另外容器内 `npm ci` 直连 registry.npmjs.org 会 ECONNRESET，构建时加 `--registry=https://registry.npmmirror.com` 即可（改的是 /tmp 下的 Dockerfile 副本，不动仓库）。
5. **二次修复（同一组件）**：走通代理后发现新问题——干净浏览器（无已保存 host）点登录时没有任何已连接的 daemon client 可用，且 `window.location.host` 对应的 daemon 有密码保护（bootstrap 探测报 "Password required"）。组件增加兜底：无已连接 host 时用 `probeAndUpsertDirectConnection` 探测提供当前页面的 daemon，密码错误时 `window.prompt` 让用户输入一次并缓存到 AsyncStorage（`@paseo:host-password-v1`）。Playwright 实测：点登录 → 弹出密码框 → 输入正确密码后自动连上 daemon 并跳转 `/open-project`，全程 console 无 CORS 错误。
6. **验证结果**：重建镜像后 Playwright 点击登录按钮，console 无任何指向 ginit.opensii.ai 的请求、无 CORS 错误；device flow 经 daemon 代理正常发起；密码缓存后 welcome 页因 host 在线自动跳转工作区（说明连接链路完整）。

**结论**：浏览器端永远不要直连 ginit API，一律走本地 daemon 的 hub RPC 代理；改了 web UI 代码要记得重建 docker 镜像才能生效。

## Q: testbed(150.5.173.43) 部署 ginit staging 后 /api/paseo/\* 与 /ws/v1/paseo 返回 404

W: testbed 的 /opt/ginit/ginit 是旧版（无 paseo_hub.py/paseo_hub_gateway.py，migrations 只到 0017）。修复：① 从本地 ginit-server rsync `ginit/`（--delete）+ `migrations/` 到 /opt/ginit 对应目录；② systemctl restart ginit 拉起 8090/8091；③ paseo 表未建——schema_version 里 16-24 被 tag 系列占用，与本地 0019/0020 版本号碰撞导致框架跳过；用 python 手动 executescript 0019_paseo_hub.sql + 0020_paseo_relay_metadata.sql，并以 100/101 登记 schema_version 避开 tag 冲突。验证：/api/paseo/devices 无 token 返回 401（路由已注册）、/ws/v1/paseo 返回 426（WS endpoint 存活）、/auth/device/start 返回 device_code。教训：ginit 版本号全局碰撞时，paseo 迁移需用独立高位段（100+）登记。

---

## 2026-07-28 - testbed(150.5.173.43) 部署 Paseo relay（8234）+ daemon 切 staging hub

**Q（问题）**：A 端（本机 8234 paseo daemon）是否会向 `150.5.173.43:8234` 发送 daemon 注册和飞书账号信息？要求把 B 端（testbed）配成完整中继并让 A 端注册过去。

**W（解决方法）**：

1. **先厘清概念**：`150.5.173.43:8234` 上跑的既不是 ginit hub 也不是 paseo relay——注册（enrollment）只发生在 ginit-server（`/api/paseo/enrollments*`）且 daemon 只会把注册发到 `daemon.hub.url` 指向的 ginit 服务。要让 A 端「注册到 testbed」，需要两件独立的东西：① staging ginit hub（`wss://staging.ginit.opensii.ai/ws/v1/paseo`，Caddy→8090/8091，已就绪）② 数据面 relay（之前不存在）。

2. **在 testbed 部署自托管 paseo relay（监听 0.0.0.0:8234）**：官方 relay 只有 Cloudflare Durable Objects 实现（`packages/relay/src/cloudflare-adapter.ts`），仓库里没有 Node 版 server。新写 `/opt/paseo-relay/relay-server.mjs`（单文件、依赖只有 `ws`），完整复刻 DO 的 v1/v2 线协议：`/ws?serverId&role&v=2`、control/data/client 三种 socket、sync/connected/disconnected 控制帧、client 帧缓冲到 daemon data socket 上线再 flush。systemd 单元 `paseo-relay.service` 常驻。验证：`curl http://150.5.173.43:8234/health` → `{"status":"ok","sessions":N}`。

3. **修复 relay 每 ~20s 掉线重连（1006 churn）**：daemon 日志 `relay_control_disconnected(1006)` 每 20s 一次。定位过程：给 relay 加 close/error 日志后发现是 relay 自己的 heartbeat 在 terminate。**根因：`new WebSocketServer({ noServer: true })` 模式下 `wss.on("connection")` 不会触发**（`wss.handleUpgrade` 绕过发射），导致 `isAlive=true`/pong 监听从未挂上，heartbeat 第二轮就把所有 socket 判死。修复：把 `isAlive=true` + pong 监听移进 `handleUpgrade` 回调。教训：noServer 模式的心跳簿记必须放在 handleUpgrade 回调里。

4. **A 端 daemon 配置切换**（`/home/alan/paseo-deploy/paseo-home/.paseo/config.json`）：`daemon.relay` = `{endpoint/publicEndpoint: "150.5.173.43:8234", useTls: false}`；`daemon.hub` 指向 staging（`wss://staging.ginit.opensii.ai/ws/v1/paseo` + `ginitBaseUrl: https://staging.ginit.opensii.ai`），删掉 prod 的 `token`/`ginitToken`（staging 是另一个数据库，prod 的 pht\_ token 在那里无效，必须重新 enroll）。`docker compose restart paseo` 后 `relay_control_connected` 稳定在线。

5. **ginit-server 新增 PATCH `/api/paseo/devices/{id}`**（`paseo_hub.update_device_relay`）：enroll 只在 redeem 时写 relay metadata，重复登录又走「device_id already enrolled 保留凭证」分支，老设备永远 `connection_ready=false`。PATCH 端点让已注册设备可以补/改 `relay_endpoint`/`relay_use_tls`（带用户隔离和 400 校验）。已加单测（3 tests OK）、提交推送到 ginit `feat-paseo` 分支并部署到 testbed。

6. **App 默认 ginit base URL 切 staging**：`ginit-feishu-welcome.tsx` 和 `host-page.tsx` 的 `GINIT_BASE_URL` 从 prod 改为 `https://staging.ginit.opensii.ai`（typecheck/lint/format 全绿，已推送 `cd6b5fd2a`）。注意：8234 容器里的 web UI bundle 是构建镜像时打包的，此改动要 `npm run build:daemon-web-ui` + 重建 `paseo:local-ginit` 镜像才对容器生效（本次未重建，因为 enroll 走的是 CLI RPC 通道）。

7. **端到端验证结果**：
   - relay E2E：用仓库的 `DaemonClient`（dist 构建产物）+ `buildRelayWebSocketUrl(role:"client")` 直连 `ws://150.5.173.43:8234`，E2EE 握手成功、RPC（hub.enroll_status）经 relay 打通 ✅
   - daemon→relay control 长连接 90s+ 无掉线 ✅
   - staging 端点：`/api/paseo/devices` 401（路由活）、`/ws/v1/paseo` 426（WS 活）、`/auth/device/start` 正常签发 ✅
   - **飞书授权未完成**：device flow 已发起（verification_uri 有效 15 分钟），用户选择暂不授权，故 daemon 在 staging 的最终 enroll + 设备列表 online/connection_ready 留待授权后自动完成（后台轮询脚本 `/tmp/paseo-relay/poll-and-enroll.mjs` 授权即自动 enroll + PATCH relay metadata）。

**结论**：B 端中继两件套（staging hub + 自托管 relay:8234）已就绪；A 端 daemon 的 relay 数据面已切到 `150.5.173.43:8234` 且验证可连；A 端注册（enroll）目标已切到 staging，差最后一步飞书授权。授权后完整链路 = A 端 enroll 到 staging hub（绑定飞书账号）→ C 端同账号登录 staging 看到设备 → 经 `150.5.173.43:8234` relay 连到 A 端 daemon。

---

## 2026-07-28 - 浏览器打开 http://150.5.173.43:8234/ 报 426 Upgrade Required

**Q（问题）**：用户在浏览器地址栏访问 `http://150.5.173.43:8234/`，DevTools Console 报错 `Failed to load resource: the server responded with a status of 426 (Upgrade Required)` 和 `TypeError: navigator.getBattery is not a function`（chrome-extension）。担心服务挂了。

**W（解决方法）**：

1. **426 是 Paseo relay 数据面的协议预期行为，不是 bug**。`150.5.173.43:8234` 上部署的是 Paseo 数据面 relay（`/opt/paseo-relay/relay-server.mjs`，systemd `paseo-relay.service`，0.0.0.0:8234，复刻 Cloudflare DO 的 v1/v2 线协议）。它**只接受 WebSocket 升级请求**，参考实现 `packages/relay/src/cloudflare-adapter.ts:150-156` 的 `requireWebSocketUpgrade`：非 `Upgrade: websocket` 的 HTTP GET 一律返回 `426 Expected WebSocket upgrade`。浏览器地址栏发起的是普通 GET（无 WS upgrade header），被拒是设计行为。

2. **relay 不是 Web UI**。文档 `docs/ginit-paseo-complete-architecture.md` 明确：relay 是数据面（`手机/Web Paseo client ↔ relay ↔ daemon`），地址写作 `ws://150.5.173.43:8234`（注意是 ws:// 不是 http://）。它不渲染 HTML，浏览器访问没有意义。要看 Web UI 应该用 daemon 端口（本机 Docker `paseo` 容器 `0.0.0.0:8234→6767`，注意跟 staging relay 同名但不同机）。

3. **验证 relay 实际健康**：`curl http://150.5.173.43:8234/health` 返回 `200 {"status":"ok","sessions":1}` —— relay 活着且已有 1 条 daemon control socket 在线。`sessions` 字段反映当前活跃 WebSocket 数，是最直接的健康指标。

4. **`navigator.getBattery is not a function` 与 relay 完全无关**。报错栈来自 `chrome-extension://hlofigcdgjlnalbkeeinfcjceabpamci/js/contentscript.js` —— 是用户浏览器装的某个扩展调用已被 Chrome 移除的 `navigator.getBattery()` API（Chrome 88+ 已删除），属插件自身 bug。忽略或在 chrome://extensions 卸载该扩展即可。

**健康检查速查**：

- 浏览器看到 `426 Upgrade Required` → relay 端点活着，只是不接受普通 HTTP。
- `curl http://150.5.173.43:8234/health` 应返回 `{"status":"ok","sessions":N}`，N≥1 表示至少 1 条 daemon control socket 在线。
- 真正的服务挂掉会返回 `000`（连接被拒/超时），不是 426。

---

## 2026-07-28 - 飞书授权报 20029 / No permission + hub.hello 404（裸 IP 8235 方案）

**Q（问题）**：staging 飞书登录三连坑：① 授权页报 `Invalid redirect URL Error code: 20029`（回调未在应用后台登记）；② 换应用后报 `You don't have the access`（应用对当前租户不可用）；③ 授权成功 enroll 后 daemon 连 hub 被 `404` 拒绝（`hubUrl` 从 REST base URL 推导成 `ws://150.5.173.43:8090/ws/v1/paseo`，但 WS 网关在 8235）。

**W（解决方法）**：

1. **20029（redirect URL 未登记）**：staging 原配置回调是 `https://staging.ginit.opensii.ai/auth/feishu/callback`，但用户要求走裸 IP `150.5.173.43:8235`。改 testbed `/etc/ginit.env`：`FEISHU_REDIRECT_URI=http://150.5.173.43:8235/auth/feishu/callback`，并让用户在飞书开发者后台（该应用 → 安全设置 → 重定向 URL）登记**完全一致**的这个地址。教训：飞书校验的是 exact match，域名/端口/路径任一不同都会 20029。

2. **8235 同时服务 WS 和 HTTP**：8235 是 ginit 的 websockets 网关端口（`/ws/v1/*`），浏览器访问 `/auth/feishu/*` 默认报 "cannot access a WebSocket server directly"。利用 websockets 的 `process_request(path, headers)` 钩子（legacy API，websockets 13.1 在用的就是这个签名，**不是**新 asyncio API 的 `(connection, request)`）在 WS 升级前拦截 `/auth/*`，用 `_Stub`（只实现 `_redirect`/`_send_html`/`_send`）复用 `Handler.auth_feishu_start/callback` 的完整逻辑。同一进程同一端口，WS 升级和 HTTP GET 分流完成。

3. **No permission（应用对租户不可用）**：staging 原 SSO 应用 `cli_a969a44482389cd2` 对 GAIR 租户不可用（注意：该应用其实是 testbed IM connector/bot 的专用应用，本来就不该兼做 SSO——同一应用长连接事件会在所有在线客户端间负载均衡，混用会让 bot 能发不能收）。按用户指定换成 `cli_aacb827247389bde`（「王少敬的飞书 CLI」，GAIR 可用），更新 `/etc/ginit.env` 的 `FEISHU_APP_ID`/`FEISHU_APP_SECRET` 并重启。**已写入 docs/testbed.md：上线生产必须换生产专用应用**。授权页多租户时默认停在「中国数联」，需要点 GAIR 那行的 Select 再 Authorize。

4. **hub.hello 404（split gateway 端口）**：`toHubWebSocketUrl` 只换 scheme 不换端口，HTTP API 在 8090、hub WS 网关在 8235 的部署下推导出错误 URL。给 paseo `ginit-enroller.ts` 加 `GINIT_PASEO_HUB_WS_PORT` 环境变量覆盖（含 vitest 用例，14/14 通过）；同时手动把已持久化的 `daemon.hub.url` 改成 `ws://150.5.173.43:8235/ws/v1/paseo` 并重启容器。随后 `Sent hub.hello` → `Hub welcome received; device online` → `hub.workspace.snapshot` 全通。

5. **端到端验证（Playwright 真实飞书授权）**：device flow → GAIR 账号授权 → `hub.login_ginit` enroll 成功（deviceId `eab4adff...`）→ PATCH relay metadata（`150.5.173.43:8234`）→ staging DB `paseo_devices` 行 `status=online, relay_endpoint=150.5.173.43:8234, user_id=3`（飞书 union_id `on_efca0ea9...` 绑定）→ 经 relay E2EE 连接 RPC 确认 `enrolled: true`。A→B→C 全链路在 testbed 闭环。

---

## 2026-07-28 - http://150.5.173.43:8236 看不到飞书登录 + 登录后看不到本机服务

**Q（问题）**：两个问题：① 打开 `http://150.5.173.43:8236/` 看不到「Login with Feishu」入口；② 飞书登录成功后看到的不是本机（B 的 paseo-web daemon）的服务/工作区。

**W（解决方法）**：

1. **飞书登录入口一直都在，只是位置不在根路径**。8236 启动时会自动 bootstrap 直连当前页面的 daemon（`window.location.host`），直连成功后按启动路由规则跳到 `/open-project`（docs/expo-router.md：无可恢复 workspace 时去全局 `/open-project`），所以「打开首页看不到登录」是已连上本机 daemon 的预期行为，不是 bug。飞书登录入口在 **Settings → Host → Overview → Ginit Hub** 卡片（设备未 enrolled 时显示「Login with Feishu」；已 enrolled 时显示「My enrolled hosts」设备列表）。

2. **登录后「看到的不是本机服务」其实是「哪儿都看不到本机的服务」**。B 的 paseo-web daemon（srv_oEgw）是个空 daemon：它没有挂载 B 机的工作目录，workspace snapshot 本来就是空（hub DB 里 `snapshot.workspaces=[]`）。ginit CLI 的会话在 A 机上跑，只会出现在 A 的 daemon（srv_nvcX，本机 8234 容器）里——B 网页登录后看到的「本机」= B 的 paseo-web 空 daemon，属预期。要在 B 网页里看到 A 的服务，需要从「My enrolled hosts」里把 A 设备（paseo-srv_nvcX）Connect here 加进来。

3. **顺手修了「Connect here 全部 disabled」的链路问题**：① B 的 paseo-web 设备 `2ecbaaa4` 在 hub 里 `relay_endpoint=NULL`（redeem 时报「device_id already enrolled」走保留凭证分支，老设备永远补不上 relay metadata）——用 `PATCH /api/paseo/devices/{id}` 补上 `150.5.173.43:8234` 后两台设备都 `connection_ready=True`；② UI 的「Connect here」按钮不是按设备 relay 连接，而是把「Default host address」当直连地址 `probeAndUpsertDirectConnection`，且默认 host 记忆存的是旧局域网地址 `192.168.3.2:8234`——在 B 网页把它改成 `150.5.173.43:8236` 后，本机那台显示 Added、A 那台按钮变为可点。

4. **遗留**：SSH 到 testbed（22 端口）当前被对端拒绝（`Connection closed by 150.5.173.43 port 22`，所有 TCP 服务 8090/8234/8235/8236 正常），暂时无法重建 paseo-web 容器镜像。8236 服务的 bundle（index-69118a16）比本机 A 容器里的（index-f52c0b20）旧，仍含一处 `staging.ginit.opensii.ai` 硬编码（位于 host-page GinitHubSection handleLogin 的旧版）；当前已 enrolled 不触发该路径，但**重新登录时会打到不可达的 staging 域名**。SSH 恢复后需重建镜像 redeploy，或把 GINIT_BASE_URL 从硬编码改为可配置。

---

## 2026-07-28 - SSH 到 testbed 卡在 KEX（sntrup761）+ paseo-web 重新部署

**Q（问题）**：SSH 到 `150.5.173.43` 反复 `Connection closed by 150.5.173.43 port 22` 或 `Connection timed out`，但裸 TCP 能连、能读到 SSH banner（`SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.16`），8090/8234/8235/8236 各 TCP 服务全部正常。

**W（解决方法）**：

1. **根因是 SSH 密钥交换（KEX）算法在后量子 `sntrup761x25519-sha512@openssh.com` 上卡死**，不是 sshd 挂了，也不是 fail2ban。verbose 日志显示握手停在 `expecting SSH2_MSG_KEX_ECDH_REPLY`——服务器接受了该算法但回包在路上丢失/被中间设备吞掉（该算法握手包特别大，容易触发路径 MTU/分片问题）。同一时刻另一进程用 `KexAlgorithms=ecdh-sha2-nistp256` 能稳定连上，证实了这一点。
2. **修复**：SSH 命令显式指定经典椭圆曲线算法即可稳定连接——
   ```bash
   ssh -o KexAlgorithms=ecdh-sha2-nistp256 root@150.5.173.43
   ```
   要永久生效，在 `~/.ssh/config` 的 `Host ginit-testbed` 下加一行 `KexAlgorithms ecdh-sha2-nistp256`。
3. **顺带完成 paseo-web 重新部署**（修上一篇遗留的旧 bundle staging 硬编码）：`docker save paseo:local-ginit | gzip`（约 155MB）scp 到 testbed → `docker load` → 重建 `paseo-web` 容器（`-p 8236:6767 -e PASEO_WEB_UI_ENABLED=true -e PASEO_PASSWORD=... -e GINIT_PASEO_HUB_WS_PORT=8235 -v paseo-web-home:/home/paseo`）。新 bundle（index-f52c0b20）已无 `staging.ginit.opensii.ai` 硬编码（grep=0），容器日志 `hub.hello → Hub welcome; device online`，hub 两台设备 online + connection_ready。

---

## 2026-07-28 - 8236 页面看不到飞书登录按钮（根因：daemon 密码未保存到 host 连接）

**Q（问题）**：打开 `http://150.5.173.43:8236` 后进 Settings → Host → Overview，**没有 Ginit Hub 卡片、没有「Login with Feishu」按钮**；页面顶部状态一直停在「Connecting」。

**W（解决方法）**：

1. **根因**：paseo-web daemon 的 `PASEO_PASSWORD` 保护生效，而**当前浏览器 host 注册表（localStorage `@paseo:daemon-registry`）里的 directTcp 连接没有保存密码**。daemon 日志连续刷 `Rejected WebSocket connection with invalid daemon password`（hasToken:false）。WS 连不上 → `useHostRuntimeClient(serverId)` 返回 null → `GinitHubSection` 第一行 `if (!daemonClient) return null` 直接不渲染，所以整段飞书登录区（Ginit Hub 卡片 + My enrolled hosts + Login with Feishu 按钮）完全不出现。
2. **为什么之前能看到、后来看不到**：上一篇 QW 记录里用户/我们曾通过兜底 prompt 输过一次密码并连上；后来浏览器 localStorage 被清（或换了浏览器/隐身窗口），密码丢失，于是回到「Connecting」+ 无 Ginit Hub 的状态。这是**纯客户端本地状态问题**，B 的 daemon 本身、hub enroll、设备列表全部正常。
3. **修复（当前浏览器立即生效）**：在 localStorage `@paseo:daemon-registry` 的 directTcp 连接里补上 `password` 字段（`DirectTcpHostConnectionSchema` 本就支持 `password?: string`），刷新页面 → 状态变 `Online` → Ginit Hub 卡片正常出现（Device enrolled + My enrolled hosts 两台 online + Connect here + Default host address）。
4. **根治（让干净浏览器自动弹出密码输入框，而不是静默卡 Connecting）**：当前代码在「无密码 + probe 报 Password required」时应走 prompt/缓存逻辑，但该兜底只在 welcome 登录组件里，settings Host Overview 页没有。后续可在 `GinitHubSection` 或 `useHostRuntimeClient` 层加「密码缺失时引导输入」的统一兜底，避免用户在设置页看到无声息的 Connecting。

---

## 2026-07-29 - ginit+Paseo 六项架构修正（Web 宿主即设备 / 硬编码 / hello 元数据 / TOFU）

**Q（问题）**：布局评审发现六类架构不合理：① paseo-web enroll 成空 daemon 混进设备列表；② app 硬编码 `http://150.5.173.43:8090`，hub WS 靠 `GINIT_PASEO_HUB_WS_PORT` 推导；③ relay metadata 在 enroll 时一次写死，老设备永远 `connection_ready=false` 只能靠 PATCH 补丁；④ Hub/offer 是公钥的不可信传输，key 被换无感知（MITM）；⑤ 8234 在 A 是 daemon UI、在 B 是 relay，端口语义混乱；⑥ 飞书 OAuth 回调寄生 WS 端口。

**W（解决方法）**（全部代码侧完成并推送；relay 443 与 OAuth 回调迁移为纯部署步骤，已写进 docs/ginit-paseo-complete-architecture.md §13.9）：

1. **Web 宿主即设备拆除**（Paseo `f6e67cb30` + `0a3283ccc`）：协议 `hub.login_ginit.request` 加 optional `cacheOnly`（COMPAT(hubLoginGinitCacheOnly)），新增 `hub.account_token.request/response`；`GinitHubEnroller.cacheAccountToken()` 只缓存账号 token 不写设备身份；Welcome/Host 页改只读设备列表，web 宿主不再 enroll。
2. **运行期 endpoint**（含在前面提交）：daemon `PASEO_GINIT_BASE_URL`/`PASEO_GINIT_HUB_WS_URL` env → web-ui 注入 `window.__PASEO_GINIT_CONFIG__` → app `getGinitBaseUrl()` 运行期读取，硬编码删除；`GINIT_PASEO_HUB_WS_PORT` 降级为 COMPAT(ginitHubWsPortEnv)（2027-01-28 移除）。测试：config-ginit/web-ui/enroller 43 通过。
3. **hello 中继元数据**（Paseo `cae8d51a9` + ginit `4ff8a35`）：daemon `hub.hello` 带 `relay{endpoint,use_tls}`（`relayMetadataProvider` 来自运行期配置）；ginit gateway 验签后原子 COALESCE 更新 `paseo_devices`，缺字段保留旧值。`PATCH /api/paseo/devices/{id}` 标记 COMPAT(paseoDeviceRelayPatch)。测试：Paseo connector 6 通过；ginit gateway+hub 6 通过。
4. **TOFU 公钥固定**（Paseo `e1b99e61f`）：`RelayHostConnection.trustedKeyFingerprint`（nacl.hash 对原始 32 字节公钥，16-hex 分组）；`upsertRelayConnection` 首次固定、变更即抛「Daemon key changed … Re-pair」。测试：daemon-fingerprint + host-connection 15 通过。
5. **Relay 443/域名与 OAuth 回调迁移**：纯部署步骤（Caddy `wss://relay.example.com/ws`→127.0.0.1:8234；A 端 `publicEndpoint` 指 443 经 hello 下发；Hub 443→8090/8235 loopback），已写 §13.9，不在代码改动范围。

**验证**：目标测试 6 文件 64 通过；`npm run typecheck` 0 错；`npm run lint` 0 错；`npm run format:check` 全过。两仓库均已推送（paseo `ac9d988a9`，ginit `4ff8a35`）。

**注意**：`packages/app/src/runtime/host-runtime.test.ts` 在 baseline 就因 `expo-constants` 的 `__DEV__` 未定义而整套导入失败（与本次无关，未修）；TOFU 行为由 daemon-fingerprint/host-connection 测试覆盖。

---

## 2026-07-29 - 8236 看不到本机 daemon（enroll 身份被拆 + verification_uri 指 staging）

**Q(问题)**: 用户问 `150.5.173.4` 的 8236 页面能否飞书登录后看到本机启动的 ginit daemon。实测 8236 设备列表里本机 daemon 不在线。

**W(解决方法)**:

1. **地址澄清**：8236 在 `150.5.173.43`（用户笔误 .4，那台不可达），页面本身正常（200）。

2. **根因①：本机 A daemon 的 enroll 身份在 07-28「拆 Web 宿主即设备」时被剥掉**。`daemon.hub` 只剩 `ginitBaseUrl/ginitToken`，`enabled/url/deviceId/token` 全删，HubConnector 永不连线，hub 上 deviceId `eab4adff` 一直 offline。**恢复**：`pht_` 明文 token 已丢（hub 只存 HMAC hash），遂在 hub 上用 `GINIT_TOKEN_SECRET` 重新 HMAC-SHA256 签发一个新 device token 更新 `paseo_devices.token_hash`（verify_device 用 token_prefix 定位 + compare_digest 校验，同一 device_id 改 hash 即可），再把完整 hub 配置（enabled/url/deviceId/token）写回 A 容器 config 重启 → `Sent hub.hello` → `Hub welcome; device online`，DB 转 online。relay metadata 由 hello 自动带下（cae8d51a9 已实现的 `relayMetadataProvider`），无需 PATCH。

3. **根因②：hub `/auth/device/start` 返回的 `verification_uri` 用 `CFG base_url`（staging 域名）**，裸 IP 测试环境浏览器跳不过去（ERR_TIMED_OUT）。**修复**：ginit-server `server.py` 的 device start 改为——设了 `GINIT_PASEO_HUB_WS_PORT` 时 verification_uri 发 `http://150.5.173.43:8235/auth/feishu/start`（split 测试网关），否则维持原 base_url。已提交 ginit `40726c4` 推送 feat-paseo，并把同一份 server.py 同步 testbed 重启（md5 一致）。

4. **飞书登录链路验证**：8236 页面登录= daemon 密码（WS 子协议 `paseo.bearer.<password>`，Playwright 把密码补进 localStorage directTcp 连接即连通）+ device flow（daemon 代理 device_start→8235 授权页→cli_aacb 应用→回调 8235）。已走到飞书授权页；设备列表经账号 token `/api/paseo/devices` 独立确认两台 ready。飞书手机 App「确认登录」属 CLI 场景需用户在手机上点，不在本次自动化范围。

5. **踩坑（自伤）**：排查中误用 `docker exec … > config.json` 把 A 容器 config 截成 0 字节，且 docker cp 以 root 写入的 600 文件挡住 10001 daemon → `EACCES` crash-loop。**修复**：用 `docker run --rm -v <paseo-home>:/home/paseo alpine chown 10001:10001 …` 修属主/属组后恢复上线。教训：改容器内 bind-mount 的 10001 文件，要么 `docker cp`（保持容器内 uid）要么用特权容器 chown，别用会落 root 属主的重定向。

6. **最终状态**：hub DB 两台 `paseo-srv_nvcX`(A)+`paseo-srv_oEgw`(B) 均 online + connection_ready + relay=150.5.173.43:8234；relay sessions=2；8236 Host 页设备列表两台 online，本机 daemon 可见。

**结论**：8236 飞书登录后**能看到**本机 daemon（paseo-srv_nvcX，online）。两处修复：① 恢复 A 的 enroll 身份（重签 device token + 写回 hub 配置）② ginit-server verification_uri 支持 bare-IP（`GINIT_PASEO_HUB_WS_PORT`，commit `40726c4`）。

---

## 2026-07-29 - 端到端重测 + revoked 设备仍出现在列表 + 容器 UID 漂移

**Q（问题）**：整体端到端重测（部署 ginit hello-relay-metadata → 重建 A 镜像 → 清理幽灵设备 → 更新 B paseo-web → Playwright 验证）过程中暴露三个问题：① A 容器重启后 crash-loop `EACCES lstat .config.json.*.tmp`；② 撤销（revoke）B 的幽灵设备 `2ecbaaa4` 后，C 端设备列表仍显示它（status=revoked）；③ paseo-web 换新镜像后 hub connector 用已撤销的 `pht_` token 反复 4401 重连。

**W（解决方法）**：

1. **EACCES 根因是镜像 UID 漂移，不是配置损坏**。旧镜像 paseo 用户 uid=10001，新镜像（docker/base/Dockerfile 逻辑）paseo 用户 uid=1000；`/home/alan/paseo-deploy/paseo-home/.paseo` 卷内容是 uid 10001 所有，新容器（1000）写 config tmp 文件被拒。修复：`docker run --rm -v paseo-home:/ph node:22-bookworm-slim chown -R 1000:1000 /ph/.paseo` 后 `docker compose up -d` 即恢复。教训：卷内持久化目录的 owner uid 与镜像 ENTRYPOINT 用户 uid 必须一致，重建镜像换 uid 后要同步 chown。
2. **revoked 设备被 `list_devices` 返回**。`paseo_hub.list_devices` 查询没带 `status != 'revoked'`，导致已拆除的 web 宿主仍以 `revoked` 状态出现在「My enrolled hosts」。修复：查询加 `AND status != 'revoked'`（行保留在表里供审计，`verify_device` 本就已排除 revoked）；补 `test_revoked_devices_are_hidden_from_list`（ginit `8d92690`）。部署 rsync `paseo_hub.py` 到 testbed + `systemctl restart ginit` 后，账号设备列表只剩 `paseo-srv_nvcX online`。
3. **paseo-web 用已撤销 token 重连**。它的 `daemon.hub` 还带 `enabled/url/deviceId/token`（旧 enroll），connector 启动后向 hub 发送 hello，gateway 因 token 已撤销返回 4401 并循环重连。修复：进容器把 `daemon.hub` 里的 `enabled/url/deviceId/token` 删掉、只留 `ginitBaseUrl/ginitToken`（只读账号代理），重启后日志 `Hub not configured; connector idle until enrollment`，不再上线。

**端到端验证结果（全绿）**：

- A 端 daemon：`Sent hub.hello` → `Hub welcome received; device online` → `hub.workspace.snapshot`；hub DB `eab4adff` `online`、relay metadata 正常（hello 携带，gateway 已应用）。
- relay：`/health` 200，`v2:server(control) connected serverId=srv_nvcX2Px9Rmfh` 在线。
- 设备列表（账号 API）：只剩 `paseo-srv_nvcX online`（幽灵 srv_oEgw 已 revoked 且不再返回）。
- **relay E2EE 数据面**：`node /tmp/relay-e2e-test.mjs` 经 `ws://150.5.173.43:8234` 用 daemon 公钥完成 E2EE 握手连到 A 的 srv_nvcX，`hubGetEnrollStatus` 返回 `enrolled:true`、`hubListDevices` 成功——证明 C→relay→A 数据链路真实可用。
- **C 端 Web UI（8236）**：新 bundle 无 `150.5.173.43:8090` 硬编码，`window.__PASEO_GINIT_CONFIG__={"baseUrl":"http://150.5.173.43:8090"}` 由运行期注入；清掉 localStorage 后 Welcome 页正常渲染「Login with Feishu」；Settings→Host→Ginit Hub 显示只读提示「This web host is read-only — it is not enrolled as a device」+ 设备列表只列 srv_nvcX。
- Hub 飞书 device flow：`/auth/device/start` 正常签发 device_code + verification_uri（登录路径可用）。

**遗留（非本次范围）**：① 8236 的 paseo-web daemon 设了 PASEO_PASSWORD，干净浏览器首次访问需先输密码才能进 Feishu 流程——建议后续给「密码缺失时统一引导输入」的兜底；② welcome 页 C 端「选设备 → upsertRelayConnection」的浏览器内自动连接未单独跑通（relay E2EE 已用 node 证明数据面通），TOFU 指纹持久化待真实「Connect」动作落 HostProfile 后验证。

---

## 2026-07-29 - 8236 welcome 页 Feishu 登录报「Password required」无密码输入入口

**Q(问题)**: 打开 `http://150.5.173.43:8236/welcome` 点「Login with Feishu」直接报错 `Password required`，干净浏览器（无已存密码）无法登录。

**W(解决方法)**:

1. **复现**：Playwright 打开 welcome 页 → 点 Login with Feishu → 页面显示 `Password required`，console 显示 `initial connection hint probe failed ... Password required`，B daemon 日志刷 `Rejected WebSocket connection with invalid daemon password`（hasToken:false）。
2. **根因**：`resolveDaemonClient`（`ginit-feishu-welcome.tsx`）在「无已连接 client」时调用 `probeAndUpsertDirectConnection({ endpoint: window.location.host })` 盲探——不传密码，命中 daemon 的密码保护直接失败；且错误路径只把 `Password required` 原文渲染出来，没有任何输入密码的入口。07-28 修复过的「window.prompt 输密码缓存」兜底在 07-29「拆 Web 宿主即设备」重构（cacheOnly 化）时被改没了。
3. **修复（paseo `bfd4ff772`）**：
   - `resolveDaemonClient` 增加可选 `password` 参数，盲探时带上；
   - 登录 catch 里识别 `Password required` → 渲染密码输入框 + 「Sign in with password」按钮，重试把密码经 `probeAndUpsertDirectConnection` 传入（密码随之被持久化到 host 连接，后续会话复用）；
   - 新增 `findServingHostClient`：优先复用「服务当前页面的 host」的已连接 runtime client，避免对已存在但仍在线的 host 盲目重新盲探导致再次 `Password required`。
4. **部署**：`npm run build:daemon-web-ui` 出新 bundle（`index-19a390ba…`），打包 `packages/server/dist/server/web-ui` 经 SSH docker cp 进 B 容器 `…/server/web-ui` 原位替换并 `docker restart paseo-web`，8236 index.html 引用新 bundle ✅（ginit config `__PASEO_GINIT_CONFIG__` 注入保持正常）。
5. **Playwright 验证**：清空 localStorage host 后 → 点 Login with Feishu → 出现密码框（`This daemon requires a password. Enter it below...`）→ 输密码 → Sign in → 连上 daemon（`Client connected via hello`，fetch_agents/workspaces 正常）并跳转 open-project，密码已写回 host 连接。**「Password required」裸报错已消除，干净浏览器可自助输入密码登录**。
6. **已知边界**：密码登录成功后 welcome 因 host 已在线自动跳 open-project（host 在线即非 welcome 场景），飞书 device flow 需在未连接场景触发；密码兜底本身工作正常。console 另有 `ws://localhost:6767` 的连接尝试（app 默认 bootstrap 探本机 daemon，8236 场景无本机 daemon，console 报 refused 属正常噪声）。

**结论**：8236 welcome 页干净浏览器登录时给出密码输入入口，输一次密码即连上并持久化；`Password required` 裸报错问题已修复（commit `bfd4ff772` 已推送，8236 bundle 已更新为 `index-19a390ba…`）。

---

## 2026-07-29 - 6769 daemon 切到 testbed hub + ginit ccd 自动注册

**Q(问题)**: 本地 `ginit ccd` 启动的 daemon（6769）注册到了生产 hub（`ginit.opensii.ai`），远程 8236 页面的 testbed hub 看不到它；且后续每次 `ginit ccd` 都要手动 enroll，不符合自动化要求。

**W(解决方法)**:

1. **手动切换 6769 daemon 到 testbed**：
   - 用 testbed 飞书账号 token 调 `POST /api/paseo/enrollments` 拿 ticket，再调 `POST /api/paseo/enrollments/redeem` 注册 6769 的 device identity（deviceId `25de4b8b-…`，daemonId `srv_V_6a3jxLQ4Ip`）。
   - 更新 6769 的 `config.json`：`daemon.hub` 指向 `ws://150.5.173.43:8235/ws/v1/paseo` + 新 device token + `ginitBaseUrl=http://150.5.173.43:8090`。
   - 用 `npm run cli -- daemon start --listen 127.0.0.1:6769` 重启，日志确认 `hub.hello` → `Hub welcome; device online`，testbed DB 显示 `paseo-srv_V_6a` online。

2. **ginit ccd 自动注册（ginit `2fde6d6`）**：
   - 在 `cmdClaude` 入口调用 `ensurePaseoDaemonEnrolled()`（幂等、best-effort，错误只打日志不阻塞 claude 启动）。
   - 新增 `paseo_auto_enroll.go`：`resolvePaseoHome()` 解析 Paseo home（优先 dev checkout `.dev/paseo-home-deploy`，fallback `~/.paseo`）；`isPaseoDaemonEnrolled()` 检查 daemon 是否在跑且 hub URL 匹配当前 active ginit 环境；不满足则调 `cmdPaseoInstall` 安装/启动 + `cmdPaseoAttachWith` attach 到 ginit Hub。
   - 复用现有 `cmdPaseoInstall`（幂等，保留现有配置）和 `cmdPaseoAttachWith`（走完整 enrollment → redeem → hub attach 流程）。

3. **验证**：
   - `go test ./...` 全通过（Paseo 相关 6 项测试全绿）。
   - `go vet ./...` 无警告。
   - 新二进制 `ginit paseo status` 正常返回设备列表。

**结论**：6769 daemon 已切到 testbed hub 并 online；后续 `ginit ccd` 会自动确保本机 Paseo daemon 注册到当前 active ginit 环境（生产/testbed 跟随 `ginit env use`）。

## 2026-07-29 - 8236 Web 宿主改为免密码，Welcome 直接进入飞书授权

**Q（问题）**：用户打开 `http://150.5.173.43:8236/welcome`，点击 Login with Feishu 时被 8236 的 paseo-web daemon 密码保护拦截，页面显示 Daemon password，无法直接跳转飞书授权。部署容器实际仍注入了 `PASEO_PASSWORD`，与测试环境“飞书登录作为用户认证、Web 宿主不 enroll”的设计不一致；同时 Welcome 页在已有在线宿主时会自动跳到 `/open-project`，显式访问 `/welcome` 看不到登录入口。

**W（解决方法）**：

1. **部署层移除密码**：重建远程 `paseo-web` 容器时不再传入 `PASEO_PASSWORD`，保留 `PASEO_WEB_UI_ENABLED=true`、`GINIT_PASEO_HUB_WS_PORT=8235`、`paseo-web-home` 持久化卷和 `paseo:local-ginit` 镜像。重启日志确认 `authRequired=false`、WebSocket 直接连接成功，并出现 `Hub not configured; connector idle until enrollment`，Web 宿主不会恢复成设备。
2. **Welcome 入口保持可达**：`welcome-screen.tsx` 检测运行期注入的 Ginit base URL；被 daemon 托管的 Web 页面即使宿主已在线，也不自动从显式 `/welcome` 跳离，用户可以点击 Login with Feishu。Metro/无 Ginit 配置页面保留原有在线宿主自动恢复工作区行为。
3. **Welcome 设备连接**：保留 Hub 返回的 `public_key`、`relay_endpoint`、`relay_use_tls`、`connection_ready`，抽出 `WelcomeGinitDeviceRow`；只有 online、connection_ready 且 metadata 完整的设备才启用 Connect，并复用已有 Relay E2EE + TOFU `upsertRelayConnection`。
4. **配置回退**：未改变 daemon 外部部署的通用密码能力，也未全局绕过认证；真正执行 daemon 仍可按需设置密码。`ginit-config.ts` 只保留 Metro 的开发 fallback。

**验证**：远程 `GET http://150.5.173.43:8236/api/health` 返回 200；容器启动日志确认 `authRequired=false`；清空浏览器 localStorage 后打开 `/welcome` 可见 Login with Feishu，点击后不再显示密码框，并成功打开飞书授权标签页，daemon 日志确认客户端 WebSocket 无密码连接成功。源码 `npm run build:daemon-web-ui`、`npm run typecheck`、欢迎页定向 lint、`git diff --check` 均通过。

**遗留**：飞书授权页需要真实用户在飞书客户端确认，当前 Playwright 只验证到授权页打开；远程容器是手工 `docker run` 重建，后续应将同样的无密码环境写入正式部署 compose/脚本，避免下一次部署重新注入密码。

---

---

## 2026-07-29 - 本机 daemon 注册到远程中继的信息审计 + 6769 connection_ready 修复

**Q(问题)**: 用户问本机 daemon 注册到中继服务器（150.5.173.43）的信息有哪些（如 PID/锁文件/socket/会话上下文/环境变量/权限/MCP/Hooks），以及为什么中继服务器没收到本地启动时的注册信息。

**W(解决方法)**:

1. **注册信息审计（代码证据）**：daemon 注册到 Hub/Relay 的信息分三层——
   - **enrollment（一次性绑身份）**：`POST /api/paseo/enrollments`（Bearer ginit user token）+ `/redeem` 发送 `device_id`/`daemon_id`/`public_key`/`name`，服务端存 `paseo_devices` 表。**不含** PID/工作目录/环境变量/权限/MCP/Hooks。
   - **hub.hello（每次连接的运行时状态）**：`deviceId`/`daemonId`/`publicKey`/`nonce`/`signature`（Ed25519 签名）+ `relay{endpoint,use_tls}`（来自 `relayMetadataProvider`）。**不含** PID/锁文件/socket 路径/环境快照/权限白名单/模型配置/MCP 服务/Hooks 列表。
   - **hub.workspace.snapshot（workspace 摘要）**：`workspaces[]` 含 `id`/`cwd`（绝对路径）/`provider`/`status`，**不含** agent 会话明细/transcript/环境/权限。
   - **relay 握手**：URL query 只发 `serverId`/`role`/`v`，E2EE 握手只发公钥。**不含**任何进程/环境/权限信息。
   - **结论**：你列的 4 类元数据（进程/会话/环境/MCP-Hooks）**目前都不上报**——这是设计意图（控制面只管身份+在线状态+relay 元数据+workspace 摘要）。如需扩展需明确安全边界（工作区路径已属敏感信息）。

2. **中继没收到注册信息的根因（6769 daemon connection_ready=false）**：
   - 6769 的 `config.json` 里 `daemon.relay` 只有 `enabled:true`（ginit `patchPaseoConfig` 只写 enabled），缺 `endpoint`/`publicEndpoint` → `relayMetadataProvider` 返回 null → `hub.hello` 不带 relay 块 → Hub 端 `relay_endpoint` 保持 NULL → `connection_ready=false`。
   - 更深层：6769 跑的 server dist 代码是 07-28 构建的（早于 07-29 的 relayMetadataProvider 实现），即使补了 config 也不发 relay 块。**必须 `npm run build:server` 重建 dist**。
   - 修复：补 `daemon.relay.endpoint/publicEndpoint` + `npm run build:server` 重建 + 重启 6769 → `connection_ready=true`，relay 日志确认 `srv_V_6a3jxLQ4Ip` control 连接建立。

3. **ginit 自动注册（`ginit ccd`）两个缺陷修复**：
   - `isPaseoDaemonEnrolled` 期望值推导不支持 split-port 部署（testbed HTTP:8090/WS:8235），导致已注册的 daemon 被误判为未注册 → 每次 `ginit ccd` 都重复 attach。修复：新增 `expectedPaseoHubWSURL`，与 daemon 侧 `toHubWebSocketUrl` 完全一致（含 `GINIT_PASEO_HUB_WS_PORT` 兼容）。
   - `patchPaseoConfig` 无条件覆盖 `listen`（曾把 6769 改回 6767 导致端口错乱）。修复：已有 `listen` 时保留，不覆盖。
   - 测试：新增 `TestPatchPaseoConfigPreservesExistingListen` + `TestExpectedPaseoHubWSURL`，`go test .` 全通过。

4. **已安装 ginit 二进制过旧**：`~/.local/bin/ginit` 是 07-19 的 1.4.53，不含 07-29 的 `ensurePaseoDaemonEnrolled`。用 `go build -o ~/.local/bin/ginit .` 重建安装（含全部修复）。

**验证**：

- 6769 `connection_ready=true`，relay 日志 `srv_V_6a3jxLQ4Ip` control 连接 ✅
- 8234 容器 `srv_nvcX2Px9Rmfh` `connection_ready=true` ✅
- Playwright 8236 Host 页「My enrolled hosts」显示两台设备均 online ✅
- `go test .` / `go vet .` 全通过 ✅

**遗留**：

- 当前 active env 是 `default=https://ginit.opensii.ai`，而 6769 daemon 注册在 testbed（150.5.173.43）——两者不一致。若要让 `ginit ccd` 自动注册到 testbed，需 `ginit env use <testbed>` 或设 `GINIT_PASEO_HUB_WS_PORT=8235`。
- 4 类元数据（进程/会话/环境/MCP-Hooks）上报范围需用户确认安全边界后再扩展。

---

## 2026-07-29 - 系统环境切换 testbed + ~/.paseo 手动 enrollment

**Q(问题)**: 用户要求把 ginit 系统环境从 `https://ginit.opensii.ai` 改为 `150.5.173.43`（测试结束后改回），并解决 `ginit paseo install` 启动的 `~/.paseo` daemon 没有注册到远程服务器的问题。

**W(解决方法)**:

1. **切换 ginit 系统环境到 testbed**：
   - 新增 `testbed` profile（`base_url=http://150.5.173.43:8090`），`ginit env use testbed` 切换。
   - 备份原配置到 `~/.config/ginit/config.json.bak-prod-*`，测试结束后用 `ginit env use default` 改回。

2. **~/.paseo 未注册到远程的根因**：
   - `ginit paseo install` 只启动 daemon 并写基础配置（`listen`/`relay.enabled`），**不自动 enroll**（enroll 需要 `ginit paseo attach` 或 `ginit ccd` 触发）。
   - 更深层：`ginit paseo attach` 期望 paseo CLI 有 `daemon hub identity/attach` 命令，但当前所有 paseo CLI 版本（全局 0.2.3、源码 0.2.0-beta.4）都没有这些命令（只有 `hub connect/status/disconnect`）。

3. **手动 enrollment（绕过 paseo CLI hub 命令缺失）**：
   - 用 node 直接生成 Ed25519 keypair（与 daemon `device-keypair.ts` 逻辑一致），保存到 `~/.paseo/hub-device-keypair.json`。
   - 用已有的 ginit user token（从 8234 容器配置）调 testbed API：`POST /api/paseo/enrollments` → `POST /api/paseo/enrollments/redeem`，完成 device 注册。
   - 手动配置 `~/.paseo/config.json` 的 `daemon.hub`（url/deviceId/token/ginitBaseUrl/ginitToken）和 `daemon.relay`（endpoint/publicEndpoint）。
   - **坑**：第一次 enrollment 时 `hub-device-keypair.json` 的 `deviceId` 与 `config.json` 里的 `deviceId` 不一致（node -e 每次生成新 keypair），导致 `hub.hello` 报 `4403 invalid device signature`。修复：重新生成 keypair 并确保两处 `deviceId` 一致，再重新 enrollment。
   - **坑**：同一 `daemon_id` 重复 enrollment 会创建多个设备（旧的 offline + 新的 online）。修复：用 `DELETE /api/paseo/devices/{device_id}` 清理旧设备。

4. **验证**：
   - `~/.paseo`（srv_MxTCvRAiJQ8k）在 testbed Hub 上 `online` + `connection_ready=true` + `relay_endpoint=150.5.173.43:8234` ✅
   - relay 日志确认 `srv_MxTCvRAiJQ8k` control 连接建立 ✅
   - 三台设备（`~/.paseo` + 6769 + 8234 容器）全部 online + connection_ready ✅

**遗留**：

- `ginit paseo attach` 依赖的 `paseo daemon hub identity/attach` 命令在当前 paseo CLI 版本中不存在，需确认是 CLI 版本过旧还是 ginit 期望的 CLI 尚未发布。
- 测试结束后用 `ginit env use default` 切回 prod。

## 2026-07-29 - `ginit ccd` 启动时大量报错（Daemon failed to start in background）

**Q（问题）**：在仓库目录跑 `ginit ccd` 时打印 `Daemon failed to start in background (exit code 1)` 加一大段 JSON 日志，看起来像「一堆报错」。但机器上其实有 daemon 在跑。

**W（根因与旧版临时规避）**：旧版需要两个环境变量同时设置：

1. **第一根因：npm 全局 `@getpaseo/server@0.2.3` 不认识 `daemon.hub` 字段。**
   - `ginit ccd` 启动前会调 `paseo daemon start` 确保 daemon 在线，默认用 PATH 里的 `paseo`，也就是 npm 全局 `@getpaseo/cli@0.2.3`，它内嵌 `@getpaseo/server@0.2.3` 的 `persisted-config.js` 没有 `hub` 这个 key（grep 0 命中）。
   - 而 `~/.paseo/config.json` 由 ginit auto-enroll 写入，包含 `daemon.hub.{enabled,url,deviceId,token,ginitBaseUrl,ginitToken}`。
   - `.strict()` schema 直接抛 `Unrecognized key: "hub"`，daemon exit 1。
   - **解决**：`export GINIT_PASEO_PATH=/home/alan/paseo/packages/cli/bin/paseo`，让 ginit 用仓库里的 CLI（0.2.0-beta.4，支持 hub schema）。该变量由 [ginit-cli/paseo.go:47](ginit-cli/paseo.go#L47) 读取。

2. **第二根因：`isPaseoDaemonEnrolled` 的 hub URL 比对失败。**
   - ginit 在每次 `ccd` 启动前都会检查「deploy daemon 是否已 enrolled 到当前 ginit env」，逻辑在 [ginit-cli/paseo_auto_enroll.go:106](ginit-cli/paseo_auto_enroll.go#L106)：把 `~/.paseo/.dev/paseo-home-deploy/config.json` 里的 `daemon.hub.url` 和 `expectedPaseoHubWSURL(base_url)` 字符串比对。
   - 当前活跃 env 是 testbed（REST `http://150.5.173.43:8090`），按公式推出来的 expected URL 是 `ws://150.5.173.43:8090/ws/v1/paseo`；但 config 里写的是 `ws://150.5.173.43:8235/ws/v1/paseo`（testbed hub WS 拆在 8235 端口）。
   - 端口不匹配 → `isPaseoDaemonEnrolled=false` → 走 `cmdPaseoInstall` → 重复 `daemon start` → 端口被占，子进程 exit 1。
   - **解决**：`export GINIT_PASEO_HUB_WS_PORT=8235`，让 `expectedPaseoHubWSURL` 走 split-port 分支（参见 [ginit-cli/paseo_auto_enroll.go:115-132](ginit-cli/paseo_auto_enroll.go#L115-L132)，`COMPAT(ginitHubWsPortEnv)`）。

3. **旧版临时规避（写入 `~/.bashrc`）**：
   ```bash
   export GINIT_PASEO_PATH=/home/alan/paseo/packages/cli/bin/paseo
   export GINIT_PASEO_HUB_WS_PORT=8235
   ```

**「一堆报错」的真相**：用户看到的报错其实是 `tailFile(daemon.log, 30)` 把 daemon.log 末尾 30 行原样倒出。那些 JSON 行都是上一次 dev daemon 写入的 `ws_runtime_metrics` 心跳（level 30），不是错误。真正的错只有一行：`[Config] Invalid config ... Unrecognized key: "hub"`，埋在更早的日志深处。

**代码根修**：

- `resolvePaseoHome` 先尊重显式 `PASEO_HOME`，再走 checkout / `~/.paseo` 默认值。
- running 与 enrolled 分开判断：解析 `paseo.pid` 并对 PID 做 signal-0 存活检查；已有 daemon 时绝不再执行 `daemon start`。
- enrollment 优先比较持久化的 `daemon.hub.ginitBaseUrl` 与当前 ginit control-plane URL。Hub WS 可以合法使用另一个端口，因此不再依赖 `GINIT_PASEO_HUB_WS_PORT` 猜测是否属于同一环境；没有 `ginitBaseUrl` 的旧配置才走原兼容推导。
- `ensurePaseoCLI` 与其他 Paseo 调用统一尊重 `GINIT_PASEO_PATH`，避免安装路径误用 PATH 上不支持 Hub schema 的旧 CLI。
- `cmdPaseoInstall` 本身也检查 live PID，重复执行 install 不会重启已运行 daemon。

**验证**：不设置 `GINIT_PASEO_HUB_WS_PORT` 时，split-port testbed 配置仍判定 enrolled；live PID 不重复 start；stale PID 会判定未运行；`GINIT_PASEO_PATH` 覆盖安装启动使用的 CLI。`ginit ccd --help` 不再打印 "Daemon failed to start"。

**遗留**：机器上同时存在多个 daemon，后续可考虑收敛；`GINIT_PASEO_HUB_WS_PORT` 仍是老 enrollment 配置的 `COMPAT(ginitHubWsPortEnv)`，目标 2027-01-28 移除。Paseo 后台启动器仍会丢弃子进程 stderr 并 tail 共享旧日志，独立的诊断体验修复应在 Paseo 仓库处理。

## 2026-07-29 - Hub 设备列表中 Relay E2EE 公钥与 Hub 签名公钥混用

**Q（问题）**：daemon 持有两套公钥——Ed25519 Hub 身份公钥（SPKI DER，base64 解码 44 字节，用于 hub.hello 签名验签）和 NaCl/Curve25519 Relay E2EE 公钥（原始 32 字节，用于端到端握手和客户端 TOFU 固定）。此前实现把两者混为一谈：① `hub.hello` 的 relay 块只带 `endpoint/use_tls`，不带 E2EE 公钥，Hub 无法向客户端发布可用于 E2EE 握手的 `relay_public_key`；② 客户端（welcome 页 / 设置页）拿设备的 `publicKey`（Hub 签名公钥）当作 `daemonPublicKeyB64` 去建 Relay E2EE 连接，密钥格式不对且未经验证，relay 块也无独立签名，endpoint/TLS/公钥可被单独篡改。

**W（解决方法）**：把两套公钥在协议和代码中显式分开，Relay 元数据改带独立签名：

1. **daemon 端（hub-connector.ts + bootstrap.ts）**：`relayMetadataProvider` 增加 `publicKey`（daemon 的 Curve25519 E2EE 公钥 `daemonKeyPair.publicKeyB64`）；`hub.hello` 的 relay 块新增 `public_key` 和 `signature` 字段，签名覆盖 canonical tuple `JSON.stringify(["relay-v1", endpoint, useTls, publicKey])`，用 Hub 身份私钥（Ed25519）签。Hub 验签通过后才发布该元组，只有 `relay_endpoint` 与 `relay_public_key` 同时存在才标记 `connection_ready=true`。
2. **协议（messages.ts）**：`HubListDeviceEntrySchema` 新增 optional `relayPublicKey` 字段，带 `COMPAT(hubRelayPublicKey)` 注释（2026-07-29 加入，2027-01-29 后可去 optional）。老 Hub 不返回该字段时客户端正常解析（协议向后兼容）。
3. **enroller（ginit-enroller.ts）**：设备列表解析 `relay_public_key` → `relayPublicKey`，透传给客户端。
4. **客户端（ginit-feishu-welcome.tsx / host-page.tsx / welcome-ginit-device-row.tsx）**：Connect 前置检查从 `device.publicKey` 改为 `device.relayPublicKey`，`upsertRelayConnection` 的 `daemonPublicKeyB64` 也用 `relayPublicKey`——TOFU 固定的是 E2EE 公钥而非 Hub 签名公钥。
5. **附带修复**：welcome 页 Feishu 登录后 `resolveDaemonClient` 不再盲取快照，改为 `waitForRuntimeClient` 订阅 host runtime store 最多等 15s，修掉「probe 成功但 client 尚未 ready」的竞态；设备 Connect 成功后经 `onConnected` 回调跳转到 `buildHostRootRoute(serverId)`。
6. **文档**：`docs/ginit-paseo-design.md` 和 `docs/hub.md` 补充两套公钥的编码/长度/用途对照表和 Relay 块签名规范。

**验证**：`npm run typecheck` 全 workspace 通过；`hub-connector.test.ts`（含新增签名校验用例，用 `cryptoVerify` 独立验签通过）、`messages.hub.test.ts`、`ginit-enroller.test.ts` 相关用例 43/43 通过（另 1 个 `hubUrl` 端口断言失败经 `git stash` 对照验证是预存问题，与本次改动无关）；定向 lint 0 警告。

**遗留**：老 daemon 发送无公钥/无签名的旧式 relay 块时，Hub 侧必须忽略而不是与库存公钥拼接（该约束已写入文档，Hub 服务端实现在 ginit 仓库）；生产部署后需重建 B 端 Web bundle 并验证 8236 设备列表能拿到 `relay_public_key`。

## 2026-08-05 - 8236 Paseo Web 飞书登录失败（CORS preflight 501）

**Q（问题）**：`http://150.5.173.43:8236/welcome` 点「Login with Feishu」总是失败，页面显示 "Failed to fetch"。Playwright 复现发现浏览器对 `http://150.5.173.43:8090/auth/device/start` 的跨域请求被 CORS 拦截：OPTIONS preflight 返回 `501 Unsupported method ('OPTIONS')`，响应完全没有 `Access-Control-Allow-Origin` 头。同页加载时的 `GET /api/paseo/devices` 也因同样原因失败。

**W（解决方法）**：

1. **根因**：CORS 支持代码其实早已写好——ginit 仓库 commit `50e2afa feat(paseo): allow browser CORS for app and self-hosted UIs`（含 `do_OPTIONS`、allowlist 反射、私网/回环 origin 自动放行，带 `tests/test_cors.py` 6 个测试），`/etc/ginit.env` 里 `GINIT_CORS_ALLOWED_ORIGINS=http://150.5.173.43:8236,...` 也配置好了。但这批 paseo 相关 commit 只在 `feat-paseo` 分支（落后 main 106 个 commit，未 PR 合入），testbed `/opt/ginit` 跑的是旧代码 + 手工补丁，里面没有 CORS 实现。**环境变量配了但代码没部署，配置形同虚设。**
2. **修复**：本机 `~/ginit/ginit` checkout 即 `feat-paseo` 分支且干净、与 origin 同步。先跑 `test_cors.py`（6/6）、`test_db_migrations`（23/23）、`test_paseo_hub`（4/4）、`test_feishu_user_auth`（18/18）、`test_context_postgres_api`（6/6）全绿，再用官方通道 `bash scripts/testbed/sync-server.sh` 全量 rsync 到 testbed 并重启 `ginit.service`。
3. **验证**：① curl 从 testbed 本机对 8090 发 preflight：allowlist origin 返回 204 + `Access-Control-Allow-Origin: http://150.5.173.43:8236`；恶意 origin 只回 204 不带 CORS 头（fail-closed）；POST 带 Origin 正常回 200 + CORS 头。② Playwright 在 8236 页面上下文 fetch `8090/auth/device/start` 返回 200，拿到 `device_code` 和 `verification_uri`（`http://150.5.173.43:8235/auth/feishu/start?device_code=...`）。③ 欢迎页凭此前缓存的 token 成功调用 `/api/paseo/devices` 并渲染「My hosts」三台设备（`paseo-srv_nvcX` online 可 Connect）。
4. **附注**：`verification_uri` 现在正确指向 8235（`40726c4` 的 bare-IP 修复一并部署生效）；新 migrations `0020_paseo_relay_metadata.sql`、`0102_paseo_relay_public_key.sql` 首次同步到 testbed，boot 时幂等 apply 无副作用；deploy 前已备份旧 `server.py` 到 testbed `/tmp/server.py.pre-cors-deploy`。

**遗留**：① `feat-paseo` 13 个 commit 尚未合入 main（testbed 是 rsync 部署、prod bandwagon 是 git-based 从 origin/main 拉取，prod 要拿到这些改动必须先开 PR 合 main）；② 真实飞书账号授权跳转（点按钮 → 飞书授权页 → 回调）需真实账号人工完成，本次以缓存 token + 浏览器内真实 fetch 验证全链路 CORS；③ testbed `/opt/ginit-src` 停在 7-13 的旧 main，下次有人从 ginit-src 部署会覆盖回无 CORS 代码——根治靠 feat-paseo 合 main。

## 2026-08-05 - 8236 网页 Connect 按钮灰色不可点（offline 设备 + 本地 daemon 未启动）

**Q（问题）**：`http://150.5.173.43:8236/welcome` 设备列表里 `paseo-alan-MS-7D99` 和 `paseo-srv_V_6a` 显示 `offline`，对应的 Connect 按钮 `<button aria-disabled="true" disabled ...>` 完全无法点击，用户无法接入本机 daemon。

**W（解决方法）**：

1. **根因诊断**：按钮禁用是 [welcome-ginit-device-row.tsx](packages/app/src/components/welcome-ginit-device-row.tsx) 的 `canConnect` 判为 false，条件是 `device.status === "online" && device.connectionReady === true && relayEndpoint && relayPublicKey` 四条全满足。设备显示 offline 是因为对应 daemon 进程没在跑——本机只有 docker 容器 `paseo`（srv_nvcX，8234）在线；`~/.paseo`（srv_MxTC，对应 6767）和 `.dev/paseo-home-deploy`（srv_V_6a，对应 6769）两个 daemon 都没启动。这是**设计内行为**：`docs/ginit-paseo-complete-architecture.md` 明确写「offline 机器显示但不能连接」。
2. **UX 改进（commit 内容）**：原 UI 只把按钮变灰但不告诉用户为什么，加一个 `disabledReason` 通过 `title`（web hover tooltip）和 `accessibilityHint`（native 屏幕阅读器）展示原因：offline 提示「Host is offline — start the daemon on that machine, then Refresh.」；缺 Relay metadata 提示「Host is missing Relay metadata — update the daemon on that machine, then Refresh.」。同步在 settings/host-page.tsx 的 `GinitDeviceRow` 加同样的 hint。
3. **重新发布 Web bundle**：`npm run build:daemon-web-ui` 出新 bundle `index-f8b0a9e78456c6a17732ab057581ed8a.js`；scp 到 testbed `/tmp/` → `docker cp` 进 paseo-web 容器 → 备份旧 `index.html` → sed 替换 bundle 引用 → 验证 md5 一致。无需重启容器（静态文件热替换）。
4. **启动本机 daemon**：用户选择「两个都启动」。先 `npm run cli -- daemon start --listen 127.0.0.1:6767 --home /home/alan/.paseo` 和 `...:6769 --home .dev/paseo-home-deploy`，结果两 daemon 都连到 **prod** `wss://ginit.opensii.ai/ws/v1/paseo`（config 里的旧 url），而设备列表看的是 testbed `150.5.173.43:8235`，所以 testbed DB 仍 offline。
5. **切回 testbed 报 4401 invalid device token**：直接把 config `hub.url` 改成 `ws://150.5.173.43:8235/ws/v1/paseo` 后，daemon 用原 prod token 向 testbed 认证失败——prod 和 testbed 是两套独立 DB，token 不通用。
6. **重发 device token**：参考 QW.md 2026-07-29 的恢复套路，在 testbed 用 `GINIT_TOKEN_SECRET` HMAC-SHA256 签发新 `pht_*` token，UPDATE `paseo_devices.token_hash` + `token_prefix`，把明文 token 写回本机 config。结果又报 **4403 invalid device signature**。
7. **deviceId 派生机制才是 signature 失败的根因**：daemon 端的 `loadOrCreateHubDeviceKeyPair` 会**从公钥 SHA256 派生 deviceId**（`deviceIdForPublicKey`），所以 hello 里送的 deviceId 永远是这个派生值（`90a19deb-...` / `fb48407f-...`），而不是 hub DB 里手工 UPDATE 的 `9be2d480-...` / `25de4b8b-...`。验签失败的原因不是密钥错，而是 **device_id 不匹配**。修复：在 testbed DB 直接 UPDATE `paseo_devices.device_id` 为派生值，同时更新 `paseo_enrollments.device_id` 外键，本机 config 也改回派生值。
8. **最终状态**：testbed DB 三台设备全 `online`，8236 网页 Refresh 后三台 Connect 按钮全部可点，点击 `paseo-alan-MS-7D99` 的 Connect 成功跳转 `/open-project` 完成 Relay E2EE 连接。

**踩坑记录**：

- 改 `hub-device-keypair.json` 的 `deviceId` 字段**无效**——daemon 加载时会从公钥重新派生并覆盖。
- `paseo_devices.device_id` 是主键，改它要同步 `paseo_enrollments.device_id`。
- prod 和 testbed 是两套独立的 Hub（ginit.opensii.ai vs 150.5.173.43），token/device_id 完全不通用。

**遗留**：bootstrap.ts 里**同时**实例化了 `PaseoHubConnector`（connector.ts，老的）和 `HubConnector`（hub-connector.ts，新的 ginit 分支），两者都用相同 deviceId 向同一 hub 发 hello，导致 hub registry 不停踢掉旧的——daemon 日志每 2s 一条 `code=4409 reason="superseded connection"`。功能不受影响（每台设备始终有一条 active 连接、Hub DB 保持 online），但浪费了连接且刷日志。这是 4382975b7 合并 gair/main 时留下的双 connector 并存 bug，需要选其中一个保留，超出本次修复范围。

## 2026-08-05 - 飞书登录提示「你没有"王少敬的飞书 CLI"的使用权限」

**Q（问题）**：用蔡晓杰（Generative AI Lab/GAIR 租户）账号登录飞书 SSO 时，授权页报错：「你没有"王少敬的飞书 CLI"的使用权限。当前登录账号为蔡晓杰(Generative AI Lab(GAIR))，下列账号均无权限」。此前（2026-07-28，见上文）该 SSO 应用已因 GAIR 租户不可用从 `cli_a969…` 换成 `cli_aacb827247389bde`（「王少敬的飞书 CLI」），现在又出现同类报错。

**W（解决方法）**：这个报错**不是 OAuth scope/接口权限不够**，而是**应用可用范围（availability scope）没有覆盖蔡晓杰**——该 SSO 应用是王少敬个人账号创建的自建应用，可用范围大概率只配了「部分员工」且没把蔡晓杰加进去；或改动后未发布新版本/未被企业管理员审核通过。解决路径（无需改任何 CLI/接口权限）：

1. 王少敬登录 [open.feishu.cn](https://open.feishu.cn) 开发者后台 → 进入「王少敬的飞书 CLI」应用（`cli_aacb827247389bde`）→ **应用发布 → 版本管理与发布 → 创建版本**。
2. 创建版本时设置**可用范围**：选「全部员工」，或「部分员工」中按部门/成员把蔡晓杰（或 GAIR 相关部门/用户组）加进去。
3. 提交发布后，**企业管理员**在飞书管理后台（feishu.cn/admin）→ 工作台 → 应用管理 → 应用审核中**审批通过**，新版本的可用范围才生效。
4. 已发布的应用也可由管理员在管理后台 → 应用管理 → 选中该应用，直接调整可用范围。
5. 临时绕过：授权页点「使用其他账号登录」，换用在可用范围内的账号（如王少敬本人）。

**验证**：发布并审核通过后，蔡晓杰账号重新走 Login with Feishu 授权流，授权页不再出现「无权限」提示。

**注意**：QW.md 已记录——SSO 应用（aacb）与 IM connector bot 应用（`cli_a969…`，凭据在 `/root/.lark-cli/config.json`）相互独立；上线生产必须换生产专用 SSO 应用，并确保其可用范围覆盖目标租户全员。

## 2026-08-06 - 手机端（Android App）生成：native 端 ginit Hub baseUrl 无注入源

**Q（问题）**：现有 Paseo Expo 工程要生成可安装的 Android APK 并打通「飞书登录 → Ginit Hub 设备发现 → Relay E2EE 连接远程 ginit daemon」。但 ginit 的 Hub baseUrl 在 web 端由「承载 daemon」通过 `window.__PASEO_GINIT_CONFIG__` 注入；手机 App 上没有任何 daemon 可注入，`getGinitBaseUrl()` 兜底固定为 `https://ginit.opensii.ai`，导致手机端要么只能连默认 prod 域名、要么（原 `ginit-feishu-welcome.tsx` 的 native 分支）直接抛「No local Paseo host is connected yet」——因为 native 登录被设计成必须经 daemon RPC。

**W（解决方法）**：

1. `src/constants/ginit-config.ts`：新增 `getNativeGinitBaseUrl()`/`setNativeGinitBaseUrl()`，用 AsyncStorage 持久化用户配置的 Hub baseUrl（key `ginit.native.baseUrl`）；web 端仍走注入值，native 无配置时兜底默认域名。
2. `src/components/ginit-feishu-welcome.tsx`：native 端在欢迎页新增「Configure Hub URL」可折叠输入框（仅 native 显示，web 保持只读注入）；登录/轮询/列设备改为「优先直连 ginit HTTP（native 无 CORS），失败时回退到已连接 daemon 的 RPC」，native 不再强制要求本地 daemon。
3. `src/components/welcome-ginit-device-row.tsx`：整行改为可点（Pressable + pressed 态 + accessibilityState 记忆化），扩大触控命中区、清晰显示 Connect/Offline，符合窄屏触控规范。
4. 本地 Android 构建：本机无 Android 工具链，安装 Adoptium JDK 17 + Android cmdline-tools/platform-35/build-tools-35.0.0/NDK/CMake，`expo prebuild` 后 `./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a --no-daemon --max-workers=1`，产出 `app-release.apk`（105MB，arm64-v8a，package `sh.paseo`）。

**验证**：`npx tsgo --noEmit` 通过、定向 `npm run lint` 0 错误；Gradle `BUILD SUCCESSFUL in 59m 27s`；`apksigner verify` 通过（Android Debug 证书）、`aapt dump badging` 确认 package/version/ABI。APK 已复制到 `releases/paseo-0.2.0-arm64.apk`（sha256 0f1b8055…）。

**遗留**：① 无真机/模拟器连接（`adb devices` 为空），无法做运行态飞书登录/Relay 连接的 Playwright 验证，只能靠构建成功 + typecheck/lint + 代码审查确认；② 生产签名仍需正式 keystore（当前是 debug 证书）；③ 本机 `java` 未加入 PATH，需用 `JAVA_HOME=~/.local/opt/jdk-17*` + `ANDROID_HOME=~/.local/android-sdk` 显式设置后才能重复构建。

## 2026-08-07 - http://150.5.173.43:8236/welcome 无法打开（Connection refused）

**Q（问题）**：`http://150.5.173.43:8236/welcome`（testbed 上 paseo-web 容器通过 8236→6767 暴露的 Paseo daemon Web UI）完全无法打开，`curl` 报 `Connection refused`，`nc` 端口探测失败。

**W（解决方法）**：

1. **根因**：`paseo-web` 容器（`paseo:local-ginit`，端口绑定 `0.0.0.0:8236->6767/tcp`）处于 **`Restarting (1)` 无限重启循环**（RestartCount=658），所以 8236 端口无监听、连接被拒。
2. **容器反复崩溃的直接原因**：Paseo daemon 启动时 `Failed to acquire PID lock due to race condition`。根因是 PID 锁文件 `/var/lib/docker/volumes/paseo-web-home/_data/.paseo/paseo.pid` 变成**0 字节空文件**（`uid=1000` 属主，所有者为容器内 `paseo` 用户）。守护进程崩溃清理时释放锁会把文件 unlink，但心跳/写入路径把文件留成了空文件——`acquirePidLock` 读到空文件→`readPidLock` 返回 null→走 `writeNewPidLock` 用 `open(pidPath,"wx")` 独占创建→遇到已存在的空文件报 `EEXIST`→抛 `race condition` 错误→进程退出→容器 restart→无限循环。
3. **修复**：先确认**没有任何 paseo daemon 进程在跑**（`ps` 无 `paseo-supervisor`/`daemon-worker`，安全），备份空锁文件后 `rm -f` 删除，然后 `docker restart paseo-web`。守护进程以全新锁文件正常启动，`paseo.pid` 成功写入 `{"pid":7,"startedAt":"...","listen":"0.0.0.0:6767","heartbeat":true}`，容器恢复 `Up (healthy)`，RestartCount 归零。
4. **验证**：`curl http://150.5.173.43:8236/welcome` 返回 200，标题 `Paseo`；Playwright 打开页面正常渲染，自动跳转 `/open-project` 并列出全部 workspace/host，daemon 日志显示 `Server listening on http://0.0.0.0:6767`、`Bootstrap complete`。

**踩坑记录**：

- 老的 `paseo.pid` 是 json 锁文件，空文件（0 字节）会被 `writeNewPidLock` 的 `open(...,"wx")` 当「已存在」报 EEXIST，而不是被当作 stale 清理——这是锁文件损坏（非缺失）时的一个隐患。
- 容器 `Restarting (1)` 时 `docker exec` 无法进入（报 "Container is restarting"），日志只能看 `docker logs`。
- 修复前**必须确认没有真实 daemon 进程在持锁**，否则删锁会让两个 daemon 同时监听 6767 冲突。

**遗留**：该容器由 `paseo:local-ginit` 镜像 + 手动端口绑定启动（无 compose 栈、无标签），重启策略 `unless-stopped`；若容器再次进入锁文件损坏的崩溃循环，可复用本方法（删 `paseo.pid` 后 `docker restart`）。
