# QuarkDrive 安全审计报告

> 审计日期：2026-11-02 · 范围：全部核心代码 + Electron 外壳 + 安装器脚本
> 方法：独立审查代理（全新上下文、可复现 harness 实证）+ 维护者自查 + 静态扫描 + `npm audit`
> 结果：**18 项发现全部修复，157 项测试全绿，真实挂载冒烟通过**
> **后续轮次**：第二轮（遗留/新引入/上轮遗漏）25 项全修复 → 195 测试；第三轮（全新独立上下文全代码面复查）13 项全修复 → **217 测试全绿**。详见文末对应章节。
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

---

# 第三轮审计（2026-11-02，全新独立上下文 · 全代码面复查）

> 方法：维护者全文件人工复核 + **三个独立审查子代理**（core 网络/API 层、
> WebDAV/文件系统层、Electron 外壳与安装链），全新上下文、只读审计，
> 以可运行 harness（真实 socket / 假 fetch / 假 Quark 后端 / 真实
> rclone 二进制）实证每一项发现。
> 基线：204/204 测试全绿。结果：**19 项新发现全部修复或记录为接受风险
> （Q-1/H-1/C-1 MEDIUM，M-1/M-2/M-3 MEDIUM，C-2..C-4/W-1..W-6/E-1/L-1..
> L-7 LOW），219 项测试全绿，打包校验通过。**

## 发现与修复清单

### MEDIUM

#### Q-1 操作队列把"在途时新到达的独立操作"误判为嵌套 → 并发执行
- **位置**：`app/op-queue.js` `serialize()`
- **问题**：嵌套判定用 `running > 0` 计数，无法区分"真嵌套"（外层操作的动态
  作用域内）与"外层在途时从别的 IPC/托盘事件提交的独立操作"——后者被判为
  嵌套而**内联执行**，两个挂载/卸载/服务器操作并发跑，正是该队列要杜绝的
  "并发 spawn 两个 rclone / 孤儿进程占盘符"（N-2 同类）。
- **实证**：harness 显示 `maxInFlight = 2`（A 在途 10ms 后提交 B，二者重叠）。
- **修复**：改用 `AsyncLocalStorage` 精确识别嵌套（异步上下文跨 await 传
  递）；独立提交照常入链。修复后 harness `maxInFlight = 1`。
- **回归**：`tests/unit/op-queue.test.js` 新增 Q-1 用例（在途提交必须排队）。

#### H-1 会话 Cookie 出站为 fail-open：任何主机都收 Cookie，除非调用方记得 `noCookie`
- **位置**：`core/quark/http.js` `request()`
- **问题**：Cookie 发送只依赖每个调用点自觉传 `noCookie`；`request()` 本身
  对任意主机（含服务端下发的 `download_url`、重定向目标）都会带上会话
  Cookie。一个遗漏的标志位或未来的新代码路径就会把会话发给第三方。
- **实证**：harness 显示 `GET https://evil.example.com/collect` 收到
  `__puus=…` 完整会话头。
- **修复**：出站改为**白名单 fail-closed**——只有 `COOKIE_HOSTS`
  （pan/drive-pc/uop/quark.cn）才发 Cookie，与 Set-Cookie 入站白名单对称；
  `noCookie` 保留为显式退出。夸克 API/CDN/OSS 真实主机全部在白名单内，
  不影响正常流程。
- **回归**：`tests/unit/http.test.js` 新增 H-1 用例（外网主机零 Cookie +
  API 主机正常携带）。

#### C-1 SSRF：服务端下发的 URL 无目标约束，明文 http 也被接受
- **位置**：`core/quark/api.js` `getDownloadUrl`、`core/quark/upload.js`
  `_ossPartUrl`/`commit`、`core/quark/http.js` 重定向跟随
- **问题**：`download_url`/`upload_url`/`Location` 直接 fetch，无主机约束、
  不校验 scheme——被篡改的上游可把客户端指向回环/链路本地（云元数据
  169.254.169.254）/内网服务，或降级明文 http（Cookie 已不出站，故定
  MEDIUM 而非 HIGH；文档信任模型内实际为 LOW）。
- **实证**：harness 显示 API 返回的 `http://169.254.169.254/…` 被原样抓
  取；重定向到 `127.0.0.1:9` 被跟随且响应体上浮。
- **修复**：`assertFetchableUrl()` 守卫初始 URL 与每个重定向跳转：必须
  **https**、无内嵌凭据、**非 IP 字面量**、非 `localhost`/`.local`/
  `.internal`/`.home.arpa`。真实 CDN/OSS 均为公网 DNS 名，无误伤。
- **回归**：`tests/unit/audit-findings.test.js` C-1 ×4（http 拒绝 / IP 与
  内网域名拒绝 / 重定向拒绝 / 公网 https 放行）。

### LOW

#### C-2 非流式响应体无上限缓冲 → 恶意/异常上游可 OOM
- **位置**：`core/quark/http.js` `request()`
- **实证**：harness 显示声明 `Content-Length: 10` 实际 64 MiB 的响应被完整
  缓冲。
- **修复**：`readCappedBody()` 流式读取，超过 `maxBodyBytes`（默认 64 MiB，
  可注入）即中止；无 `.body` 的替身回退 `arrayBuffer()` 并同样检查上限。
- **回归**：C-2 ×2（超限中止 / 正常响应不受影响）。

#### C-3 `request_id` 使用非加密 PRNG
- **位置**：`core/quark/auth.js` `uniqueRequestId()`
- **修复**：`Math.random()` → `crypto.randomInt()`，与代码库其余机密值
  （RC 凭证、设备 ID、URL 令牌）的 CSPRNG 惯例一致。
- **回归**：C-3（剥注释后源码无 `Math.random`，含 `crypto.randomInt`）。

#### C-4 Cookie 日志脱敏只注册一次完整头，漏轮转值与单键值对
- **位置**：`core/index.js` `buildStack()`
- **问题**：`logger.addSecret(cookieJar.header())` 一次性注册拼接串；(a) 单
  个 `name=value` 不匹配；(b) API 调用轮换出的新 Cookie 值永不重新注册。
  当前无代码记录 Cookie 值（纵深防御），但"绝不可能进日志"的承诺被高估。
- **修复**：logger 新增 `addSecretProvider()`（每次日志行重新求值）；
  buildStack 注册 provider 同时覆盖**完整头 + 每个键值对**，logout 换罐
  后自动跟随新罐。
- **回归**：C-4（轮换值、单键值对、旧值全部脱敏）。

#### W-1 `hostOk` 接受 `@` userinfo 伪装（非绕过，但削弱 Host 层）
- **位置**：`core/webdav/server.js` `hostOk()`
- **问题**：`'127.0.0.1:80@evil.com'.split(':')[0] === '127.0.0.1'` 通过
  Host 校验（有 URL 令牌兜底，浏览器也发不出这种 Host；MOVE 的
  Destination 解析反而正确拒绝）。
- **修复**：含 `@` 的 Host 一律拒绝。
- **回归**：W-1/W-2（原始 socket 发 Host 头逐一断言）。

#### W-2 `hostOk` IPv6 分支是死代码（fail-closed 但功能失效）
- **位置**：同上（`'[::1]:port'.split(':')[0] === '['`，两个 IPv6 比较永假）
- **修复**：按 authority 规范剥离端口（括号 IPv6 取 `]` 后），`[::1]` /
  `[::1]:9798` / `::1` 现在被正确接受。

#### W-3 HEAD 白开一次完整上游下载再丢弃
- **位置**：`core/webdav/server.js` `handleGet`
- **修复**：HEAD 只从 `stat()` 元数据应答（含 Range 语义的 206），不再付出
  API 调用 + CDN 连接的代价。

#### W-4 方法/DAV 合规性过度声明（非安全）
- **位置**：`core/webdav/server.js` `ALLOW_METHODS` / `DAV` 头
- **修复**：`Allow` 只广告实际实现的方法（去掉 POST/COPY），`DAV: 1`（不
  声明未实现的 class 2 锁定）。

#### W-5 上游行为不端时 Content-Range end 可能越过文件尺寸（代码审读）
- **位置**：`core/webdav/server.js` 206 分支
- **修复**：`end` 钳制到 `st.size - 1`（合规 CDN 下为无操作）。

#### W-6 上游恶意 Content-Type 让 setHeader 抛错 → 裸 500（注入已被 Node 拦截）
- **位置**：`core/webdav/server.js` GET 分支
- **修复**：`safeMime()` 把上游 mime 限制在 token 字符集，非法值回落
  `application/octet-stream`（请求正常 200，无注入）。

#### E-1 渲染层无 Content-Security-Policy
- **位置**：`app/renderer/index.html`
- **修复**：加入严格 CSP：`default-src 'none'; script-src 'self'; style-src
  'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none';
  form-action 'none'`（二维码为 data: URL，页面无内联脚本/样式/外链，
  契约测试守护）。
- **回归**：`tests/unit/app-contract.test.js` E-1（CSP 存在 + 无
  unsafe-inline/eval + 页面不加载任何被 CSP 阻止的资源）。

### 补充：Electron 外壳与安装链独立审计（E 系列，同日第三个子代理）

#### M-1（MEDIUM）vendor 二进制完整性只在下载端校验，构建/安装端无门禁
- **位置**：`scripts/installer.nsh`（msiexec 安装捆绑 MSI 无哈希校验）、
  `package.json`（dist 无校验环节）、`.gitignore`（vendor/ 不入库）
- **问题**：`fetch-vendor.mjs` 的 SHA256 固化只保护下载路径；被替换的
  rclone.exe/winfsp.msi 放进 vendor/ 就会被原样打包，其中 MSI 还会以
  管理员权限静默安装，全程无校验。
- **修复**：新增 `scripts/verify-vendor.js`——从 fetch-vendor.mjs 读取
  同一份 pin，对即将打包的 vendor/* 重新校验，缺失/不符即 exit 1；
  同时接入 electron-builder `beforePack` 钩子与 `npm run predist`，
  `npm run dist` 与裸 `npx electron-builder` 都无法绕过。
- **回归**：audit-findings M-1（静态接线断言 + 替换二进制实测 exit 1 +
  真实 vendor 实测通过）。
- **遗留（已记录为接受风险）**：NSIS 安装器内验哈希（Crypto 插件）与
  安装包签名见 M-2。

#### M-2（MEDIUM）安装器与应用无 Authenticode 签名
- **问题**：exe/安装器未签名，用户端只有 SmartScreen 警告，除 GitHub
  渠道外无真实性绑定。`latest.yml` 的 sha512 与产物一致但无信任根。
- **处置**：本环境无代码签名证书，**记录为接受的风险**（见
  docs/SECURITY.md「已知限制」）：发布物仅经 GitHub 渠道分发，用户可按
  latest.yml 校验 sha512。签署 exe/安装器/更新源列为后续工作。
- **附带发现（正向）**：app-update.yml 宣传 GitHub 自动更新但代码中无
  autoUpdater——元数据是惰性的，当前不存在更新校验攻击面（也无更新路径）。

#### M-3（MEDIUM）RC 凭证与 WebDAV 令牌对同用户进程可见
- **位置**：`core/mount/rclone.js`（凭证走 argv）、`app/main.js`（日志
  落 URL 前缀）
- **实证**：`Win32_Process.CommandLine` 可被任何同用户进程读取，rclone
  的 argv 里 `--rc-user/--rc-pass` 明文可见（无需管理员）；URL 令牌曾
  落进 `logs/quark-drive.log` 与 `logs/rclone.log`。
- **修复**：(a) RC 凭证改走子进程 **env**（`RCLONE_RC_USER`/
  `RCLONE_RC_PASS`）——已用真实 vendor rclone v1.75.2 实证：env 生效
  （日志 `Using --user envuser123 --pass XXXX`）、无凭证请求 401、带
  Basic auth 200；(b) `startServer` 日志行不再写 URL 前缀。
- **回归**：rclone.test.js（断言凭证不在 argv 而在 env）+
  app-contract N-1/M-3 静态断言 + 日志行不含令牌断言。
- **遗留（接受风险）**：rclone 自身错误日志仍可能回显含令牌的 URL
  （rclone 无脱敏开关）；同用户进程理论上仍可读子进程 env 块——相对
  argv 的 WMI 直读已消除主要暴露面，完全防御需 DPAPI/凭据托管，超出
  当前信任模型。

#### E 系列 LOW（已修复）
- **L-1 无 `will-navigate`/`setWindowOpenHandler` 锁定**：main.js 已加
  （导航一律阻止、弹窗一律 deny），契约测试守护。
- **L-2 Windows 上 0600 不可强制执行**（chmod 只切换只读位，有效 ACL
  继承：用户+SYSTEM+Administrators）：维持已知限制 #1/#2 记录。
- **L-3 `settings:set` 传显式 `undefined` 会把已存键抹回默认值**：
  main.js 改为跳过 undefined 值，契约测试守护。
- **L-4 `findRclone` 的 PATH 回退**（vendor 缺失时从 PATH 找 rclone，
  同用户 PATH 劫持可替换二进制）：维持威胁模型内记录，vendor 优先的
  查找顺序不变。
- **L-5 `fetch-vendor.mjs` 的 `redirect:'follow'` 允许 https→http 降级**：
  因 SHA256 pin 会拒绝被替换内容（已实证），记录为信息级。
- **L-6 `scripts/make-icon.js` 曾被打进 asar**：已从 `build.files` 移除
  （开发命令 `npm run icon` 保留）。
- **L-7 preload `on()` 不校验回调类型**：记录，暂不改（回调来自本仓
  渲染层，无外部输入）。

## 本轮验证记录

```
node --test                       → 219/219 通过（+16 项本轮回归测试）
npm audit --omit=dev              → 0 vulnerabilities
node scripts/verify-vendor.js     → vendor 完整性 OK（2 artifacts）
node scripts/verify-package.js    → 19/19 必需文件，无测试/vendor/机密泄漏
npx electron-builder --win nsis   → QuarkDrive Setup 0.1.0.exe + blockmap
                                     （ELECTRON_MIRROR=npmmirror；beforePack
                                       vendor 门禁生效；asar 抽查：CSP/
                                      AsyncLocalStorage/SSRF 守卫/脱敏
                                      provider/env 凭证均已入包）
真实 rclone v1.75.2 实证            → RCLONE_RC_USER/PASS env 生效；
                                     无凭证 401 / Basic auth 200
rclone 选项名静态核验              → --rc-addr/--cache-dir/--log-file 存在
```

**本轮环境限制（诚实边界）**：(1) 旧 `dist/win-unpacked/QuarkDrive.exe` 被
不可见进程锁定（疑为杀软扫描），`rmdir`/改名均被拒，本轮构建输出到
`dist3/`（内容校验等价通过）；`dist/`、`dist2/`、`dist3/` 均不入库。
(2) Electron GUI 仍无法在本沙箱启动，渲染层改动（CSP）以契约测试 + 打包
抽查验证，未经真机 GUI 运行；(3) 真实夸克 API 不可达（无凭据），SSRF 守
卫与 Cookie 白名单对真实 CDN/OSS 主机名的兼容性依据协议文档与参考实现判
断，未经真实账号端到端验证；(4) 回环限制同第二轮——真实 rclone 挂载冒烟
未能重跑。

## 正向结论（本轮复核确认仍然成立）

- 路径穿越防护（名称精确查找 + `assertValidName`，含双重编码/反斜杠/
  超长 UTF-8，原始 socket 级实证全部 404/包含）
- WebDAV 令牌（192-bit CSPRNG）+ Host 校验（浏览器可达的全部重绑定形态
  421）+ 无 XML 解析（无 XXE）+ 无请求走私（413 先响应后排空）
- 跨主机 Cookie 抑制 + CDN/OSS Set-Cookie 不入罐 + 下载/上传 `noCookie`
- 全代码库无 TLS 校验关闭、无硬编码密钥；RC 凭证/设备 ID/URL 令牌均为
  CSPRNG
- rclone 数组参数 spawn（无 shell）、盘符校验、RC 每运行随机 Basic auth
- 覆盖写"先传后删"、写锁 + 重拉确认、MOVE 三步安全替换、错误文案脱敏
- 安装链：vendor 二进制 SHA256 固化 + fail-closed、安装器日志/重试/安装
  后验证
