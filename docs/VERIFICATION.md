# 验证记录

所有命令可在 Windows + Node ≥ 20 环境复现。

## 自动化验证

| 验证 | 命令 | 结果 |
|---|---|---|
| 单元 + 集成测试 | `npm test` | **158/158 通过** |
| 真机挂载冒烟 | `npm run smoke:mount`（需 WinFsp + rclone） | **PASSED** |
| 打包内容校验 | `node scripts/verify-package.js` | **15/15 必需文件；无测试/vendor/机密泄漏** |
| 一键安装器构建 | `npx electron-builder --win nsis` | **QuarkDrive Setup 0.1.0.exe（137.1 MB）+ blockmap** |
| 生产依赖漏洞 | `npm audit --omit=dev` | **0 vulnerabilities** |

### 测试构成

- **单元**：device / http（cookie、重定向、鉴权）/ auth（扫码四步全流程）/ api（列表、下载任务轮询、23018 回退、增删改移）/ sha1ctx（RFC 2202 向量 + crypto 交叉 + 状态导出）/ upload（OSS 全流程、秒传、409 恢复、Hash-Ctx）/ xml（转义、Range、Destination）/ quark-fs（缓存、并发、覆盖语义）/ rclone（RC 生命周期、注入防护）/ config / index（CLI、脱敏、轮转）/ app-contract（IPC 通道、DOM ID、加固断言）
- **集成**：mock Quark 后端 + 真实 HTTP 的完整 WebDAV 协议套件（21 项，含原始 socket 穿越测试）
- **审计回归**：`tests/unit/audit-regressions.test.js`（本轮维护者发现）+ `tests/unit/audit-findings.test.js`（独立审查 18 项发现）

## 真机验证（本机，2026-11-02）

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

## 真实 API 可达性（无需账号的部分）

```
getTokenForQrcodeLogin  → OK（真实令牌）
getServiceTicketByQrcodeToken → "waiting"（无人扫码，符合预期）
member（无会话）→ 403 → AuthError（鉴权检测正确）
```

## 无法在本环境验证的部分（诚实声明）

1. **Electron GUI 与安装器执行**：本沙箱阻止 GUI 进程启动。二进制本身正常（`ELECTRON_RUN_AS_NODE=1 electron.exe -e …` 可用），NSIS 脚本编译、asar 完整性、打包内容均通过静态验证；应用逻辑用 IPC/DOM 契约测试覆盖。**在正常 Windows 桌面上首次运行前，这一点未经真实验证。**
2. **真人扫码后的端到端**：列目录/下载/上传的真实云端往返需要夸克 APP 扫码。已实现严格按参考实现的响应结构做 mock 回归；协议层（请求构造、错误路径、任务轮询）有完整单测。
3. **WinFsp 静默安装钩子**：NSIS 宏已编写（`scripts/installer.nsh`），因安装器无法在本环境执行而未真机运行。

## 复现建议（在有显示器的 Windows 机器上）

```bash
npm install && npm run vendor
npm test                    # 应 158/158
npm run smoke:mount Q       # 应 SMOKE TEST PASSED
npm start                   # 扫码登录 → 自动挂载 → 资源管理器浏览 Q:
npm run dist                # 生成安装器；双击安装（观察 WinFsp 提示与快捷方式）
```
