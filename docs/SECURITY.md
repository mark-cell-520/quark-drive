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
- Cookie 只发往夸克 API 主机；跨主机重定向自动停发；下载/上传（CDN/OSS）显式 `noCookie`
- CDN/OSS 的 Set-Cookie 不入会话罐（`COOKIE_HOSTS` 白名单）
- Cookie 头与二维码令牌注册进日志脱敏器；日志行摊平控制字符（防注入）；5MB 轮转

### 2. WebDAV 服务（回路环口）
- 仅绑 `127.0.0.1`（配置项，默认无外网暴露）
- **随机 URL 令牌**：每次运行生成 24 字节 hex 前缀，rclone remote 携带；未知前缀 → 401
- **Host 校验**：只接受 `127.0.0.1/localhost/::1`，否则 421（挡 DNS rebinding）
- 无认证是刻意选择（端口仅本机可达 + 令牌 + Host 三重防护），避免把口令写进配置

### 3. 渲染层（Electron）
- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`
- preload 只暴露白名单 IPC 通道（调用与事件双向校验，契约测试守护）
- `settings:set` 白名单 + 盘符/端口校验；**`rclonePath` 不可从渲染层设置**（它决定被执行哪个二进制）
- 渲染层只用 `textContent`，无数据型 `innerHTML`

### 4. 进程与命令
- rclone 以数组参数 spawn（无 shell），盘符 `^[A-Za-z]$` 校验，`--cache-dir` 等均为独立 argv
- 挂载就绪/卸载走 RC HTTP API，不 spawn 辅助进程（Electron 的 `process.execPath` 不是 node）

### 5. 路径与名称
- 写入名称过 `assertValidName`（拒分隔符/`.`/`..`/控制字符）
- 路径→fid 按名精确查找，`..`/`%2F`/反斜杠/双重解码均无法穿越命名空间（原始 socket 级测试验证）
- XML 输出剥离 XML 1.0 非法字符（存量脏名不产生畸形 207）

### 6. 数据完整性
- 覆盖写入 = 先传后删（无"删了没传上"窗口）
- 同路径写串行化；删旧前重拉列表确认
- MOVE 不预删目标；自移动 403；替换走临时名三步（带重试，失败保留可恢复）
- 优雅卸载（RC unmount）先 flush VFS 待传队列

### 7. 供应链
- 运行时依赖仅 `qrcode`（npm audit 生产依赖 0 漏洞）
- Electron 45.2.1（修复 ASAR 完整性绕过）
- vendor 二进制（rclone/WinFsp）**SHA256 固化 + fail-closed**，安装器只装校验过的 MSI

## 已知限制（诚实边界）

1. **同机高权限进程**可读写 session.json（0600 对管理员无效）与回路环口——本项目的信任模型是"同用户会话"，不对抗同机恶意管理员。
2. **无 DPAPI 加密**会话：选择文件权限而非平台加密，换取跨平台可移植性与可审计性。
3. **WebDAV 无传输层加密**：仅监听回路环口，流量不出本机。
4. **扫码二维码 URL** 在窗口内存中为活令牌：截图/远程桌面可能被他人抢登（官方客户端同样如此）。
