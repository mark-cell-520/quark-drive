# 架构设计

## 总览

QuarkDrive 由三层组成：

| 层 | 组件 | 职责 |
|---|---|---|
| 桌面外壳 | `app/`（Electron） | 二维码登录 UI、容量/挂载控制、设置、托盘、单实例、开机自启 |
| 纯 Node 核心 | `core/`（零依赖） | 夸克协议、WebDAV 服务器、挂载生命周期、配置/日志 |
| 系统层 | rclone + WinFsp | 把 HTTP 文件协议变成 Windows 盘符 |

核心层不依赖 Electron，可独立以 CLI 运行（`node core/index.js mount`），这也是它可被完整测试的原因。

## 数据流

### 读（打开 Q:\docs\a.txt）

```
Explorer → WinFsp → rclone VFS → GET /<token>/docs/a.txt
  → webdav/server.js handleGet
  → quark-fs.createReadStream → api.getDownloadUrl(fid)（换 CDN 预签名 URL）
  → http.request(noCookie, 带 Range) → 流式管道回客户端
```

要点：
- 目录列表有 TTL 缓存（LRU 512）+ 并发同目录 list 去重
- Range 请求透传给 CDN，长度以**上游实际返回**为准
- 客户端断连时 abort 上游 fetch（无 socket 泄漏）

### 写（拖文件进 Q:\）

```
Explorer → rclone VFS 缓存 → PUT /<token>/docs/big.bin
  → quark-fs.writeFile（按路径串行化）
  → upload.js: upload/pre（拿 task/bucket/obj_key/part_size）
    → 分片 PUT 到 OSS（part≥2 带 X-Oss-Hash-Ctx）
    → update/hash（秒传检测：data.finish=true 直接 finish）
    → CompleteMultipartUpload（commit，带 x-oss-callback）
    → upload/finish
  → 上传成功后删除旧版本（先重拉列表确认，防并发竞态）
```

覆盖语义是**先传后删**：上传失败旧文件完好，绝不出现"删了没传上"的丢失窗口。

### 挂载生命周期（rclone RC 原生）

```
MountManager.mount()
  1. freePort() 选 RC 端口 → spawn `rclone rcd --rc-addr 127.0.0.1:P --rc-no-auth`
  2. 轮询 POST /core/version 直到 RC 就绪
  3. POST /mount/mount {fs: ":webdav,url='http://127.0.0.1:PORT/<token>',vendor='other':",
                        mountPoint: "Q:", vfsOpt: {VfsCacheMode: writes, DirCacheTime: 10s}}
  4. 轮询 POST /mount/listmounts 直到 MountPoint == Q:
  5. unmount: POST /mount/unmount {mountPoint: "Q:"}（优雅，刷新 VFS 待传队列）
```

为什么用 RC 而不是 `rclone mount` 子进程 + 探活：
- 探活若用 `fs.existsSync` 轮询，挂载卡死会把整个应用卡死（Node 单线程）
- CLI 挂载不会登记到 `mount/listmounts`，无法精确感知就绪
- RC 卸载会先 flush VFS 缓存，避免"退出时丢上传"

### 登录（扫码）

```
auth.start()  GET uop.quark.cn/cas/ajax/getTokenForQrcodeLogin   → token
              渲染 su.quark.cn/4_eMHBJ?token=… 为二维码（该 URL 本身是活令牌，按机密处理）
auth.poll()   GET …/getServiceTicketByQrcodeToken                → 2000000 已确认 / 50004001 等待 / 50004002 过期
auth.complete GET pan.quark.cn/desktop/account/login?st=<ticket> → Set-Cookie（__puus 等）→ session.json (0600)
```

## 安全边界

- **渲染层不可信**：`contextIsolation: true` + `sandbox: true` + `nodeIntegration: false`；preload 仅暴露白名单 IPC 通道；渲染层拿不到 Cookie/令牌。
- **WebDAV 服务**：仅绑 `127.0.0.1`；每次运行随机 URL 令牌；校验 `Host`；rclone remote 携带令牌。
- **Cookie 流向**：只发给夸克 API 主机；跨主机重定向自动停止发送；下载/上传到 CDN/OSS 时 `noCookie`；CDN/OSS 设的 Cookie 不入会话罐。
- **名称与路径**：所有写入名称过 `assertValidName`；路径按名精确查找（`..`/编码/反斜杠均无法穿越命名空间）。
- **进程边界**：rclone 以数组参数 spawn（无 shell），盘符经 `normalizeLetter` 校验；`rclonePath` 仅环境变量/CLI 可设（渲染层不可设，防 RCE 放大）。
- **日志**：Cookie 头与 QR 令牌注册为秘密自动脱敏；换行/控制字符摊平（防日志注入）；5MB 轮转。

完整发现-修复闭环见 [AUDIT.md](AUDIT.md)。

## 关键设计取舍

| 决策 | 理由 |
|---|---|
| 自研 WebDAV 而非引入 webdav-server 库 | 协议面很小（8 个方法）；零依赖 = 可审计、无供应链风险；行为完全可控 |
| 纯 JS SHA1（可导出内部状态） | OSS 多分片要求 X-Oss-Hash-Ctx（SHA-1 内部状态 h0..h4 + 比特数），Node crypto 不暴露；用 RFC 2202 向量 + crypto 交叉验证 |
| 分片大小钳制 1–64 MiB | 服务端可能返回极端值；分片在内存中缓冲，64 MiB 封顶防 OOM |
| 覆盖=先传后删 | 删除先行会有数据丢失窗口 |
| 会话 Cookie 单一文件 0600 | 桌面客户端同样行为；DPAPI 会增加平台耦合，留作后续增强 |
| 就绪检测走 RC 而非文件系统探活 | 挂载卡死时 fs 探活会冻结事件循环 |
