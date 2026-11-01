# 夸克网盘接口笔记

> 来源：对桌面客户端协议的实测与社区开源实现（QuarkPanTool / kuake_cli / GoQuark / quark-auto-save）的公开分析交叉验证。非官方文档，可能随服务端调整失效。

## 基础

- API 主机：`https://drive-pc.quark.cn`（云盘）、`https://pan.quark.cn`（账号）、`https://uop.quark.cn`（登录 CAS）
- 公共查询参数：`pr=ucpro&fr=pc&sys=win32&ut=<machine_id>&mi=<device_name>`
- 公共头：`Cookie: <会话>`、`Referer/Origin: https://pan.quark.cn/`、桌面客户端 UA
- 会话 Cookie：`__puus`（必需）、`__pus`、`tfstk` 等；Set-Cookie 会轮换，需持续摄取
- 鉴权失效信号：HTTP 401/403、返回 HTML、业务码 `31001/31004`、`NO_AUTH`/`AUTH_ERROR*` → 需重新扫码

## 扫码登录

| 步骤 | 请求 |
|---|---|
| 1. 取令牌 | `GET uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?…` → `data.members.token` |
| 2. 二维码 | `https://su.quark.cn/4_eMHBJ?token=<t>&client_id=386&sch=pckk@information_ch&sve=3.24.0&ssb=weblogin&uc_param_str=&uc_biz_str=S:custom\|OPT:SAREA@0\|OPT:IMMERSIVE@1\|OPT:BACK_BTN_STYLE@0` |
| 3. 轮询 | `GET uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken?token=<t>` → `status`：`2000000` 已确认（`data.members.service_ticket`）/ `50004001` 等待 / `50004002` 过期 |
| 4. 换会话 | `GET pan.quark.cn/desktop/account/login?st=<ticket>&fr=pc&pr=ucpro&mi=..&ut=..` → Set-Cookie |

> 二维码 URL 本身是活令牌：不写日志、不持久化、UI 只渲染图片。

## 云盘操作

| 操作 | 方法与端点 | 说明 |
|---|---|---|
| 容量/会员 | `GET /1/clouddrive/member?fetch_subscribe=true&fetch_identity=true` | `use_capacity`/`total_capacity` |
| 账号 | `GET pan.quark.cn/desktop/account/userinfo`（回退 `/account/info?platform=pc`） | |
| 列目录 | `GET /1/clouddrive/file/sort?pdir_fid=<fid>&_page=1&_size=100&_fetch_total=1&_sort=file_type:asc,updated_at:desc` | `data.list[]`：`fid/file_name/size/dir/file_type/updated_at`；`dir=1` 或 `file_type=0` 为目录 |
| 下载 | `POST /1/clouddrive/file/download` `{fids:[fid]}` | 同步返回 `data[].download_url`；大文件异步返回 `data.task_id` → 轮询 `GET /1/clouddrive/task?task_id=..&retry_index=0` 至 `status=2`；错误 `23018` 用桌面 UA 重试 |
| 上传-pre | `POST /1/clouddrive/file/upload/pre` `{ccp_hash_update:true,parallel_upload:true,dir_name:"",file_name,format_type,l_created_at,l_updated_at,pdir_fid,size}` | 返回 `task_id/bucket/obj_key/upload_id/upload_url/auth_info/callback/metadata.part_size` |
| 上传-hash | `POST /1/clouddrive/file/update/hash` `{md5,sha1,task_id}` | `data.finish=true` = 秒传（文件已存在，跳过 commit） |
| 上传-auth | `POST /1/clouddrive/file/upload/auth` `{auth_info,auth_meta,task_id}` | 返回 OSS `Authorization`（auth_meta 按 OSS 签名规范拼装） |
| 上传-finish | `POST /1/clouddrive/file/upload/finish` `{obj_key,task_id}` | |
| OSS 分片 | `PUT https://<bucket>.<upload_url>/<obj_key>?partNumber=N&uploadId=..` | part≥2 需 `X-Oss-Hash-Ctx`（SHA-1 内部状态，base64 JSON：`h0..h4` 十进制串 + `nl/nh` 比特数高低 32 位 + `data/num` 挂起字节）；commit 为 `POST` 同 URL 带 `CompleteMultipartUpload` XML + `Content-MD5` + `x-oss-callback` |
| 建目录 | `POST /1/clouddrive/file` `{pdir_fid,file_name,dir_path:"",dir_init_lock:false}` | |
| 重命名 | `POST /1/clouddrive/file/rename` `{fid,file_name}` | |
| 移动 | `POST /1/clouddrive/file/move` `{action_type:1,exclude_fids:[],filelist:[fid],to_pdir_fid}` | |
| 删除 | `POST /1/clouddrive/file/delete` `{action_type:1,exclude_fids:[],filelist:[fid]}` | 目录递归删除 |

## 已知坑

- **时间戳**：秒级（<1e12 按秒，否则按毫秒）；畸形值必须钳制，否则 `toISOString()` 抛错会让整个目录列表 500。
- **目录判定**：`dir=1` 或 `file_type=0`；新账号字段可能缺失，需容错。
- **下载 URL**：CDN 预签名（`auth_key`），带过期时间；**不要把会话 Cookie 发过去**。
- **风控**：频繁异常请求会触发 403/HTML 登录页；此时按重新登录处理。
- **分片**：服务端 `metadata.part_size` 可能极端，客户端钳制到 1–64 MiB。
