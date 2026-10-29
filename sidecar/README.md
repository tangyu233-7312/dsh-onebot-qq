# 侧车：QQ 插件的「解析 / 看视频」外部服务

> **这不是子插件，不要拷进 `plugins/`。** 它是要在**另一个进程**里跑的小 HTTP 服务：
> `node server.mjs`（零 npm 依赖，Node 22+ 即可）。

## 配合哪个插件用

| 插件 | 在本仓库对应 | 说明 |
|---|---|---|
| `plugins/link-parser` | `POST /parse` | 主仓库已内置。装了侧车它才有用（不装就一直走"链接交给模型"的降级路径） |
| `plugins/video-read` | `POST /read` | 主仓库 PR #1。群里直接发的视频文件 → 抽帧给模型看 |
| `plugins/video-link-read` | `POST /read` | 主仓库 PR #1。B 站/抖音链接 → 下载抽帧给模型看 |

**装了侧车不代表插件就有**：上面三个插件是插件，本仓库是它们的"外部执行器"。

## 快速验证

```bash
node server.mjs
# 另开一个窗口
curl http://127.0.0.1:3972/health
```

看到 `{"ok":true,"ffmpeg":true,"ytdlp":true,...}` 就是好了。
`ffmpeg:false` 说明没找到 ffmpeg —— 启动日志里会说要怎么办。

## 它是干什么的

`dsh-onebot-qq` 的子插件跑在 DSH 宿主进程内，包内红线禁止 `child_process`。
但"把一段视频拆成几张图"必须调 `ffmpeg` / `yt-dlp` —— 所以把这件事挪到进程外，
插件只发 HTTP，两个服务之间只传**文件路径**和几行 JSON。

目前有两个消费者：

| 消费者 | 端点 | 用途 |
|---|---|---|
| `plugins/link-parser`（内置） | `POST /parse` | 把分享链接的媒体下载到本地，交给插件搬进群 |
| `plugins/video-read` / `plugins/video-link-read`（本 PR 新增） | `POST /read` | 下载/定位视频 → 探时长 → 抽 N 帧 → 返回帧路径，让模型"看得见"视频 |

## 启动

```bash
# 前台（看日志最方便）
node sidecar/server.mjs

# Windows 便捷脚本
sidecar\start.bat          # 启动
sidecar\stop.bat           # 停止（按端口找进程）
powershell -ExecutionPolicy Bypass -File sidecar\install-autostart.ps1   # 登录自启（可选）
```

默认监听 `http://127.0.0.1:3972`。改端口/路径/限额改 `sidecar/sidecar.config.json`，重启生效。

**依赖**：
- `ffmpeg` + `ffprobe`（抽帧、探时长）—— 没找到会在启动日志里直接说
- `yt-dlp`（下载 B 站/抖音）—— 可以用 `python -m yt_dlp`，也可以是可执行文件

启动日志会打印它找到了什么：

```
[sidecar 18:12:49] 监听 http://127.0.0.1:3972
[sidecar 18:12:49] ffmpeg: ffmpeg.exe
[sidecar 18:12:49] ffprobe: ffprobe.exe
[sidecar 18:12:49] yt-dlp: python -m yt_dlp
```

## 接口

三个端点，全部 `bind 127.0.0.1`。**失败一律 `200 + { ok: false, code }`**，
不返回 5xx —— 插件据此降级，不会因为侧车坏了把消息吞掉。

### `GET /health`

```jsonc
{ "ok": true, "version": "1.0.0",
  "ffmpeg": true, "ffprobe": true, "ytdlp": true, "ytdlpVersion": "2026.08.19",
  "queue": { "running": 0, "max": 2 }, "reuseMinutes": 10 }
```

### `POST /read` — 看视频

```jsonc
// 请求
{ "url": "C:\\...\\abc.mp4" 或 "https://b23.tv/xxxx",
  "platform": "file" | "bilibili" | "douyin",
  "frames": 8, "maxSide": 1024, "maxSeconds": 600 }

// 成功
{ "ok": true, "platform": "bilibili", "title": "…", "durationSec": 312,
  "frames": [{ "path": "C:\\tmp\\…\\00.jpg", "sec": 0, "bytes": 53859 }],
  "mediaPath": "C:\\tmp\\…\\x.mp4", "mediaBytes": 13232645,
  "note": "共 5 分 12 秒，抽 8 帧" }

// 失败
{ "ok": false, "code": "too_long|too_big|busy|nomatch|download_failed|denied|no_frames", "error": "…" }
```

### `POST /parse` — 解析分享链接（`link-parser` 在用）

```jsonc
// 请求
{ "url": "https://b23.tv/xxxx", "session": "group:123456", "limit": 3 }

// 成功
{ "ok": true, "platform": "bilibili", "platformName": "哔哩哔哩",
  "title": "…", "resourceId": "BV1…", "elapsedMs": 4200,
  "media": [{ "kind": "video", "path": "C:\\tmp\\…\\x.mp4", "size": 8423211 }],
  "skipped": [{ "kind": "image", "reason": "超过大小上限", "cover": "C:\\tmp\\…\\cover.jpg" }] }
```

## 设计上踩过的坑（改之前看一眼）

**安全** —— 群友能间接触发这个服务（发视频、贴链接），所以：

- **host 白名单 + 显式拒绝私网段**（防 SSRF：免得有人贴 `http://127.0.0.1:8080/admin` 让侧车去拉）
- **本地路径白名单**：`realpath` 之后必须落在系统临时目录 / 数据目录里，凭据文件读不到
- **命令永远用数组参数**（`execFile(cmd, [args])`），不拼命令行字符串
- **并发闸门**：同时最多 N 个任务，超了直接 `busy`，不排队（避免 QQ 线堆积）

**下载复用** —— `video-link-read` 抽帧和 `link-parser` 搬媒体会对**同一个 URL**各发一次请求。
所以 `/read` 和 `/parse` 共用一份 10 分钟下载缓存：实测第二次请求从 **8.8 秒降到 0.3 秒**。
下载下来的文件**不能立刻删**（紧接着要被搬进群），交给 TTL + 总量清理。

**额度在上游查** —— 侧车只管干活，限流/配额在插件侧（`perUserHour` / `perGroupHour`）。
插件是"先查额度、再发请求"，不会出现"先下 250MB 再说超限"。

**抖音要 cookie** —— yt-dlp 会报 `Fresh cookies ... are needed`。在 `sidecar.config.json` 里配
`cookiesFromBrowser`（借用浏览器已登录的 cookie）或 `cookiesFile`（导出的 cookies.txt）。
B 站不需要。

**画质取舍** —— `/read` 下 480p 就够（帧长边 1024），`/parse` 下 720p（群里看着要清楚）。

## 如果要把它做进包里

它现在是按「站点私有工具」写的。要进包需要改造：

1. **把"起进程 / 找 ffmpeg / 找 yt-dlp"的职责挪到部署侧**（包内红线禁止 `child_process`，
   而现在这里是靠 `execFile` 调 ffmpeg 的）；
2. 路径探测里有 Windows 便利逻辑（winget 安装位置），Linux/macOS 要补；
3. 端口、白名单、限额从 `sidecar.config.json` 收进正式配置项。

改动量不大，但要不要进包、以什么形态进（`bin/` 下的可执行？`ops` provider？独立仓库？）是设计取舍，
所以先以参考实现的形式提出来。
