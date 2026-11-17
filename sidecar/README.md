# 视频解析侧车

这是独立运行的 HTTP 服务，负责下载视频、抽帧和获取 B 站文字线索。**不要放进 plugins 目录。** 机器人通过 HTTP 调用它，内置的 sidecar-control 子插件负责可选的启动与状态管理。

源码随 Git 仓库提供，当前 npm 插件包不含此目录。功能与依赖总览见 [语音唱歌与解析侧车](../docs/定制-语音唱歌与侧车.md)。

## 依赖与使用者

- Node.js 22+；脚本没有额外 npm 依赖。
- ffmpeg + ffprobe：抽帧、探时长、媒体处理。
- yt-dlp：下载 B 站媒体，可用独立可执行文件或 Python 模块。

| 子插件 | 用途 |
|---|---|
| video-read | QQ 视频附件 → 画面帧 |
| video-link-read | B 站链接 / BV 号 → 下载与抽帧 |
| video-wander | 当前对话、后台或定时观看 |
| link-parser | 下载链接里的媒体并发送到 QQ |
| sidecar-control | 查看状态、手动启动、可选自动拉起 |

当前链接平台以 B 站为主，**抖音支持已下线**。实际可访问域名、直链和本地路径仍受配置与校验限制。

## 启动

在仓库目录中手动运行：

~~~sh
node sidecar/server.mjs
~~~

Windows 也可使用 sidecar/start.bat。登录自启脚本为 sidecar/install-autostart.ps1；Linux 可由自己的服务管理器托管。

也可以将源码部署到实例数据目录中的 sidecar，或在控制台设置 sidecarDir。之后通过「侧车运维」相关按钮或主人命令 `/sidecar start` 启动。`autoStart` 默认关闭，开启后由插件检查并尝试拉起；已经交给外部服务管理器时不必重复启用。

默认监听 `http://127.0.0.1:3972`。端口、路径和限额配置在 sidecar.config.json；重启后按配置运行。侧车向机器人返回本地路径，同机或共享文件系统部署最直接；跨机器使用要保证这些路径对机器人同样可读。

## 只读自检

~~~sh
curl http://127.0.0.1:3972/health
~~~

关注 `ok`、`ffmpeg`、`ffprobe`、`ytdlp` 等字段。HTTP 可达不代表下载、模型看图等完整功能都已验证。健康检查会探测工具可用性，不调用聊天模型或发 QQ 消息。配置 token 后，自检也要带对应的 x-token 请求头。

## HTTP 接口

| 接口 | 作用 | 是否写入 / 执行任务 |
|---|---|---|
| `GET /health` | 进程与依赖状态 | 只读探测 |
| `POST /read` | 下载或定位视频、探时长、抽帧，可附字幕 | 执行媒体任务 |
| `POST /parse` | 下载链接中的媒体 | 执行媒体任务 |
| `POST /extras` | 获取 B 站简介、章节、评论等文字线索 | 访问外部内容 |
| `POST /config` | 保存允许修改的字幕、cookie 和文字线索配置 | 写配置，不是只读检查 |

### /read 示例

~~~json
{
  "url": "https://b23.tv/EXAMPLE",
  "platform": "bilibili",
  "frames": 8,
  "maxSide": 1024,
  "maxSeconds": 600
}
~~~

成功返回 `ok:true`、标题、时长和 `frames` 数组；每帧包含 `path`、`sec`、`bytes`。机器人读取这些文件后交给模型。帧数与时长同时受请求和侧车配置限制。

### /parse 示例

~~~json
{
  "url": "https://b23.tv/EXAMPLE",
  "session": "group:10001",
  "limit": 3
}
~~~

成功返回 `media` 数组，每项包含 kind、path、size；跳过的媒体可见 skipped。它返回媒体路径，实际发 QQ 由插件完成。

### 错误与鉴权

业务失败通常返回 HTTP 200 与 `ok:false, code, error`，例如 too_long、too_big、busy、download_failed。配置 token 后，鉴权失败返回 401；不存在的接口返回 404。调用方应同时检查 HTTP 状态和响应内容。

## 配置与排查

- ffmpegPath、ffprobePath、ytdlpPath 可显式指定程序路径；pythonPath 用于调用 Python 版 yt-dlp。
- 默认绑定本机回环地址；下载地址与本地文件受白名单和路径检查限制。
- 下载与抽帧结果通过缓存复用，按 TTL 和总量限制清理；不能在响应后立即删除文件，机器人还需要读取。
- B 站下载失败时区分网络、账号权限、视频可用格式和工具版本；不要把某次无需登录的成功当成所有视频都不需要 cookie。
- cookie、token、真实路径和下载结果属于实例数据，不提交到仓库。

具体接口行为以 [server.mjs](server.mjs) 为准；机器人侧的功能开关与调用参数见 [定制功能说明](../docs/定制-语音唱歌与侧车.md)。
