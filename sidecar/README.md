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
  "subtitle": true,
  "subtitleMaxChars": 6000,
  "frames": 8,
  "maxSide": 1024,
  "maxSeconds": 600
}
~~~

成功返回 `ok:true`、标题、时长和 `frames` 数组；每帧包含 `path`、`sec`、`bytes`。机器人读取这些文件后交给模型。帧数与时长同时受请求和侧车配置限制。

字幕请求与返回字段见下面的「B 站字幕配置与排查」。

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

## B 站字幕配置与排查

视频画面、独立字幕轨和简介/评论是三种来源。抽到画面不能证明取得字幕；视频里烧录的文字也不一定有独立字幕轨。当前没有 ASR 语音识别回退，无字幕时仍可读取画面和可用文字线索。

### 控制台设置

1. 在「文件与图片 → B站链接 · 读哪些内容」开启「连字幕一起读」。配置键是 `pluginConfig.video-link-read.subtitle`，默认 true；`subtitleMaxChars` 默认 6000，范围 500–20000。
2. 在「链接解析 → 看视频（侧车）」填写 B 站 Cookie。字幕轨通常要求有效登录态；填写不代表视频一定有字幕。
3. 保持 link-parser 子插件加载。它共享登录态同步操作；媒体搬运功能开关可以关闭，观看前仍会同步给目标侧车。video-link-read 提供统一字幕设置，避免两处开关相互覆盖。

控制台保存的是配置，下一次观看前会尝试同步。实际结果要通过字幕状态和模型输入验证，不能只凭保存提示判断成功。

### 获取与更新 Cookie

在自己电脑的浏览器中登录 B 站，然后：

1. 打开一个 B 站视频，按 F12 打开开发者工具，选择「网络 / Network」。先打开工具再刷新页面，让请求列表出现。
2. 选择发往 `www.bilibili.com` 或 `api.bilibili.com` 的请求，例如页面文档或 `x/web-interface/nav`；不要选图片、视频分片或 OPTIONS 预检请求。
3. 单击请求名称，在右侧详情选择「标头 / Headers」（窄窗口可能收在 `»` 中）。展开「请求标头 / Request Headers」，找到 `Cookie`；别把响应里的 `Set-Cookie` 当成它。
4. 复制 Cookie 的值，即 `名称=值; 名称=值` 这一整串，直接粘贴到机器人控制台对应输入框并保存。不要带 `Cookie:` 前缀，不要用 `document.cookie` 代替，它可能取不到 HttpOnly 登录字段。
5. 若看不到请求详情，拉宽开发者工具并确认已单击一条请求；仍没有 Cookie 时，确认该站点已登录并重新刷新。登录态失效后重新获取并覆盖旧值。

Cookie 属于账号凭据，只存实例配置与侧车数据，不发到聊天、报告或 Git。侧车将控制台值转换为下载器使用的 `cookies.console.txt`；该文件、`cookies*.txt` 和侧车实例配置均不应入库。

### 请求与状态

`/read` 和 `/parse` 接受 `subtitle`；`/read` 还用 `subtitleMaxChars` 限制文本。显式请求优先于侧车默认值。`/parse` 下载得到的字幕轨与视频一起缓存，随后 `/read` 复用同一份记录；登录态或字幕开关变化后旧记录不再命中。

`/read` 返回 `subtitleStatus`，有正文时附 `subtitle: {text, chars, lines, truncated}`。`chars` 是返回 text 的长度，包含时间戳与换行；`lines` 是解析出的原始字幕条数。超过上限时按时间均匀取段，`truncated:true` 表示省略了内容。

| 状态 | 含义与处理 |
|---|---|
| `available` | 已取得可读字幕；继续确认插件将 text 放入输入材料 |
| `disabled` | 请求或侧车关闭字幕；检查统一开关与请求参数 |
| `login_required` | 下载器报告字幕需要登录；更新 Cookie 后重试 |
| `unavailable` | 未发现可用字幕轨；检查视频本身，不能仅据此认定登录失效 |
| `download_failed` | 视频可用，但字幕下载报错；查下载器版本、网络与权限 |
| `parse_failed` | 已有字幕文件，但没有解析出正文；检查字幕格式与文件完整性 |

下载阶段内部还会使用 `downloaded` 状态；`/read` 解析后转换为 available 或 parse_failed。字幕失败不应阻止已取得的视频画面交给模型。

### 验收顺序

1. 配置层：确认当前实例字幕开关与 Cookie 已同步，日志只记录“已填/未填”，不输出凭据。
2. 下载层：确认字幕轨实际下载，记录状态、语言和条数。
3. 接口层：检查 `/read` 的字幕状态、非空 text、条数与截断标记。
4. 缓存层：先 `/parse` 后 `/read`，确认复用视频时字幕仍在；更新登录态后确认不会复用无字幕旧记录。
5. 插件层：确认视频插件将字幕 text 加入 `ev.hint`，与帧一起提供给后续模型。可用发送桩验证输入，无需真的发 QQ 消息或调用模型。

健康检查、有效 Cookie、存在字幕文件或接口返回 ok 都不能单独证明整条链路完成。
