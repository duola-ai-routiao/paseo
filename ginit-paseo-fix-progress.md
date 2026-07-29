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
- [ ] 重新构建并核对部署镜像和 Web bundle
- [ ] 更新 summery.md
- [ ] git commit && git push

## 已验证

- 上一阶段 `npm run typecheck` 通过
- 上一阶段修改文件 lint 通过
- Hub/protocol 定向测试 36/36 通过
- `git diff --check` 通过
- 本轮欢迎页尝试曾触发重复插入和未稳定 lint，已完整恢复欢迎页与 endpoint 配置文件，未保留这些未验证改动

## 轮次

当前轮次：40
上次强制重读：第 40 轮前已重新阅读本文件
下次强制重读：第 60 轮前，下一步操作前必须先重新阅读本文件

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
- `summery.md`
- `ginit-paseo-fix-progress.md`

## 变更记录

- 1-31：完成首轮身份边界、设备 metadata、设置页 Relay/TOFU 修复并推送
- 32-39：尝试在欢迎页接入 Relay metadata 和连接按钮，但因重复编辑风险未保留；恢复到上一稳定提交状态
- 40：按用户要求重新阅读本文件，修正进度记录，下一步必须从小范围、可回滚修改开始

## 待验证

- 欢迎页 Relay 连接：应优先抽出独立纯函数/组件，避免大范围替换
- endpoint fallback 策略：先增加测试，再修改调用点
- Playwright 干净浏览器真实链路
- 构建产物和部署镜像一致性
