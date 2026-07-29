# Ginit + Paseo 设计一致性修复执行记录

## 用户要求

基于 `ginit-paseo-llm-task-brief.md` 逐步检查并修复。每执行 20 轮，下一步操作前必须重新阅读本文件。

## 当前进度

- [x] 阅读 brief、设计文档、QW.md 和关键源码
- [x] 设置页 Web 宿主登录强制 `cacheOnly`
- [x] Hub 设备列表透传 Relay endpoint、TLS、公钥、connection_ready（新增字段 optional）
- [x] 设置页设备选择改为 Relay E2EE + TOFU，并拒绝不可连接设备
- [x] 欢迎页设备选择接入 Relay E2EE + TOFU
- [x] 8236 Web 宿主移除 daemon 密码，Welcome 直接显示飞书登录
- [ ] Playwright 完整飞书授权与设备连接验证
- [x] 重新构建并核对本地 Web bundle
- [x] 更新 QW.md
- [x] 更新 summery.md
- [ ] git commit && git push

## 已验证

- `npm run build:daemon-web-ui` 通过
- `npm run typecheck` 通过
- 欢迎页与 endpoint 配置定向 lint 通过
- `git diff --check` 通过
- 8236 `/api/health` 返回 200
- 8236 容器启动日志确认 `authRequired=false`
- 清空浏览器存储后 `/welcome` 显示 Login with Feishu；点击后不再显示密码输入框，daemon 日志确认无密码 WebSocket 连接成功

## 轮次

当前轮次：41
上次强制重读：第 40 轮前已重新阅读本文件
下次强制重读：第 60 轮前，下一步操作前必须先重新阅读本文件

## 设计边界

- Web 宿主只能缓存用户 token，不能产生设备身份
- 设备连接必须使用 Hub metadata，不得用手工地址模拟新功能 fallback
- 缺 Relay metadata、offline 或 connection_ready=false 的设备不可连接
- 协议新增字段必须 optional，兼容旧客户端和旧 Hub
- 免密码只适用于 8236 Web 宿主；真正执行 daemon 仍可使用密码和 Relay E2EE

## 变更文件

- `packages/app/src/components/ginit-feishu-welcome.tsx`
- `packages/app/src/components/welcome-ginit-device-row.tsx`
- `packages/app/src/components/welcome-screen.tsx`
- `packages/app/src/constants/ginit-config.ts`
- `QW.md`
- `summery.md`
- `ginit-paseo-fix-progress.md`

## 变更记录

- 1-31：完成首轮身份边界、设备 metadata、设置页 Relay/TOFU 修复并推送
- 32-40：复核欢迎页 Relay 改动边界并重新阅读进度文件
- 41：移除远程 paseo-web 的 `PASEO_PASSWORD`，Welcome 部署页保留飞书登录入口；补齐欢迎页 Relay metadata 和连接按钮，完成构建与免密 Playwright 验证

## 待验证

- 真实飞书授权确认后设备列表加载
- 点击设备 Connect 后真实浏览器 Relay E2EE/TOFU 落 HostProfile
- 将远程无密码配置写入正式部署 compose，避免手工重建后丢失
