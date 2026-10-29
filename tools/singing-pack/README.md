# AI 翻唱能力包（通用接入文档）

一个**不绑定任何特定 Agent** 的歌声转换能力包：给它一首歌和一个音色模型，它把歌里的人声换成目标音色，保留原伴奏，输出成品音频。

它以**命令行工具**的形式提供，任何能执行本地进程的 Agent（或程序）都可以调用。**不依赖任何平台的专有能力**。

> 本包不含音色模型，也不含曲目。音色需要你自己准备——音色等同于某个人的声音，不应随意附带分发。

---

## 一、它做什么

输入：一首歌（本地音频文件）+ 一个音色模型（`.pth`）  
输出：同一首歌，人声换成目标音色，伴奏保留

### 原理（一句话）

歌声转换是对**整条音轨**做的。把伴奏一起喂进去，模型会连背景音乐一起"变声"，成品听着像在水里放歌。所以必须先拆轨：**只给人声换嗓子，再贴回原伴奏**。

```
本地曲库取音频
      │
      ▼
  Demucs 分离 ──┬─→ 人声轨 ──→ RVC 换音色 ──┐
                └─→ 伴奏轨（原样不动）──────┴→ 混音 → 成品音频
```

### 三步都在同一个命令里完成

1. **分离**：Demucs（`htdemucs`）把歌拆成人声轨和伴奏轨，带缓存
2. **变声**：RVC 只对人声轨做音色替换，自动补半音适配音域
3. **混音**：换好的人声 + 原伴奏叠加，补增益、防爆音、统一响度到 -14 LUFS

任何一步失败都会**自动降级**（分离失败→整轨直转，混音失败→纯人声），不会让整个任务失败。

---

## 二、使用前提

| 项目     | 要求                                     |
| ------ | -------------------------------------- |
| 系统     | Windows / Linux / macOS                |
| Python | **3.10 或 3.11**（3.12+ 部分依赖可能无预编译包）     |
| 显卡     | 推荐 NVIDIA（CUDA）。没有也能跑 CPU，**慢十几倍**     |
| 磁盘     | 约 6~10 GB（主要是 torch）                   |
| 音色模型   | `.pth` 文件，**自备**；可选同名 `.index` 提升音色相似度 |
| 曲库音频   | mp3 / wav / flac / m4a / ogg，**自备**    |

不需要手动安装 ffmpeg —— `imageio-ffmpeg` 自带二进制。

---

## 三、目录结构

```
singing-pack/
├─ README.md              本文档
├─ install.bat            Windows 一键装环境
├─ install.sh             Linux / macOS 一键装环境
├─ python/
│   └─ rvc-infer.py       核心脚本（install / info / infer 三个子命令）
├─ voice-models/          ★ 放你的 .pth 音色（可配同名 .index）
├─ songs/                 ★ 放你的歌
└─ skills/
    └─ singing/           参考封装示例（见第八节，非必须）
```

---

## 四、安装依赖环境

### Windows

```bat
install.bat                 :: 有 NVIDIA 显卡
install.bat --torch-cpu     :: 没独显（CPU 版 torch，体积小很多）
```

### Linux / macOS

```bash
chmod +x install.sh
./install.sh                # 有显卡
./install.sh --torch-cpu    # 无显卡
```

### 手动等价命令

```bash
python -m venv .venv
.venv/Scripts/python -m pip install --upgrade pip          # Windows
.venv/Scripts/python python/rvc-infer.py install           # Windows
# Linux/macOS 用 .venv/bin/python
```

装的东西只有两个：`rvc-python`（含 torch）和 `imageio-ffmpeg`。

---

## 五、准备素材

```
voice-models/
  我的音色.pth
  我的音色.index      ← 可选，强烈建议放，音色更像
songs/
  某首歌.mp3
```

文件名会成为音色名，Agent 调用时按名字选。

---

## 六、命令行用法（核心）

### 检查环境

```bash
.venv/Scripts/python python/rvc-infer.py info
```

返回 JSON，含 ffmpeg 路径、rvc-python 是否可用、推荐设备。

### 转换一首歌

```bash
.venv/Scripts/python python/rvc-infer.py infer ^
  -m "voice-models/我的音色.pth" ^
  --index "voice-models/我的音色.index" ^
  -i "songs/某首歌.mp3" ^
  -o "out/成品.mp3" ^
  --keep-bgm --auto-pitch --device cuda:0
```

Linux / macOS 把 `^` 换成 `\`，`.venv/Scripts/python` 换成 `.venv/bin/python`。

### 输出

stdout 最后一行是 JSON：

```json
{
  "ok": true,
  "output": "out/成品.mp3",
  "elapsedMs": 42310,
  "model": "voice-models/我的音色.pth",
  "index": "voice-models/我的音色.index",
  "device": "cuda:0",
  "pitch": 12,
  "sizeBytes": 4193280,
  "autoPitch": { "detectedHz": 118.4, "targetHz": 220, "shift": 12, "voicedRatio": 0.73 },
  "keepBgm": { "requested": true, "mixed": true, "vocalGain": 1.0, "instGain": 0.9 }
}
```

**判断成功**：`ok` 为 `true` 且 `sizeBytes > 0`。进度信息走 stderr，不污染这个 JSON。

---

## 七、参数速查

| 参数                  | 默认    | 说明                                                 |
| ------------------- | ----- | -------------------------------------------------- |
| `-m, --model`       | 必填    | 音色模型 `.pth`                                        |
| `-i, --input`       | 必填    | 输入音频                                               |
| `-o, --output`      | 必填    | 输出音频                                               |
| `--index`           | 空     | 同名 `.index` 检索索引，提升音色相似度                           |
| `--keep-bgm`        | 关     | **保留伴奏**：分离→只转人声→混回伴奏。不加则是纯人声                      |
| `--vocal-gain`      | 1.0   | `--keep-bgm` 时人声音量倍数（0~3）                          |
| `--inst-gain`       | 0.9   | `--keep-bgm` 时伴奏音量倍数（0~3，压一点突出人声）                  |
| `--auto-pitch`      | 关     | 自动检测基频并补半音。**男声配女声模型建议开**                          |
| `--pitch-target-hz` | 220   | 自动补调的目标基频。女声模型约 220，男声约 120                        |
| `--pitch`           | 0     | 手动变调半音数；开了 `--auto-pitch` 会被覆盖                     |
| `--device`          | 自动    | `cuda:0` 或 `cpu`。**CPU 必须精确写 `cpu`**，写 `cpu:0` 会报错 |
| `--f0-method`       | rmvpe | 基频提取算法：`harvest` / `crepe` / `rmvpe` / `pm`        |
| `--index-ratio`     | 0.75  | 检索特征占比（0~1）                                        |
| `--protect`         | 0.33  | 清辅音保护，越小越像目标音色、越可能咬字不清                             |
| `--version`         | v2    | 模型版本 v1 / v2                                       |
| `--ffmpeg`          | 自动找   | 手动指定 ffmpeg 路径                                     |

---

## 八、接入方式（三种，任选）

本包的核心是命令行，因此**任何 Agent 都能接**。下面三种方式按你的实际情况选。

### 方式 A：直接执行命令行（最通用）

任何能 spawn 进程的 Agent 都可以。要点：

1. 调用 `infer` 子命令，参数见上表
2. **必须设置环境变量 `PYTHONUTF8=1`**（Windows 下不设会因进度条里的非 GBK 字符直接崩掉子进程）
3. 读 stdout **最后一行** JSON 判断结果（前面会混着进度输出）
4. 转换耗时 40~90 秒（CPU 更久），给足超时时间

### 方式 B：封装成你的工具 / 技能

如果你的 Agent 有工具注册机制，把上面的调用包成一个工具即可。工具描述建议这样写（让模型知道何时该调）：

> 有人让你"唱《歌名》/来一段 XX"时用这个：它从曲库找这首歌，分离人声、换成指定音色、混回伴奏，输出成品音频。传歌名即可。曲库里没有就如实说没有，不要谎称唱了。不要用 TTS 念歌词冒充唱歌。

参数：歌名（必填）、音色名（可选）。

`skills/singing/` 是本包附带的一个**参考实现**（清单 + 入口 + 配置项），演示了配置化、音色扫描、曲库匹配、进程调用、结果解析的完整写法。**它不是唯一形态**，照着改成你自己的工具机制即可。

### 方式 C：包成 HTTP 服务（多 Agent 共用时）

把 `infer` 包一层 HTTP 接口，多个 Agent 或远程机器共用同一个环境：

```
POST /infer   body: { model, input, output, keepBgm, autoPitch, device }
→ 200 { ok, output, elapsedMs, ... }
```

适合：不想每台机器都装 6GB 依赖、或有多个 Agent 要用同一个音色的场景。

---

## 九、交给你的 Agent 执行

把下面这段**整段发给你自己的 Agent**。它会自己装环境、读本文档、完成接入、排错，直到跑通并给出可验证结果。

---

> **任务：把 AI 翻唱能力接入进来，并跑通一次完整流程**
>
> 能力包在 `singing-pack/`，先读它的 `README.md` 理解用法，再按下面执行。  
> **不要用 TTS 念歌词冒充唱歌**，也不要伪造结果——没跑通就说没跑通。
>
> **执行清单**
>
> 1. **确认环境**
>    ```bash
>    python --version          # 需要 3.10 或 3.11
>    ```
>    Windows 有 NVIDIA 显卡记下来（决定装 GPU 版还是 CPU 版 torch）。
> 2. **安装依赖**
>    ```bash
>    cd singing-pack
>    install.bat               # Windows 有显卡
>    install.bat --torch-cpu   # Windows 无显卡
>    ./install.sh              # Linux / macOS
>    ```
>    卡住或失败就自己看报错修（常见：Python 版本不对、网络超时、pip 权限）。
> 3. **验证环境**
>    ```bash
>    .venv/Scripts/python python/rvc-infer.py info
>    ```
>    必须拿到 `ok: true`。报错就定位修复后再往下。
> 4. **准备素材**
>    - 确认 `voice-models/` 下有 `.pth`（没有就向使用者要，或自己放一个合法的）
>    - 确认 `songs/` 下至少有一首音频
>    - 用 `list` 类命令或列目录确认文件名，后面调用要用
> 5. **跑通一次转换**
>    ```bash
>    .venv/Scripts/python python/rvc-infer.py infer ^
>      -m "voice-models/<音色>.pth" ^
>      --index "voice-models/<音色>.index" ^
>      -i "songs/<歌>.mp3" ^
>      -o "out/成品.mp3" ^
>      --keep-bgm --auto-pitch --device cuda:0
>    ```
>    无显卡把 `--device cuda:0` 换成 `--device cpu`（**必须是 `cpu`，不能写 `cpu:0`**）。
> 6. **接入到你的调用方式**  
>    按 README 第八节选一种（A 命令行 / B 封装工具 / C HTTP），让你的 Agent 能用一句自然语言（例如"唱《XX》")触发完整流程。  
>    封装时记得设置 `PYTHONUTF8=1`。
> 7. **端到端验证并给出结果**  
>    再跑一次，报告下面这些**可验证的事实**：
>    - `info` 的输出（环境 OK）
>    - 实际执行的完整命令
>    - `infer` 返回的 JSON（含 `ok`、`output`、`elapsedMs`、`sizeBytes`、`pitch`、`keepBgm.mixed`）
>    - 成品文件路径 + 字节数 + 时长
>    - 成品是否有伴奏（`keepBgm.mixed` 为 true，且听感上背景音乐存在）
> 8. **排错要求**  
>    遇到报错**自己定位并修复**，不要停下来问我。常见方向：
>    - 显存不足 → 脚本会自动清显存重试、再退 CPU；仍失败就关掉占显存的程序
>    - `batch_norm not implemented for 'Half'` → device 写成了 `cpu:0`，改成 `cpu`
>    - 子进程编码崩溃 → 没设 `PYTHONUTF8=1`
>    - 没有伴奏 → 看 stderr 有没有「分离失败，退回整轨直转」；干声源（本来就是纯人声）会主动跳过混音，属正常
>    - 音调偏低 → 加 `--auto-pitch`
> 9. **验收标准**
>    - `python/rvc-infer.py info` 返回 `ok: true`
>    - 一次 `infer` 返回 `ok: true` 且 `sizeBytes > 0`
>    - 用一句自然语言触发，能走通"找歌 → 转换 → 拿到成品"整条链路
>    - 成品能正常播放，且人声是目标音色、带原伴奏

---

## 十、排错

| 现象                                      | 原因 / 处理                                        |
| --------------------------------------- | ---------------------------------------------- |
| `info` 报缺 rvc-python                    | 依赖没装好，重跑 `install`                             |
| 显存不足                                    | 脚本会自动清显存重试 → 再退 CPU。仍失败就关掉浏览器/游戏               |
| `batch_norm not implemented for 'Half'` | `--device` 写成了 `cpu:0`，**必须写 `cpu`**           |
| 子进程崩、报 UnicodeEncodeError               | 没设环境变量 `PYTHONUTF8=1`                          |
| 成品没伴奏                                   | stderr 里会写「分离失败，退回整轨直转」。干声源（纯人声素材）会主动跳过混音，是正常的 |
| 音调明显偏低                                  | 加 `--auto-pitch`（男声配女声模型必开）                    |
| 男声歌高音破音                                 | 男声要先升 8 度再配女声模型，原曲高音顶到上界。这是原理决定的，不是 bug        |
| 转换很慢                                    | 没走 GPU。确认 `--device cuda:0` 且 torch 是 CUDA 版   |

---

## 十一、已知限制

1. **音色需自备**。本包不含任何音色模型。
2. **CPU 很慢**。一首 4 分钟的歌 GPU 约 40~90 秒，CPU 可能要几分钟到十几分钟。
3. **男声高音易破**：原理限制，见上表。
4. **分离有损**：拆轨再混音会损失一点能量，脚本已按原曲 RMS 补偿，但极个别素材可能仍有轻微音质下降。
5. **长歌耗时长**：建议控制在 5 分钟内。

---

## 十二、合规

- RVC、Demucs 及各自依赖的许可请自行确认后再使用。
- 音色若来自真人录音，涉及**声音权 / 肖像权**，必须取得授权。
- 输入曲目同样受版权约束，请勿分发成品。
- 本包只是编排与调用层，不承担上述责任。

---

## 十三、转发给别人前请删除

- `voice-models/` 里的音色（除非你明确授权给对方）
- `songs/` 里的歌（版权）
- `.venv/`（体积巨大，让对方自己装）
