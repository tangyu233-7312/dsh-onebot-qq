#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""audio2silk.py — 任意音频 → QQ 语音要的 silk 文件。

为什么单独一个脚本：
    插件跑在 Node 里，但 silk 编码只有 pysilk（Python）可靠。这里只做一件事，
    输出一行 JSON，Node 拿去读文件发 base64。

    QQ 语音是 silk 格式、24kHz 单声道。实测 260 秒的整首歌能一次发出去
    （770KB silk），但超过一定长度客户端可能播不动，所以调用方要自己控时长。

用法：
    python audio2silk.py <音频> [输出目录]
输出：
    {"ok":true,"silk":"<绝对路径>","bytes":N,"seconds":X}
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile

SR = 24000
SILK_HEAD = b"\x02#!SILK_V3"


def find_ffmpeg() -> str:
    from shutil import which
    return which("ffmpeg") or "ffmpeg"


def to_pcm(path: str, ffmpeg: str) -> bytes:
    p = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", path,
         "-vn", "-ar", str(SR), "-ac", "1", "-f", "s16le", "-"],
        capture_output=True, timeout=600)
    if p.returncode != 0 or not p.stdout:
        raise RuntimeError((p.stderr or b"").decode("utf-8", "replace")[-200:])
    return p.stdout


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "reason": "用法: audio2silk.py <音频> [输出目录]"}, ensure_ascii=False))
        return 0
    src = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else tempfile.gettempdir()
    try:
        if not os.path.isfile(src):
            raise RuntimeError(f"文件不存在: {src}")
        pcm = to_pcm(src, find_ffmpeg())
        import pysilk
        buf = io.BytesIO()
        pysilk.encode(io.BytesIO(pcm), buf, SR, SR)
        data = buf.getvalue()
        if not data.startswith(SILK_HEAD):
            raise RuntimeError(f"silk 头不对: {data[:10]!r}")
        os.makedirs(out_dir, exist_ok=True)
        import hashlib
        name = hashlib.sha1(os.path.abspath(src).encode("utf-8")).hexdigest()[:16] + ".silk"
        dst = os.path.join(out_dir, name)
        with open(dst, "wb") as f:
            f.write(data)
        print(json.dumps({
            "ok": True, "silk": os.path.abspath(dst), "bytes": len(data),
            "seconds": round(len(pcm) / (SR * 2), 2),
        }, ensure_ascii=False))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "reason": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
