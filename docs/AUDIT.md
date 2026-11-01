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

---

# 第二轮审计（2026-11-02，遗留 / 新引入 / 上轮遗漏）

> 方法：三个独立子代理（安全 / 正确性健壮性 / 性能），全新上下文，只读审计 +
> 可运行 harness 实证（安全 11 个、正确性 15 个、性能 10 个基准脚本）。
> 基线：158/158 测试全绿。结果：**25 项发现（9 安全 + 16 正确性）全部修复，
> 191 项测试全绿；另完成一轮性能优化（见 docs/PERFORMANCE.md）。**

## 安全发现（N 系列）

| # | 级别 | 发现 | 修复 |
|---|---|---|---|
| N-1 | HIGH | rclone RC 守护进程 `--rc-no-auth`：同机任意进程/浏览器页（CORS simple request，URL query 传参）可枚举本地文件系统、以受害者身份 mount/unmount 盘符 | 每次挂载生成随机 `--rc-user`/`--rc-pass`，`_rcPost` 带 Basic auth |
| N-2 | MEDIUM | 并发挂载竞态：孤儿 rclone 长期占用盘符；失败方清空健康挂载状态；`startServer` 并发留下未监听对象导致 `address()` TypeError | MountManager 在途锁（并发调用合并为一次尝试）+ 生成令牌（仅清除本尝试发布的状态）+ main.js 串行化 server/mount/unmount |
| N-3 | LOW | `auth:cancelLogin` 不中止在途请求，"刷新二维码"最长 30s 静默失效 | signal 透传至 start/poll/complete 的每个 HTTP 调用；取消后等待旧循环真正结束 |
| N-4 | LOW | `auth:logout` 不清内存 Cookie 罐、不停 WebDAV 服务——取得过本次运行 URL 前缀的本机进程在"退出登录"后仍可读写网盘 | logout 重置 cookieJar + closeAsync 停服务 + 中止在途登录 |
| N-5 | LOW | raw 流式下载的 30 分钟兜底超时不覆盖 body（头到达即清 timer），CDN 半开即永久占 socket | body 级空闲看门狗（无字节 N ms 即 abort，chunk 到达重置） |
| N-6 | LOW | `_writeLocks` 清理条件恒假（`run.catch()` 每次新对象），Map 无界增长 | 存储并比较同一个 guarded promise |
| N-7 | LOW | `assertValidName` 放过 Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）、尾随点/空格、`?*:"<>|` | 拒绝上述全部（含任意扩展名形态，大小写不敏感） |
| N-8 | LOW | MOVE 替换的临时名在重试环外；失败态与日志描述不符 | 临时改名纳入重试（每次新临时名）；失败时按真实落点记录；原始错误向上传播 |
| N-9 | LOW | （性能重构引入）快速 `rfc1123` 对负年份产出 `0-323` 畸形日期 | 负年份加符号；与 `toUTCString` 全量差分测试守护 |

## 正确性发现（A 系列）

| # | 级别 | 发现 | 修复 |
|---|---|---|---|
| A-1 | HIGH | `_waitDownloadTask` 的 `continue` 在截止检查之前，`data:null` 时无限轮询、请求永不返回 | 空 data 分支先查截止时间 |
| A-2 | MEDIUM | 上游缺 `Content-Length` 时 `Number(null)===0`，文件被截断为 0 字节 | 先判空再转换 |
| A-3 | MEDIUM | 超限 chunked PUT 的 413 到不了客户端（`Connection: close` + destroy → ECONNRESET，无法区分"文件太大"与"网络故障"） | 先响应 413 再排空 body，保持 keep-alive |
| A-4 | MEDIUM | （同 N-6）writeLocks 无界增长 | 同 N-6 |
| A-5 | MEDIUM | MOVE 新路径分支 rename 失败仍报成功（静默错位，客户端随后 404） | 回滚改名并抛 500 |
| A-6 | MEDIUM | MOVE 替换失败不失效源父目录 → 幽灵条目 | 失败分支一并失效源父目录 |
| A-7 | MEDIUM | `listDirAll` 200 页上限静默截断大目录 | `_size` 500、上限 1000 页、截断告警 |
| A-8 | LOW | `parseRange` 在 size===0 时跳过边界检查（空文件 Range → 上游 416 → 502） | `size != null` 判据 |
| A-9 | LOW | `destinationPath` 按字符串前缀剥离（`/dav` 吃 `/david`）；不校验 Destination 主机 | 分段剥离 + 拒绝异主机 Destination（RFC 4918） |
| A-10 | LOW | 目录 HTML 列表相对链接在子目录下指错 | `./` 前缀 |
| A-11 | LOW | PUT 与 GET/PROPFIND 的 ETag 不一致 | PUT 响应使用 stat 的同一 etag |
| A-12 | LOW | `resolve()` 不校验中间组件是目录 → 500 代替 404 | 循环内拒绝非目录中间组件 |
| A-13 | LOW | `execFileSync` 同步阻塞主进程 ~165ms；rclone 意外退出不清状态不通知 | 异步化 + onExit 清状态 + onStateChange 通知 UI |
| A-14 | LOW | `update/hash` 传输错误直接终止上传（分片已全部上传成功） | 非 AuthError 降级为正常 commit |
| A-15 | LOW | `commit` 的 callback 编码三分支不一致（数字会 base64 成非法回调） | 统一归一化：string 原样 / object 序列化 / 其他丢弃 |
| A-16 | LOW | `unlink` 无条件失效根目录缓存（多余 API 调用） | 仅父目录是根时失效根 |

## 本轮基础设施与功能改进

- 稳定性测试套件 `tests/stability/soak.test.js`：100 并发 PROPFIND 风暴、混合并发
  读写列目录、下载中途断连 abort 上游、10 类畸形请求、keep-alive 复用、写入锁/缓存残留。
- 性能基准 `scripts/bench.js` 成为仓库常驻资产（见 docs/PERFORMANCE.md）。
- 安装器：WinFsp MSI 安装加日志（`%TEMP%\quarkdrive-winfsp-install.log`）、
  瞬时失败重试一次、安装后存在性验证与明确告警。
- UX：挂载中状态与按钮禁用、传输进度行（rclone RC core/transfers 轮询）、
  二维码有效期倒计时、友好错误文案、打开盘符、退出应用（先卸载）、
  启动最小化到托盘、托盘菜单反映挂载状态。
- `deepMerge` 拒绝 `__proto__`/`constructor` 键。

## 环境限制（诚实边界）

本沙箱实测：**回环连接的响应方向无法到达非 Node 子进程**（rclone 的请求到达
服务器且服务器正常响应，但 rclone 侧超时收不到；Node 进程间回环正常）。
因此本轮**未能执行真实 rclone 挂载冒烟**；挂载相关改动依靠：rclone v1.75.2
选项名静态核验（`rclone help flags` 逐一确认）、假 RC 端点到端测试（新 vfsOpt
全量断言 + Basic auth 断言）、以及协议语义差分测试来保证。第一轮报告中"真实挂载
通过"的记录来自此前环境，仍然有效但非本轮产生。
