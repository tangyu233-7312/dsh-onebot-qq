#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""tts_say.py — 「一段文本 -> 一个 silk 文件」，给 Node 插件当后端。

为什么拆成独立脚本：
  转码链（ffmpeg -> PCM -> pysilk -> silk 头校验）在旧机器人 `voiceout.py` 里已经
  真机跑通过（tts_cache/ 里 20 个 silk 可查），重写成 JS 只会引入新 bug。
  这里只把「音源」抽成可换的后端，后面两步原样照抄。

后端：
  · edge       —— 微软在线朗读，免费无 key（旧机器人的方案，立即可用）
  · mimo-voicedesign —— 小米 MiMo 文字描述设计音色（无需样本）
  · mimo-builtin     —— 小米 MiMo 内置音色（冰糖/茉莉/苏打/白桦）
  · mimo-clone       —— 小米 MiMo 音频样本克隆

调用（单次，无状态）：
  python tts_say.py --json '{"text":"...","backend":"edge",...}'
  python tts_say.py --json-file req.json
  python tts_say.py --probe                     # 只报能力，不合成

输出（stdout，一行 JSON）：
  成功：{"ok":true,"silk":"<绝对路径>","bytes":7498,"dur":2.1,"backend":"edge","detail":{...}}
  失败：{"ok":false,"reason":"...","backend":"edge"}
  退出码永远是 0（失败靠 ok 字段判）—— 调用方不该因为 TTS 失败就当整个回复失败。
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

SR = 24000          # QQ 语音统一 24k 单声道；MiMo 与 edge 都能给到这个采样率
SILK_HEAD = b"\x02#!SILK_V3"

MIMO_BASE = "https://api.xiaomimimo.com/v1"
MIMO_MODELS = {
    "mimo-voicedesign": "mimo-v2.5-tts-voicedesign",
    "mimo-builtin": "mimo-v2.5-tts",
    "mimo-clone": "mimo-v2.5-tts-voiceclone",
}


class SayFail(Exception):
    pass


# ──────────────────────────────────────────────── 工具

def find_ffmpeg(hint: str = "") -> str:
    """找 ffmpeg：配置 → PATH → winget 常见位置。"""
    cands = []
    if hint:
        cands.append(hint)
    from shutil import which
    w = which("ffmpeg")
    if w:
        cands.append(w)
    cands += [
        r"C:\Users\%s\AppData\Local\Microsoft\WinGet\Packages" % os.environ.get("USERNAME", ""),
    ]
    for c in cands[:2]:
        try:
            if c and Path(c).is_file():
                return c
        except OSError:
            pass
    # winget 目录里再扫一层
    base = Path(cands[-1]) if len(cands) > 2 else None
    if base and base.is_dir():
        for p in base.glob("Gyan.FFmpeg*/**/bin/ffmpeg.exe"):
            return str(p)
    return w or ""


def to_pcm(ffmpeg: str, raw: bytes, suffix: str = ".bin") -> bytes:
    """任意音频字节 -> 24k 单声道 s16le PCM。"""
    if not ffmpeg:
        raise SayFail("没有 ffmpeg")
    with tempfile.TemporaryDirectory(prefix="tts-") as d:
        src = Path(d) / ("in" + suffix)
        src.write_bytes(raw)
        try:
            p = subprocess.run(
                [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
                 "-vn", "-ar", str(SR), "-ac", "1", "-f", "s16le", "-"],
                capture_output=True, timeout=120)
        except FileNotFoundError as e:
            raise SayFail(f"找不到 ffmpeg：{ffmpeg}") from e
        if p.returncode != 0 or not p.stdout:
            err = (p.stderr or b"").decode("utf-8", "replace").strip().splitlines()
            raise SayFail(f"ffmpeg 转码失败：{err[-1][:140] if err else '无输出'}")
        return p.stdout


def pcm_to_silk(pcm: bytes) -> bytes:
    """PCM(24k mono s16le) -> silk。头不对就本地报错，别发一条发不出声的语音。"""
    try:
        import pysilk
    except ImportError as e:
        raise SayFail(f"没装 pysilk：pip install pysilk") from e
    buf = io.BytesIO()
    try:
        pysilk.encode(io.BytesIO(pcm), buf, SR, SR)
    except Exception as e:  # noqa: BLE001
        raise SayFail(f"silk 编码失败：{e}") from e
    data = buf.getvalue()
    if len(data) < 16 or not data.startswith(SILK_HEAD):
        raise SayFail(f"silk 头不对：{data[:10]!r}")
    return data


# ──────────────────────────────────────────────── 文本清洗

_FILLERS = re.compile(r"[（(【\[][^）)】\]]{0,24}[）)】\]]")
_URL = re.compile(r"https?://\S+")
_MARK = re.compile(r"[*_`>#]")
# TTS 内联标签：(得意) [轻笑] 这类 —— 送给 TTS 用，但不能留给「要念的字」审查
_TAG_PAREN = re.compile(r"[（(][^\s）)]{1,8}[）)]")
_TAG_SQUARE = re.compile(r"\[[^\]]{1,8}\]")


def speakable(text: str) -> str:
    """聊天回复 -> 能念的话：去掉只给人看的记号。"""
    t = (text or "").strip()
    t = _URL.sub("", t)
    t = _FILLERS.sub("", t)
    t = _MARK.sub("", t)
    t = re.sub(r"[~～]+", "～", t)
    t = re.sub(r"\s*\n+\s*", "，", t)
    t = re.sub(r"\s{2,}", " ", t).strip(" ，,")
    return t


def strip_tts_tags(text: str) -> str:
    """剥掉内联标签，只留要念的字（给「最长的可念文本」判断用）。"""
    t = _TAG_SQUARE.sub("", text or "")
    t = _TAG_PAREN.sub("", t)
    return t.strip()


# ──────────────────────────────────────────────── 后端：edge

def synth_edge(text: str, voice: str, rate: str, pitch: str, ffmpeg: str) -> tuple[bytes, dict]:
    try:
        import edge_tts
    except ImportError as e:
        raise SayFail("没装 edge-tts：pip install edge-tts") from e
    import asyncio

    async def run() -> bytes:
        com = edge_tts.Communicate(text, voice, rate=rate or "+0%", pitch=pitch or "+0Hz")
        out = bytearray()
        async for chunk in com.stream():
            if chunk.get("type") == "audio":
                out.extend(chunk.get("data") or b"")
        return bytes(out)

    try:
        mp3 = asyncio.run(asyncio.wait_for(run(), 30))
    except asyncio.TimeoutError as e:
        raise SayFail("edge-tts 超时（30s）") from e
    except Exception as e:  # noqa: BLE001  断网/限流/音色下架
        raise SayFail(f"edge-tts 失败：{str(e)[:140]}") from e
    if not mp3:
        raise SayFail("edge-tts 没有音频输出")
    return to_pcm(ffmpeg, mp3, ".mp3"), {"voice": voice, "rate": rate, "pitch": pitch}


# ──────────────────────────────────────────────── 后端：小米 MiMo

def _mimo_post(payload: dict, api_key: str, timeout: int = 90) -> dict:
    req = urllib.request.Request(
        f"{MIMO_BASE}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {api_key}"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = (e.read() or b"").decode("utf-8", "replace")[:300]
        raise SayFail(f"MiMo HTTP {e.code}：{body}") from e
    except urllib.error.URLError as e:
        raise SayFail(f"MiMo 连不上：{e.reason}") from e
    except Exception as e:  # noqa: BLE001
        raise SayFail(f"MiMo 调用失败：{str(e)[:140]}") from e


def synth_mimo(text: str, backend: str, api_key: str, ffmpeg: str,
               voice_desc: str = "", voice: str = "", instruct: str = "",
               clone_audio_b64: str = "", clone_text: str = "") -> tuple[bytes, dict]:
    if not api_key:
        raise SayFail("没配 MiMo API Key")
    model = MIMO_MODELS.get(backend)
    if not model:
        raise SayFail(f"未知 MiMo 后端：{backend}")

    msgs: list[dict] = []
    # 风格指令（可选，任何 MiMo 后端都吃）
    if instruct.strip():
        msgs.append({"role": "user", "content": instruct.strip()})
    # voicedesign：user 段就是音色描述，必填
    if backend == "mimo-voicedesign":
        if not voice_desc.strip():
            raise SayFail("voicedesign 需要音色描述（voiceDesc）")
        msgs.append({"role": "user", "content": voice_desc.strip()})
    # voiceclone：官方示例里 user 段是**空字符串**但必须存在（不能只剩 assistant）
    if backend == "mimo-clone" and not msgs:
        msgs.append({"role": "user", "content": ""})
    msgs.append({"role": "assistant", "content": text})

    audio: dict = {"format": "wav"}
    if backend == "mimo-builtin":
        audio["voice"] = voice or "冰糖"
    if backend == "mimo-clone":
        if not clone_audio_b64:
            raise SayFail("voiceclone 需要参考音频（cloneAudio）")
        # 官方示例：参考音频是塞进 audio.voice 的 data URI，不是独立字段。
        # 形如  voice: "data:audio/wav;base64,<...>"
        fmt = str(voice or "wav").lstrip(".") or "wav"
        audio["voice"] = f"data:audio/{fmt};base64,{clone_audio_b64}"

    payload = {"model": model, "messages": msgs, "audio": audio}
    data = _mimo_post(payload, api_key)

    try:
        msg = data["choices"][0]["message"]
        b64 = msg["audio"]["data"]
    except (KeyError, IndexError, TypeError):
        raise SayFail(f"MiMo 返回里没有音频：{json.dumps(data)[:240]}")
    try:
        raw = base64.b64decode(b64)
    except Exception as e:  # noqa: BLE001
        raise SayFail(f"MiMo 音频 base64 解码失败：{e}") from e
    if len(raw) < 100:
        raise SayFail(f"MiMo 音频太短（{len(raw)} 字节）")
    suffix = ".wav" if raw[:4] == b"RIFF" else ".bin"
    return to_pcm(ffmpeg, raw, suffix), {"model": model, "voice": audio.get("voice"),
                                         "desc": voice_desc[:40], "fmt": suffix.lstrip(".")}


# ──────────────────────────────────────────────── 主流程

def do_say(req: dict) -> dict:
    backend = str(req.get("backend") or "edge").strip()
    text_in = str(req.get("text") or "")
    # 送 TTS 的是**带标签的原文**（标签要模型演出来），但判断「有没有能念的字」看剥完后
    speakable_raw = speakable(strip_tts_tags(text_in))
    if not speakable_raw:
        return {"ok": False, "reason": "洗完没有能念的字", "backend": backend}
    tts_text = req.get("text") or ""          # 保留标签给模型演
    tts_text = speakable(tts_text) if not req.get("keepTags") else tts_text

    ffmpeg = find_ffmpeg(str(req.get("ffmpeg") or ""))
    t0 = time.time()

    if backend == "edge":
        pcm, detail = synth_edge(
            tts_text,
            str(req.get("voice") or "zh-CN-XiaoyiNeural"),
            str(req.get("rate") or ""),
            str(req.get("pitch") or ""),
            ffmpeg)
    elif backend.startswith("mimo"):
        pcm, detail = synth_mimo(
            tts_text, backend,
            str(req.get("apiKey") or ""), ffmpeg,
            voice_desc=str(req.get("voiceDesc") or ""),
            voice=str(req.get("voice") or ""),
            instruct=str(req.get("instruct") or ""),
            clone_audio_b64=str(req.get("cloneAudio") or ""),
            clone_text=str(req.get("cloneText") or ""))
    else:
        return {"ok": False, "reason": f"未知后端：{backend}", "backend": backend}

    silk = pcm_to_silk(pcm)
    dur = len(pcm) / (SR * 2)

    # 落盘：调用方给 outDir 就放那儿（Node 要发完删），否则系统临时目录
    # ⚠️ 文件名必须带上「音色身份」（描述/音色名/指令），否则同一句话换个音色会算出
    #    同一个文件名、互相覆盖 —— 试音色时表现为「后一次把前一次吃掉」。
    out_dir = Path(req.get("outDir") or tempfile.gettempdir())
    out_dir.mkdir(parents=True, exist_ok=True)
    seed = "|".join([backend, str(req.get("voiceDesc") or "")[:200],
                     str(req.get("voice") or ""), str(req.get("instruct") or "")[:80],
                     str(req.get("tag") or ""), text_in])
    name = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:20] + ".silk"
    path = out_dir / name
    path.write_bytes(silk)

    out = {"ok": True, "silk": str(path.resolve()), "bytes": len(silk),
           "dur": round(dur, 2), "ms": int((time.time() - t0) * 1000),
           "backend": backend, "detail": detail}

    # saveWav：额外留一份 24k 单声道 wav。
    # 用途：voicedesign 每次都会重新生成音色（实测同一描述三次 f0 差 8.8%），
    # 所以「试出一个满意音色 → 存成 wav → 之后走 voiceclone 锁住」是唯一稳的路。
    if req.get("saveWav"):
        wav_path = out_dir / (name[:-5] + ".wav")
        import wave
        with wave.open(str(wav_path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(pcm)
        out["wav"] = str(wav_path.resolve())

    return out


def do_probe() -> dict:
    """报能力：哪些后端现在能用。不合成、不花钱。"""
    out: dict = {"ok": True, "backends": {}}
    try:
        import edge_tts  # noqa: F401
        out["backends"]["edge"] = {"ok": True}
    except ImportError as e:
        out["backends"]["edge"] = {"ok": False, "why": f"没装 edge-tts：{e}"}
    try:
        import pysilk  # noqa: F401
        out["backends"]["_silk"] = {"ok": True}
    except ImportError as e:
        out["backends"]["_silk"] = {"ok": False, "why": f"没装 pysilk：{e}"}
    ff = find_ffmpeg()
    out["ffmpeg"] = ff or ""
    out["sr"] = SR
    out["python"] = sys.executable
    return out


def main() -> int:
    args = sys.argv[1:]
    if not args:
        print(json.dumps({"ok": False, "reason": "没有参数（用 --json / --json-file / --probe）"},
                         ensure_ascii=False))
        return 0
    try:
        if args[0] == "--probe":
            print(json.dumps(do_probe(), ensure_ascii=False))
            return 0
        if args[0] == "--json-file":
            req = json.loads(Path(args[1]).read_text(encoding="utf-8"))
        elif args[0] == "--json":
            req = json.loads(args[1])
        else:
            # 兼容：直接把 JSON 当第一个参数传
            req = json.loads(args[0])
        print(json.dumps(do_say(req), ensure_ascii=False))
    except json.JSONDecodeError as e:
        print(json.dumps({"ok": False, "reason": f"参数不是合法 JSON：{e}"}, ensure_ascii=False))
    except SayFail as e:
        print(json.dumps({"ok": False, "reason": str(e)}, ensure_ascii=False))
    except Exception as e:  # noqa: BLE001  任何情况都别崩给调用方
        print(json.dumps({"ok": False, "reason": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
