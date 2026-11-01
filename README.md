# QuarkDrive — 夸克网盘本地硬盘

把**夸克网盘**挂载成本地磁盘（如 `Q:`）：扫码登录、一键安装，之后就能在文件资源管理器里像本地磁盘一样浏览、打开、拖拽上传夸克网盘的文件。

> ⚠️ **非官方项目**。通过逆向桌面客户端协议实现，夸克可能随时调整接口或风控策略，届时需要适配。仅供个人学习研究使用，请遵守夸克用户协议，勿用于分享侵权内容。

---

## 功能

- **扫码登录** — 桌面端展示二维码，夸克 APP 扫一扫即登录（无密码输入，令牌按机密处理）
- **本地盘符挂载** — `Q:` 盘出现在文件资源管理器，支持浏览/读取/写入/新建文件夹/重命名/移动/删除
- **一键安装** — 单个 `QuarkDrive Setup.exe`：自动安装 WinFsp 驱动、内置 rclone、装完即用
- **大文件支持** — OSS 分片上传（服务端指定分片大小，1–64 MiB 钳制）+ 秒传（哈希命中）
- **托盘常驻** — 最小化到托盘，支持开机自启、启动自动挂载
- **安全默认** — 会话 Cookie 仅存本机 0600 文件、WebDAV 服务仅监听回路环口且带随机令牌、日志脱敏

## 安装（用户）

1. 下载发布页的 `QuarkDrive Setup 0.1.0.exe`
2. 双击运行（需要管理员权限 — 用于安装 WinFsp 文件系统驱动）
3. 安装完成后自动启动，**用夸克 APP 扫描窗口中的二维码**
4. 扫码成功后自动挂载到 `Q:`（可在设置里改盘符）

## 使用

```
资源管理器 → 此电脑 → Q:\    浏览 / 打开 / 复制粘贴 / 拖拽上传
```

- 上传：把文件拖进 `Q:` 对应目录即可（大文件会分片上传）
- 卸载/挂载：托盘图标右键，或主界面按钮

## 开发者

### 环境要求

- Windows 10/11 x64、Node.js ≥ 20、Python 无需
- 构建：`npm install`（Electron 经 npmmirror 镜像：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`）

### 命令

```bash
npm install                # 安装依赖
npm run vendor             # 下载 rclone.exe + winfsp.msi（SHA256 校验）
npm test                   # 158 项测试（node:test，零外部依赖）
npm run smoke:mount        # 真机挂载冒烟（需要 WinFsp + rclone）
npm start                  # 开发模式启动 Electron
npm run dist               # 打包一键安装器
```

### 架构

```
┌──────────────────────── Electron 应用（app/）────────────────────────┐
│  渲染层（登录二维码 / 容量 / 挂载控制 / 设置）  ← contextBridge 白名单桥  │
│  主进程（托盘 / IPC / 生命周期）                                        │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ 进程内调用
┌───────────────────────────────▼───────────────────────────────────────┐
│  纯 Node 核心（core/，零依赖）                                          │
│    quark/   扫码登录 · 云盘 API · OSS 分片上传 · 纯 JS SHA1            │
│    webdav/  自研 WebDAV 服务器（127.0.0.1 + 随机令牌 + Host 校验）      │
│    mount/   rclone RC 生命周期（rcd + mount/mount + listmounts）       │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ HTTP（PROPFIND/GET/PUT/MOVE/…）
                    rclone（vendor/rclone.exe）
                                │ WinFsp 驱动
                            本地盘符 Q:
```

详细设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，接口笔记见 [docs/API-NOTES.md](docs/API-NOTES.md)，安全模型见 [docs/SECURITY.md](docs/SECURITY.md)，安全审计报告见 [docs/AUDIT.md](docs/AUDIT.md)。

## 测试与验证

- `npm test` — 158 项单元/集成测试（含 mock Quark 后端的完整 WebDAV 协议套件）
- `npm run smoke:mount` — 真机挂载冒烟：rclone + WinFsp 挂载 `Q:` 后验证列表/读/写/建目录/优雅卸载
- `npm run dist` 后 `node scripts/verify-package.js` — 校验 asar 打包内容
- 已验证边界与未覆盖范围（真人扫码、沙箱 GUI 限制）见 [docs/AUDIT.md](docs/AUDIT.md) 第 5 节

## 目录结构

```
quark-drive/
├── app/            Electron 外壳（main/preload/renderer）
├── core/           纯 Node 核心（零依赖，可独立 CLI 运行）
├── tests/          node:test 测试（unit + integration + helpers）
├── scripts/        fetch-vendor / make-icon / installer.nsh / 冒烟与校验脚本
├── docs/           架构 / API 笔记 / 安全 / 审计报告
└── vendor/         rclone.exe + winfsp.msi（构建时下载，不入库）
```

## 致谢

协议参考了社区开源实现（QuarkPanTool、kuake_cli、GoQuark、quark-auto-save 等）的公开接口分析；挂载栈基于 [rclone](https://rclone.org/) 与 [WinFsp](https://winfsp.dev/)（均为 MIT/BSD 系开源项目）。

## 许可证

[MIT](LICENSE)
