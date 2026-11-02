# 安全模型

## 资产与威胁

| 资产 | 威胁 |
|---|---|
| 夸克会话 Cookie（`__puus` 等） | 泄露给第三方主机 / 写入日志 / 同机其他进程读取 |
| 用户网盘内容 | 同机未授权进程读写、浏览器 DNS rebinding |
| 二维码登录令牌 | 日志泄露、被中间人抢登 |
| 宿主进程 | 渲染层 XSS → RCE 放大 |
| 安装链 | 供应商二进制被篡改 |

## 防护措施（对应实现）

### 1. 会话与令牌
- `session.json`/`device.json` 写 `%LOCALAPPDATA%\QuarkDrive`，权限 0600，`.gitignore` 排除
- Cookie 只发往夸克 API 主机（**出站白名单 fail-closed**：`COOKIE_HOSTS` 之外的主机一律不带 Cookie，不依赖调用方记得 `noCookie`）；跨主机重定向自动停发；下载/上传（CDN/OSS）显式 `noCookie`
- CDN/OSS 的 Set-Cookie 不入会话罐（`COOKIE_HOSTS` 白名单）
- Cookie 头与二维码令牌注册进日志脱敏器（**每个键值对单独注册、每次日志行重新求值**，轮转后的新值同样脱敏）；日志行摊平控制字符（防注入）；5MB 轮转
- `request_id` 等握手参数用 `crypto.randomInt`（CSPRNG），不使用非加密 PRNG

### 1b. 出站目标约束（SSRF 防护）
- 所有经 HttpClient 抓取的 URL（初始 + 每个重定向跳转）必须满足：**https**、无内嵌凭据、**非 IP 字面量**、非 `localhost`/`.local`/`.internal`/`.home.arpa` 内部域名——服务端下发的 `download_url`/`upload_url`/`Location` 无法把客户端指向回环、链路本地（云元数据）或内网服务，也无法降级为明文 http
- 非流式响应体有 64 MiB 上限（超限即中止，不落内存）

### 2. WebDAV 服务（回路环口）
- 仅绑 `127.0.0.1`（配置项，默认无外网暴露）
- **随机 URL 令牌**：每次运行生成 24 字节 hex 前缀，rclone remote 携带；未知前缀 → 401
- **Host 校验**：只接受 `127.0.0.1/localhost/::1`（含 `[::1]` 括号形式与带端口形式），否则 421（挡 DNS rebinding）；**拒绝含 `@` 的 Host**（userinfo 伪装回环）
- 无认证是刻意选择（端口仅本机可达 + 令牌 + Host 三重防护），避免把口令写进配置
- HEAD 只从 stat 元数据应答，不打开上游流（不为丢弃 body 付出 API 调用 + CDN 连接）
- 只广告实际实现的方法与 `DAV: 1`（不声明 LOCK/COPY/POST）
- 上游 Content-Type 经 token 字符集消毒后才写入响应头

### 3. 渲染层（Electron）
- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`
- preload 只暴露白名单 IPC 通道（调用与事件双向校验，契约测试守护）
- **严格 CSP**（`default-src 'none'`，仅自有 script/style 与 `data:` 二维码图，`connect-src 'none'`）
- `settings:set` 白名单 + 盘符/端口校验；**`rclonePath` 不可从渲染层设置**（它决定被执行哪个二进制）
- 渲染层只用 `textContent`，无数据型 `innerHTML`

### 4. 进程与命令
- rclone 以数组参数 spawn（无 shell），盘符 `^[A-Za-z]$` 校验，`--cache-dir` 等均为独立 argv
- **RC 端点每运行随机 Basic auth 凭证**：`rclone rcd` 不用 `--rc-no-auth`；无凭证请求（含浏览器 CORS simple request）一律 401，杜绝"借受害者身份枚举文件系统/卸载盘符"
- **RC 凭证经子进程 env（`RCLONE_RC_USER`/`RCLONE_RC_PASS`）传递，不进 argv**——argv 可被同用户进程经进程表直读（`Win32_Process.CommandLine`）；已用真实 rclone v1.75.2 实证 env 生效且无凭证 401
- WebDAV URL 令牌（每次运行 24 字节随机）不写入日志文件
- 挂载就绪/卸载走 RC HTTP API，不 spawn 辅助进程（Electron 的 `process.execPath` 不是 node）
- 挂载/卸载/服务器操作串行化（AsyncLocalStorage 精确识别嵌套的在途锁 + 生成令牌），失败尝试只清除自己发布的状态——孤儿 rclone 会长期占用盘符
- `findRclone`/`checkWinFsp` 异步执行（同步 `execFileSync` 会冻结 UI ~165ms）
- 渲染层窗口锁定：`will-navigate` 一律阻止、`setWindowOpenHandler` 一律 deny（页面只 loadFile 一个本地文件）

### 5. 路径与名称
- 写入名称过 `assertValidName`（拒分隔符/`.`/`..`/控制字符/`?*:"<>|`/Windows 保留设备名 CON·PRN·AUX·NUL·COM1-9·LPT1-9/尾随点空格/前导空格）
- 路径→fid 按名精确查找，`..`/`%2F`/反斜杠/双重解码均无法穿越命名空间（原始 socket 级测试验证）
- XML 输出剥离 XML 1.0 非法字符（存量脏名不产生畸形 207）

### 6. 数据完整性
- 覆盖写入 = 先传后删（无"删了没传上"窗口）
- 同路径写串行化；删旧前重拉列表确认
- MOVE 不预删目标；自移动 403；替换走临时名三步（带重试，失败按真实落点记录且原始错误上抛）
- 优雅卸载（RC unmount）先 flush VFS 待传队列
- logout 重置内存 Cookie 罐并停止 WebDAV 服务（URL 前缀即访问凭证）

### 7. 供应链
- 运行时依赖仅 `qrcode`（npm audit 生产依赖 0 漏洞）
- Electron 45.2.1（修复 ASAR 完整性绕过）
- vendor 二进制（rclone/WinFsp）**SHA256 固化 + fail-closed**，安装器只装校验过的 MSI
- **构建期门禁**：`scripts/verify-vendor.js` 从 fetch-vendor.mjs 读同一份 pin，对即将打包的 vendor/* 重新校验，缺失/不符即使构建失败（electron-builder `beforePack` 钩子 + `npm run predist` 双接入）——vendor/ 不入库，被替换的二进制无法流入安装包
- 整个依赖树零 pre/post/install 脚本；lockfileVersion 3，每个包带 resolved + sha512 integrity

## 已知限制（诚实边界）

1. **同机高权限进程**可读写 session.json（0600 对管理员无效）与回路环口——本项目的信任模型是"同用户会话"，不对抗同机恶意管理员。
2. **无 DPAPI 加密**会话：选择文件权限而非平台加密，换取跨平台可移植性与可审计性。Windows 上 Node 的 chmod 只切换只读位，有效 ACL 为继承（用户+SYSTEM+Administrators）。
3. **WebDAV 无传输层加密**：仅监听回路环口，流量不出本机。
4. **扫码二维码 URL** 在窗口内存中为活令牌：截图/远程桌面可能被他人抢登（官方客户端同样如此）。
5. **安装器未签名（接受的风险，第三轮审计 M-2）**：本环境无代码签名证书，发布物仅经 GitHub 渠道分发，用户可按 `latest.yml` 的 sha512 校验；签署 exe/安装器/更新源列为后续工作。app-update.yml 宣传的自动更新当前无对应代码（惰性元数据，无更新校验攻击面）。
6. **RC 凭证/env 与 URL 令牌对同用户进程的残留暴露面（接受的风险，M-3）**：凭证已从 argv 改走子进程 env（消除 WMI 直读），但同用户进程理论上仍可读子进程环境块；rclone 自身错误日志仍可能回显含令牌的 URL。完全防御需 DPAPI/凭据托管，超出当前信任模型。
7. **NSIS 安装器内未做哈希复核（接受的风险，M-1 部分）**：vendor 完整性在构建期已强制（beforePack + predist 双门禁），安装器内验哈希（NSIS Crypto 插件）列为后续工作。
