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
- 目录列表有 TTL 缓存（LRU 512）+ 并发同目录 list 去重 + 名称索引 + stat 对象缓存
- 预签名 CDN URL 按 fid 缓存 5 分钟（403 淘汰重取），重复打开不再打 API
- Range 请求透传给 CDN，长度以**上游实际返回**为准（缺 Content-Length 时用 stat 尺寸，
  `Number(null)===0` 陷阱已修）
- 客户端断连时 abort 上游 fetch（无 socket 泄漏）+ body 级空闲看门狗

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

分片按 `pre` 响应的 `part_thread` 并发上传（封顶 4、在途内存 ~64 MiB 约束）：
SHA-1 链在生产分片时顺序推进，每片的 `X-Oss-Hash-Ctx`（覆盖 1..N-1）在 PUT 前
预计算——协议语义与串行版完全一致，只是网络等待重叠。

### 挂载生命周期（rclone RC 原生）

```
MountManager.mount()   （在途锁：并发调用合并为一次尝试，绝不出孤儿进程）
  1. freePort() 选 RC 端口 → 生成本次运行随机 RC 凭证
     spawn `rclone rcd --rc-addr 127.0.0.1:P --rc-user U --rc-pass P --transfers 8`
  2. 轮询 POST /core/version（Basic auth）直到 RC 就绪
  3. POST /mount/mount {fs: ":webdav,url='http://127.0.0.1:PORT/<token>',vendor='other',timeout='30m':",
                        mountPoint: "Q:", vfsOpt: {VfsCacheMode: writes, DirCacheTime: 5m,
                        BufferSize: 64M, VfsCacheMaxSize: 10G, VfsReadChunkSize: 16M,
                        VfsReadChunkStreams: 8, VfsWriteBack: 5s}}
  4. 轮询 POST /mount/listmounts 直到 MountPoint == Q:
  5. unmount: POST /mount/unmount {mountPoint: "Q:"}（优雅，刷新 VFS 待传队列）
  6. 挂载期间主进程每 2s 轮询 POST /core/transfers → 渲染层传输进度行
```

为什么用 RC 而不是 `rclone mount` 子进程 + 探活：
- 探活若用 `fs.existsSync` 轮询，挂载卡死会把整个应用卡死（Node 单线程）
- CLI 挂载不会登记到 `mount/listmounts`，无法精确感知就绪
- RC 卸载会先 flush VFS 缓存，避免"退出时丢上传"

RC 端点是**每运行随机凭证保护**的：无凭证请求（含浏览器 CORS simple request）
一律 401——否则同机任意进程可借受害者身份枚举文件系统或卸载盘符。

**缓存设置**：`VfsCacheMaxSize`（磁盘缓存上限，默认 10G）与 `VfsCacheMode`（writes/full/minimal/off）
开放给用户在设置页手动调整；渲染层传入的值经 `sanitizeRendererMountOptions` 白名单校验后才进入
rclone 命令行（未知键丢弃、非法值报错，`rclonePath` 等危险键渲染层永远碰不到）。VFS 磁盘缓存固定落在
`%LOCALAPPDATA%\QuarkDrive\vfs-cache`（构建栈时自动创建），可随时在设置页「清理缓存」
（需先卸载，带 `isInside` 路径防护，绝不误删 rclone 正在写的文件）。改缓存大小/模式后重新挂载生效。

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
- **Cookie 流向**：只发给夸克 API 主机（`COOKIE_HOSTS` 出站白名单，fail-closed——不依赖调用方传 `noCookie`）；跨主机重定向自动停止发送；下载/上传到 CDN/OSS 时 `noCookie`；CDN/OSS 设的 Cookie 不入会话罐。
- **出站目标**：初始 URL 与每个重定向跳转都必须是 https 公网域名（拒绝 IP 字面量/内网域名/明文/userinfo）——服务端下发的 `download_url`/`upload_url`/`Location` 无法把客户端变成指向回环或内网的 SSRF 探针；非流式响应体 64 MiB 封顶。
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
