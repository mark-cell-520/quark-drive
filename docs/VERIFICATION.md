# 验证记录

所有命令可在 Windows + Node ≥ 20 环境复现。

## 自动化验证

| 验证 | 命令 | 结果 |
|---|---|---|
| 单元 + 集成 + 稳定性测试 | `npm test` | **191/191 通过** |
| 性能基准 | `node scripts/bench.js` | 见 docs/PERFORMANCE.md |
| 打包内容校验 | `node scripts/verify-package.js` | **19/19 必需文件；无测试/vendor/机密泄漏** |
| 一键安装器构建 | `npx electron-builder --win nsis` | **QuarkDrive Setup 0.1.0.exe（137.1 MB）+ blockmap** |
| 生产依赖漏洞 | `npm audit --omit=dev` | **0 vulnerabilities** |

### 测试构成

- **单元**：device / http（cookie、重定向、鉴权、raw body 看门狗）/ auth（扫码四步全流程、abort 透传）/ api（列表、下载任务轮询、23018 回退、增删改移）/ sha1ctx（RFC 2202 向量 + crypto 交叉 + 状态导出）/ upload（OSS 全流程、秒传、409 恢复、Hash-Ctx、并发分片、线性摄入）/ xml（转义、Range、Destination、快速日期与原生逐字节一致）/ quark-fs（缓存、并发、覆盖语义、URL 缓存）/ rclone（RC 生命周期、注入防护、Basic auth、竞态锁、transfers）/ config / index（CLI、脱敏、轮转）/ app-contract（IPC 通道、DOM ID、加固断言、新功能接线）
- **集成**：mock Quark 后端 + 真实 HTTP 的完整 WebDAV 协议套件（含原始 socket 穿越测试）
- **稳定性**（`tests/stability/soak.test.js`）：100 并发 PROPFIND 风暴（响应体逐一比对）、混合并发 GET/PUT/PROPFIND/MKCOL/MOVE/DELETE 后命名空间一致性、下载中途断连 abort 上游且服务存活、10 类畸形请求（无 Host/异主机/未知方法/坏令牌/坏编码/坏 Range/异主机 Destination/穿越/双重编码）、单连接 keep-alive 50 连续请求、100 路写入后锁表归零、失败上传不死锁后续写
- **审计回归**：`tests/unit/audit-regressions.test.js` + `tests/unit/audit-findings.test.js`（两轮共 18+16+9 项发现的回归）

## 真机验证（本机，第一轮 2026-11-02）

```
环境：Windows 10 Enterprise LTSC 2021 · rclone v1.75.2 · WinFsp 2.1.25156（已安装驱动）

$ node scripts/mount-smoke.js Q
webdav on 127.0.0.1:54697
[mount] mounting Q:\ via rclone (rc 54698)
[mount] mounted Q:\ (pid 22492, rc 54698)
dir Q:\ -> ["big.bin","docs","sp ace.txt"]
read docs\a.txt -> "hello world"
read back smoke-test.txt -> "written through the mount"
mkdir smoke-dir -> OK
SMOKE TEST PASSED
NOTICE: Q:: Unmounted rclone mount     ← RC 优雅卸载（VFS 已 flush）
```

覆盖：RC 原生挂载 → 目录列表 → 读取 → 写入（VFS 缓存 → WebDAV PUT → 上传器）→ 建目录 → 优雅卸载。

## 第二轮验证（2026-11-02，本沙箱）

```
node --test                      → 191/191 通过（含 7 项稳定性测试）
node scripts/bench.js            → 全量基准（数字见 docs/PERFORMANCE.md）
rclone help flags                → --rc-user/--rc-pass/--vfs-* 选项名逐一核验存在
假 RC 端到端测试                  → Basic auth 断言 + 新 vfsOpt 全量断言 + 竞态锁
npm audit --omit=dev             → 0 vulnerabilities
```

**本轮沙箱新增限制（实证）**：回环连接的响应方向无法到达非 Node 子进程——
rclone 的 PROPFIND 到达服务器、服务器正常返回 207，但 rclone 侧永远超时
（`net/http: timeout awaiting response headers`）；Node 进程间回环通信正常。
因此本轮**无法重跑真实挂载冒烟**，挂载改动以上述静态核验 + 假 RC 测试 +
协议差分测试保证。详见 docs/AUDIT.md「环境限制」。

## 真实 API 可达性（无需账号的部分）

```
getTokenForQrcodeLogin  → OK（真实令牌）
getServiceTicketByQrcodeToken → "waiting"（无人扫码，符合预期）
member（无会话）→ 403 → AuthError（鉴权检测正确）
```

## 无法在本环境验证的部分（诚实声明）

1. **Electron GUI 与安装器执行**：本沙箱阻止 GUI 进程启动。二进制本身正常（`ELECTRON_RUN_AS_NODE=1 electron.exe -e …` 可用），NSIS 脚本编译、asar 完整性、打包内容均通过静态验证；应用逻辑用 IPC/DOM 契约测试覆盖。**在正常 Windows 桌面上首次运行前，这一点未经真实验证。**
2. **真人扫码后的端到端**：列目录/下载/上传的真实云端往返需要夸克 APP 扫码。已实现严格按参考实现的响应结构做 mock 回归；协议层（请求构造、错误路径、任务轮询）有完整单测。
3. **WinFsp 静默安装钩子**：NSIS 宏已编写并加强（日志/重试/安装后验证，`scripts/installer.nsh`），因安装器无法在本环境执行而未真机运行。
4. **并行分片上传对真实 OSS 的行为**：语义与串行版一致（差分测试验证每片 ctx），且官方协议本身并行（`parallel_upload`/`part_thread`），但未经真实端点验证。

## 复现建议（在有显示器的 Windows 机器上）

```bash
npm install && npm run vendor
npm test                    # 应 191/191
npm run smoke:mount Q       # 应 SMOKE TEST PASSED（需本沙箱限制外的环境）
npm start                   # 扫码登录 → 自动挂载 → 资源管理器浏览 Q:
npm run dist                # 生成安装器；双击安装（观察 WinFsp 提示与快捷方式）
node scripts/bench.js       # 性能基线
```
