# QuarkDrive 性能报告

> 测量日期：2026-11-02 · 工具：`node scripts/bench.js`（仓库常驻，零外部依赖）
> 环境：Windows 10 x64 · Node v24.22.0 · Xeon 4C8T · 16 GB · rclone v1.75.2
> 方法：内存 fake Quark 后端隔离 CPU 成本；WebDAV 走真实 HTTP 服务器 + loopback；
> 上传管线用真实 Uploader + 假 OSS。所有"优化后"数字实测于当前代码。

## 总览（优化前 → 优化后）

| 指标 | 优化前 | 优化后 | 变化 |
|---|---|---|---|
| `fs.list` 目录列表（缓存命中，2000 条目） | 2.67 ms/次 | **0.0019 ms/次** | ~1400× |
| `xml.multistatus` 2000 条目（重复 PROPFIND） | 22.94 ms/次 | **1.88 ms/次** | 12.2× |
| WebDAV PROPFIND depth-1 根目录（2000 条目，端到端） | 41.8 ms/次 | **30.6 ms/次** | 1.37×（服务端 CPU 大幅下降，余量为 HTTP/序列化固有可能） |
| 纯 JS SHA-1 吞吐（上传关键路径） | 27.6 MB/s | **57.2 MB/s** | 2.1× |
| 上传流式摄入（64 MiB 分片，PUT 必经路径） | 23 MB/s | **1626 MB/s** | ~70× |
| `fs.stat` 深层路径（热缓存） | 0.041 ms | **0.013 ms** | 3.2× |
| `fs.stat` 单文件（热缓存） | 0.0071 ms | **0.0066 ms** | ~1×（已触及 Map 查找下限） |
| WebDAV GET 4 MiB（fake CDN，loopback） | 142 MB/s | **138–169 MB/s** | 持平（受 loopback 限制，非瓶颈） |
| WebDAV PUT 4 MiB（fake OSS，loopback） | 147 MB/s | **138–166 MB/s** | 持平 |

读取路径经独立审计确认**不是瓶颈**：全栈 GET 64 MiB 205 MB/s（含同进程客户端解析），
真实 `rclone cat` 64 MiB 105–146 MB/s（含进程启动）。

## 各项优化的做法与理由

### 1. 目录列表与路径解析（quark-fs.js）
- **名称索引**：每个缓存目录 listing 附带 `Map<name, entry>`（首现存语义与 `find` 一致），
  路径逐级解析从 O(目录大小) 降为 O(深度)。
- **stat 对象缓存**：`list()` 的 stat 数组与原始条目同缓存（TTL/LRU 一致），
  重复 PROPFIND depth-1 不再为每个条目重建 4 个 Date + 3 个字符串。
  Explorer 反复浏览同一目录是最高频路径。
- **中间组件校验**：`resolve()` 遇到非目录中间组件即停（404 而非 500）。

### 2. XML 207 构建（xml.js）
- **单遍转义快路径**：一次正则测试，无需转义时零分配（列表每条目调用 ~6 次）。
- **查表式日期**：手写 RFC1123/ISO8601（查找表 + 手工补零），与
  `Date#toUTCString/toISOString` **逐字节一致**（差分测试守护，含负年份与扩展年份），
  比原生快 ~10×；列表每条目格式化 2 个日期。
- **href 快路径**：无需编码的路径跳过 split/map/join。
- **响应记忆化**：`<D:response>` 按条目对象 WeakMap 缓存，与目录缓存同生命周期；
  重复 PROPFIND 只做字符串拼接。同时移除本服务并不实现的 `supportedlock`
  （响应体 -31%）。
- `mimeTypeOf` 映射表模块化 + 扩展名缓存。

### 3. SHA-1（sha1ctx.js）
OSS 多分片协议要求 `X-Oss-Hash-Ctx`（SHA-1 内部状态），Node crypto 不暴露，
必须纯 JS 实现。三轮优化：80 轮展开为 4×20（去分支）、调度数组复用、
`Uint32Array` 调度数组（免 double↔int32 转换）。digest 与 node:crypto 差分验证。

### 4. 上传管线（upload.js）
- **线性摄入**：原实现每来一个 chunk 就 `Buffer.concat` 整个累加器——平方级拷贝，
  64 MiB 分片时摄入只有 3 MB/s。改为定长累加器 fill-and-flush（每个发出的分片
  独立分配，消费者跨 await 持有安全）。
- **并发分片**：官方客户端即并行上传（`pre` 响应带 `part_thread`，请求体带
  `parallel_upload: true`）。现按 `part_thread`（封顶 4，且受 ~64 MiB 在途内存约束）
  并发 PUT；SHA-1 链在**生产分片时**顺序推进，每片的 ctx（覆盖 1..N-1）在 PUT 前
  预计算——协议语义与串行版完全一致，只是网络等待重叠。
  审计实测（RTT 结构模拟）：100 MiB/13 片，串行 1220ms → 2 路 468ms → 4 路 283ms。

### 5. 挂载流畅度（rclone.js / config.js）
此前 `settings.mountOptions` 只有 2 个键真正生效，其余被静默丢弃。现全部转发：

| rclone 参数 | 值 | 理由 |
|---|---|---|
| `--vfs-cache-mode` | `writes` | 上传异步落盘；读不占磁盘 |
| `--dir-cache-time` | `5m` | 浏览目录少打 API（原兜底 10s 比 rclone 默认还差） |
| `--buffer-size` | `64M` | 大顺序读缓冲（原未传 = 16Mi 默认） |
| `--vfs-cache-max-size` | `10G` | VFS 磁盘缓存封顶（原默认无限制） |
| `--vfs-write-back` | `5s` | 写后尽快 flush |
| `--vfs-read-chunk-size` | `16M` | 默认 128MiB 首读即拉全量，预览/拖动进度浪费 |
| `--vfs-read-chunk-streams` | `8` | 并行读流，顺序读更平滑抗抖 |
| `--transfers` | `8` | 多文件拷贝进 Q: 的并行度 |
| webdav `timeout` | `30m` | 与服务端下载看门狗对齐（默认 5m 会误杀慢链路） |

其中 **`--vfs-cache-max-size`（缓存大小）与 `--vfs-cache-mode`（缓存模式）开放给用户在设置里手动调整**：
下拉预设 512M–50G / 不限，或输入自定义值（如 `12G`）。渲染层传来的值经
`sanitizeRendererMountOptions` 严格校验（`normalizeRcloneSize` / `validateCacheMode`）后才进入 rclone
命令行——未知键一律丢弃，非法值直接报错，`rclonePath` 等危险键渲染层永远碰不到。

VFS 磁盘缓存固定落在 `%LOCALAPPDATA%\QuarkDrive\vfs-cache`（`config.paths.cacheDir`，构建栈时自动创建），
设置页「清理缓存」可在**卸载后**清空该目录（`isInside` 路径防护 + 挂载中禁用，防止误删 rclone 正在写的文件）。
修改缓存大小/模式后**重新挂载生效**（界面会提示）。

### 6. 下载 URL 缓存（quark-fs.js）
预签名 CDN URL 按 fid 缓存 5 分钟（256 条 LRU）：Explorer 预览、rclone 读前移
重复打开不再每次打 API。CDN 返回 403/404 时淘汰并重取一次。

### 7. 主进程与安装
- `findRclone`/`checkWinFsp` 改异步（原 `execFileSync` 同步阻塞 UI 最多 ~165ms）。
- 挂载/卸载/服务器操作串行化（在途锁），并发点击不再产生孤儿 rclone。
- 分页列表 `_size` 100→500、页数上限 200→1000 且截断告警。

## 复现

```bash
node scripts/bench.js          # 完整（2000 条目，~40s）
node scripts/bench.js --quick  # 快速（500 条目，~10s）
node scripts/bench.js --json   # 结果写入 %TEMP%\quarkdrive-bench.json
```

## 已知边界（诚实声明）

- 本沙箱**禁止回环连接的响应方向**到达非 Node 子进程（实证：rclone 的
  PROPFIND 到达服务器、服务器正常 207，但 rclone 侧永远收不到响应而超时），
  因此**真实 rclone 挂载冒烟在本环境不可执行**；上轮审计报告中"真实挂载通过"
  是在此前环境完成的。本轮改动通过：RC API 选项名静态核验（`rclone help flags`）、
  假 RC 端到端测试（含新 vfsOpt 全量断言）、以及协议语义不变的差分测试来保证。
- loopback 基准省内核拷贝，GET/PUT 的 MB/s 数字是上限而非真实网络表现。
- 并行上传未对真实夸克 OSS 端点验证（需真人扫码账号）；其正确性依赖：
  ctx 预计算（差分测试验证每片 ctx = 前序分片的新鲜 SHA-1）、OSS 多部分本身
  与顺序无关、以及 `pre` 响应中 `parallel_upload/part_thread` 的官方语义。
