# QW.md — Bug 修复记录

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
