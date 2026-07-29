# Ginit + Paseo 设计一致性修复执行记录

## 用户要求

基于 `ginit-paseo-llm-task-brief.md` 逐步检查并修复。每执行 20 轮，下一步操作前必须重新阅读本文件。

## 当前进度

- [x] 阅读 brief、设计文档、QW.md 和关键源码
- [x] 设置页 Web 宿主登录强制 `cacheOnly`
- [x] Hub 设备列表透传 Relay endpoint、TLS、公钥、connection_ready（新增字段 optional）
- [x] 设置页设备选择改为 Relay E2EE + TOFU，并拒绝不可连接设备
- [ ] 欢迎页设备选择改为 Relay E2EE + TOFU
- [ ] 收紧运行期 endpoint 缺失行为
- [ ] Playwright 验证
- [x] 更新 QW.md
- [ ] 更新 summery.md
- [ ] git commit && git push

## 已验证

- `npm run typecheck` 通过
- 修改文件 lint 通过
- Hub/protocol 定向测试 36/36 通过
- `git diff --check` 通过

## 轮次

当前轮次：31
上次强制重读：第 20 轮前已重读
下次强制重读：第 40 轮前

## 设计边界

- Web 宿主只能缓存用户 token，不能产生设备身份
- 设备连接必须使用 Hub metadata，不得用手工地址模拟新功能 fallback
- 缺 Relay metadata、offline 或 connection_ready=false 的设备不可连接
- 协议新增字段必须 optional，兼容旧客户端和旧 Hub

## 变更文件

- `packages/app/src/screens/settings/host-page.tsx`
- `packages/server/src/server/hub/ginit-enroller.ts`
- `packages/protocol/src/messages.ts`
- `QW.md`
- `ginit-paseo-fix-progress.md`

## 变更记录

- 1-3：建立记录并修复设置页 cacheOnly
- 4-6：确认本地 Ginit Hub 已返回 Relay metadata
- 7-11：Paseo server/protocol 透传 Relay metadata
- 12-16：设置页用 `upsertRelayConnection`，增加状态门禁
- 17-19：格式化、typecheck、lint、定向测试通过
- 20：强制重读本文件
- 21-23：兼容 SQLite relay_use_tls 的 0/1
- 24：恢复一次误用大范围替换造成的设置页损坏
- 25-29：重新应用小范围修改并通过验证
- 30：恢复欢迎页到未修改状态，避免扩大未验证改动
- 31：更新 QW，记录已完成修复和遗留事项
