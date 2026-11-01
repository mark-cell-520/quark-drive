# QuarkDrive 安全审计报告

> 审计日期：2026-11-02 · 范围：全部核心代码 + Electron 外壳 + 安装器脚本
> 方法：独立审查代理（全新上下文、可复现 harness 实证）+ 维护者自查 + 静态扫描 + `npm audit`
> 结果：**18 项发现全部修复，157 项测试全绿，真实挂载冒烟通过**

---

## 1. 审计方法

| 手段 | 覆盖 |
|---|---|
| 独立审查子代理 | 14 个源文件全量阅读，10 个可运行 harness 实证每个发现（仅 Quark API/OSS/CDN 用 fake） |
| 静态扫描 | 硬编码密钥、eval/exec、innerHTML、命令注入模式 |
| `npm audit` | 生产依赖 **0 漏洞**；开发依赖（electron-builder 工具链）15 moderate，仅构建期存在，不随应用分发 |
| 真实环境验证 | 本机安装 WinFsp + rclone v1.75.2，`Q:` 盘符挂载/列表/读/写/建目录/卸载全通过 |
| 打包验证 | asar 内容抽检（无测试泄漏、无 vendor 二进制入包、无机密文件） |

**已验证正确的方面（不再重复工作）：** 路径穿越防护（原始 socket 级）、Range 解析边界、rclone spawn 无注入、QR 令牌脱敏、Electron/preload/renderer 加固、会话存储 0600、客户端中断不崩进程。

---

## 2. 发现与修复清单

### CRITICAL

#### F-1 MOVE 先删目标再移动；自移动销毁文件（数据丢失）
- **位置**：`core/webdav/server.js` `handleMove`
- **复现**：`MOVE /a.txt → /a.txt` → 服务端先 `api.remove(['f1'])` 再移动失败，客户端收到 409 但云端文件已删除。
- **修复**：`handleMove` 不再预删除；`dest === src` 直接 403；替换语义交由 `QuarkFs.move` 的**三步安全替换**（移至临时名 → 删旧 → 改名，带 3 次重试，失败时文件保留在临时名下可恢复）。
- **回归**：`tests/unit/audit-findings.test.js` F-1 ×3

### HIGH

#### F-2 下载请求把会话 Cookie 发到 CDN 主机
- **位置**：`core/webdav/quark-fs.js` `createReadStream`
- **复现**：fetch 替身证实 `Cookie: __puus=…` 发往 API 下发的 `download_url`（CDN 主机）。
- **修复**：下载请求加 `noCookie: true`（URL 已预签名）；同时补上 30 分钟兜底超时与客户端断连时的上游 abort（F-12）。
- **回归**：audit-findings F-2

#### F-3 WebDAV 服务无鉴权、无 Host 校验
- **位置**：`core/webdav/server.js`
- **风险**：回路环口在 Windows 上不区分用户会话，同机其他进程可读写整个网盘；浏览器 DNS rebinding 可达。
- **修复**：每次运行生成 24 字节随机 URL 前缀令牌（`server.urlPrefix`，rclone remote 携带）+ `Host` 必须是 `127.0.0.1/localhost/::1`（否则 421）。
- **回归**：audit-findings F-3 ×2

#### F-4 PUT/MOVE 可创建含控制字符/`..`/`\` 的文件名 → 畸形 XML
- **位置**：`core/webdav/quark-fs.js` `writeFile`/`move` 未调用 `assertValidName`
- **复现**：`PUT /a%01b` → 201，文件名 `a\x01b`；`PUT /%2e%2e` → 201，文件名 `..`；PROPFIND 207 体含原始控制字符 → XML 1.0 非法。
- **修复**：`writeFile` 与 `move` 的目标名都过 `assertValidName`（拒绝分隔符/`.`/`..`/控制字符）；`escapeXml` 剥离 XML 1.0 非法字符（存量脏数据也不会产生畸形 XML）。
- **回归**：audit-findings F-4 ×3

### MEDIUM

#### F-5 目录可移入自身子树；rename+move 非原子
- **修复**：`dst === src` 或 `dst.startsWith(src + '/')` → 403；改为**先移动后重命名**（重命名失败只会留在正确目录下用旧名字，不会错位）。
- **回归**：audit-findings F-5

#### F-6 荒谬时间戳让整个目录 PROPFIND 500
- **复现**：`toDate(1e20)` → Invalid Date → `toISOString()` 抛 RangeError → 整目录 500。
- **修复**：`toDate` 加有限性/范围钳制，回落 epoch。
- **回归**：audit-findings F-6

#### F-7 渲染层可设 `rclonePath` → RCE 放大器
- **修复**：`rclonePath` 移出 `SETTINGS_WHITELIST`（仅环境变量/CLI 可用）。
- **回归**：audit-regressions A-05

#### F-8 目录缓存无上界增长
- **修复**：`listFid` 增加 LRU 上限（512 目录）+ 过期清扫。

#### F-9 vendor 二进制无哈希校验（注释谎称有）
- **修复**：`fetch-vendor.mjs` 固化 rclone.exe（v1.75.2）与 winfsp.msi（2.1.25156）的 SHA256，**缺失 pin 即失败**，磁盘存量也要验证（STALE 重下）。
- **回归**：audit-findings F-9

#### F-10 并发 PUT 同路径 → 重复文件/丢失删除
- **修复**：按规范化路径串行化写入（`_writeLocks`）；上传后**重新拉取列表**确认旧 fid 仍在才删。
- **回归**：audit-regressions A-02（含同 fid 秒传保护）

### LOW

#### F-11 扁平 cookie 罐摄入任意主机 Cookie
- **修复**：仅 `pan/drive-pc/uop.quark.cn` 等 API 主机的 Set-Cookie 入罐（`ingestFrom` + `COOKIE_HOSTS` 白名单）。
- **回归**：audit-findings F-11 ×2

#### F-12 下载无超时、上游 socket 泄漏
- **修复**：30 分钟兜底超时 + `res.on('close')` 时 abort 上游 fetch。
- **回归**：随 F-2 覆盖

#### F-13 chunked PUT 缓冲 2 GiB 内存
- **修复**：默认上限降至 **256 MiB**（可配置），超限 413 且先响应后断连。
- **回归**：audit-regressions A-01

#### F-14 密钥脱敏机制是死代码
- **修复**：`buildStack` 注册会话 Cookie 头为秘密；`auth.start()` 每次签发二维码令牌即注册。
- **回归**：audit-findings F-14

#### F-15 内部错误文本回显给客户端
- **修复**：PUT/MKCOL/DELETE/MOVE 失败只回通用文案（`upload failed` 等），细节仅进日志。
- **回归**：webdav 集成测试错误路径

#### F-16 托盘 `app.exit(0)` 遗留 rclone 进程
- **修复**：托盘退出与 `before-quit` 都先卸载（RC 优雅卸载，刷新 VFS 待传队列）再退出。

#### F-17 `Sha1Ctx.exportState` 丢弃挂起字节（潜在 Hash-Ctx 损坏）
- **修复**：导出真实 `data`（挂起字节 hex）与 `num`（计数）。
- **回归**：sha1ctx 测试（含块对齐用例）

#### F-18 Range 与上游长度不一致可能截断读取
- **修复**：Content-Length/Content-Range 以**上游实际返回**为准；上游未按 Range 返回时降级为 200 全量。

### 非安全项（顺手处理）
- 日志轮转（5 MB → `.1`，`createLogger`）；上传部件的同步 append 保留（日志为同步设计，可接受）。

---

## 3. 本轮审计附带的基础设施修复

| 问题 | 修复 |
|---|---|
| Electron 33.4.11 受 ASAR 完整性绕过漏洞影响（GHSA-vmqv-hx8q-j7mg，修复于 35.7.5） | 升级 **Electron 45.2.1**，HIGH 漏洞清零；preload 改 `sandbox: true` |
| `_driveAnswers` 用 `process.execPath -e` 探活，在 Electron 下永久超时 | 挂载就绪检测改为 **rclone RC API**（`rcd` + `mount/mount` + `mount/listmounts` 轮询），不依赖任何子进程 |
| rclone RC 只接受 POST（GET 404）；CLI 挂载不登记 listmounts；`mountType` 为无效参数；`MountPoint` 键为 Go 大写命名 | 逐一实证修正，改为 RC 原生挂载（顺带获得优雅卸载/VFS  flush） |
| `listenAsync(0)` 的 falsy bug 回退默认端口 | `port == null` 判断 |
| upload 测试使用 1024 字节 part_size 与新分片钳制冲突 | 测试数据改为真实尺寸（1 MiB 分片） |

---

## 4. 修复后验证记录

```
node --test                      → 157/157 通过
node scripts/mount-smoke.js Q    → SMOKE TEST PASSED
                                    （RC 原生挂载 → 列表/读/写/建目录 → 优雅卸载）
node scripts/verify-package.js   → 15/15 必需文件在 asar 内，无泄漏
npx electron-builder --win nsis  → QuarkDrive Setup 0.1.0.exe（137.1 MB）+ blockmap
npm audit --omit=dev             → 0 vulnerabilities
```

## 5. 环境限制声明（诚实边界）

- 本沙箱禁止 GUI 进程启动：**Electron 应用窗口与 NSIS 安装器无法在此环境执行**（二进制本身验证正常：`ELECTRON_RUN_AS_NODE` 模式可用；安装器构建、asar 内容、NSIS 脚本编译均通过）。应用代码用契约测试（IPC 通道/DOM ID/按钮绑定/BrowserWindow 加固）静态验证。
- 真实夸克账号的登录后操作（列目录/下载/上传端到端）需要真人扫码；本机已验证到「等待扫码」状态（getToken 真令牌 + 轮询 waiting + 无会话 403 鉴权检测），其余路径按参考实现的响应结构做 mock 回归。
