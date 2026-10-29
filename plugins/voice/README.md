# voice — 语音 / 曲库 / 唱歌子插件

> [!WARNING]
> **默认全关。** 装进来是 `enabled: false` —— 整个插件不加载，
> `speak` / `sing` 两个工具都不会注册。
>
> 它依赖外部环境（Python + ffmpeg，唱歌还要 RVC + 自备音色模型 + 建议 N 卡），
> 没配好就开着，每次调用都会失败。**装法见 [../../docs/定制-语音唱歌与侧车.md](../../docs/定制-语音唱歌与侧车.md)。**
>
> 三个开关都要开：`enabled`（插件本身）→ `ttsEnabled`（念话）/ `singEnabled`（唱歌）。

## 两条路

| 路 | 工具 | 干什么 | 依赖 |
|---|---|---|---|
| **语音输出** | `speak` | 把一句话念成语音发出去 | Python + edge-tts 或 MiMo key；想换音色才需要 RVC |
| **唱歌** | `sing` | 点歌 → 曲库找歌 → 分离人声/伴奏 → RVC 只换人声 → 混回伴奏 → 语音 | RVC 能力包（`tools/singing-pack`）+ .pth 音色模型 + ffmpeg |

两条路**各自独立开关**，关掉唱歌不影响念话。

## 接口与默认值

| 配置项 | 默认 | 说明 |
|---|---|---|
| `enabled` | **false** | 插件总开关（本仓库定制） |
| `ttsEnabled` | **false** | 语音输出 |
| `singEnabled` | **false** | 唱歌 |
| `ttsPython` / `rvcPython` | `''` | 留空 = PATH 里的 `python`。**原版这里硬编码了开发机路径，本仓库已去掉** |
| `rvcDir` | `''` | 留空 = `<数据目录>/singing-pack` |
| `ttsMaxChars` | 60 | 单条念几个字 |
| `ttsPerTurn` | 1 | 每轮最多几条 |
| `singMaxSeconds` | 300 | 单首时长上限 |
| `singCooldownMin` | 10 | 点歌冷却（主人默认豁免） |
| `singMasterFree` | true | 主人点歌不限冷却 |

把 **蓝色大肥鱼** 的人设念出来：文本 → TTS → silk → QQ 语音段。

按 `dsh-onebot-qq` 的插件契约写（`id/title/order/configSchema/setup`），出站走 `bot.sendMedia`，
状态放 `bot.state` 的 `_scratch`，不 import kernel 内部实现。

## 目录

```
voice/
  index.js            插件主文件（契约形状，装进 plugins/voice/）
  scripts/tts_say.py  TTS 后端（Python：edge-tts / 小米 MiMo）
```

## 安装

```bash
node scripts/install-voice.mjs           # 复制到 plugins/voice/
node scripts/install-voice.mjs --remove  # 卸载
```

装完重启 DSH（或等配置热重载）。**装进去默认 `enabled: true` 但 `autoSpeak: false`**——
意思是模型多了一个 `speak` 工具可以主动发语音，但不会自动把每条回复都念一遍。

## 四个后端

| backend | 音色来源 | 需要 | 显存 |
|---|---|---|---|
| `edge` | 微软预置，靠 `rate`/`pitch` 调 | 无（免费无 key） | 0 |
| `mimo-voicedesign` | **文字描述生成音色** | MiMo API Key | 0 |
| `mimo-builtin` | 冰糖 / 茉莉 / 苏打 / 白桦 | MiMo API Key | 0 |
| `mimo-clone` | 音频样本克隆 | MiMo API Key + 参考音频 | 0 |

MiMo 申请：<https://platform.xiaomimimo.com/console/api-keys>（TTS 系列当前限时免费）。
Key 可填在插件配置，或实例 `config.json` 的 `credentials.mimoTts`。

## 音色怎么定

**edge 的天花板是物理的**：它只给 `voice`（选人，普通话女声只有晓晓/晓伊两个）、
`rate`、`pitch` 三个旋钮。`pitch` 动基频、`rate` 动时长，**碰不到共振峰**——
所以调参只能让同一个人说快说高，造不出新音色。

`voicedesign` 是另一个维度：用一段话描述「性别年龄 + 音色质感 + 情绪语调 + 语速节奏」，
模型直接生成音色。默认值已按人设写成：

> 二十岁出头的年轻女声，日系动画配音的质感，音色清亮里带一点软。
> 说话带着股聪明劲儿和得意，语速中偏快、咬字干净，句尾习惯轻轻上扬，像话还没说完。
> 被逗到或者心虚时会忽然软下来，声音变小，带一点气声和拖音。不甜腻，也不冷。

写法纪律（官方给的）：1–4 句就够；别写矛盾特征（「天真童声 + 总裁气场」）；
别写混响/EQ/压缩这类后期术语；别用「普通」「一般」这种空泛词。

## 情绪标签

`speak` 工具支持在文本里嵌标签，**只给 TTS 演，群里看不到**（`splitText()` 负责拆两份）：

| 人设触发 | 标签 |
|---|---|
| 办成了 / 得瑟 | `(得意)` `(俏皮)` |
| 求原谅 / 刚被夸 | `(撒娇)` |
| 被叫「大肥鱼」 | `(委屈)` |
| 认错 / 心虚 | `(心虚)` |
| 被冷落 | `(轻声)` `[叹气]` |
| 鼓腮顶回去 | `(嘴硬)` |
| 「嘿嘿」 | `[轻笑]` |

注意：**edge 后端不认标签**，会把 `(得意)` 当文字念出来。用 edge 时把 `keepTags` 关掉。

## 三条降级纪律

1. **TTS 挂了不影响文字**：合成失败只 `log.warn` + 返回 `{ok:false, reason}`，不抛错、不占本轮出站名额。
2. **超长拒念**：默认 60 字上限（人设是短句为主）。长文、报错、路径这类正经信息一律走文字。
3. **每轮限量**：默认 1 条（`perTurn`）。语音比文字「占耳朵」，一轮一条就够。

## 已验证 / 未验证

| 项 | 状态 |
|---|---|
| `splitText` 两份文本（标签不进群） | ✅ 测通 |
| edge 后端出合法 silk（`\x02#!SILK_V3` 头） | ✅ 测通（真实合成 5.7KB / 2.6s） |
| silk 经协议端发到群 | ✅ 真机验证（2026-10-24，真实群 + 真实 message_id） |
| 工具 execute 全流程 / 上限 / 降级 | ✅ mock bot 测通（10/10） |
| **voicedesign 音色** | ⏳ 待 MiMo Key |
| voicedesign 同参数多次调用音色是否一致 | ⏳ 待验（若每条都漂就不能用于群聊） |
| `mimo-clone` | ⏳ 参数未实测（文档页跳首页，字段名待确认） |
