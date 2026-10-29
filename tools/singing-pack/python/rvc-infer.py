#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
RVC 音色转换 CLI —— 供 QQ Bridge 调用。

本脚本不自己实现推理核心，而是封装 rvc-python（pip 包，自带 CLI 与推理实现），
负责三件事：
  1. 环境自检（info）：python / rvc_python / torch / ffmpeg 是否就位，缺什么说清楚；
  2. 一键装依赖（install）：装 rvc-python + imageio-ffmpeg（后者自带 ffmpeg 二进制，
     省去手动下载 ffmpeg 的麻烦）；
  3. 执行转换（infer）：把语义化参数翻译成 rvc_python 的参数，自动做 mp3↔wav 转码，
     输出 JSON 给桥接解析。

用法：
  python rvc-infer.py info
  python rvc-infer.py install
  python rvc-infer.py infer -m 模型.pth -i 输入.mp3 -o 输出.mp3 --pitch 0

退出码：0 成功；1 失败；2 环境缺失（ install 可解决）。
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time

# Windows 控制台默认 GBK，强制 utf-8 避免中文报错乱码
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

REQUIRED_PIP = ["rvc-python", "imageio-ffmpeg"]


def _import_module(name):
    try:
        __import__(name)
        return True, None
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


def find_ffmpeg(extra_path=""):
    """找到可用的 ffmpeg 可执行文件。优先级：配置路径 → PATH → imageio-ffmpeg 自带。"""
    if extra_path and os.path.isfile(extra_path):
        return extra_path, "config"
    found = shutil.which("ffmpeg")
    if found:
        return found, "PATH"
    ok, _ = _import_module("imageio_ffmpeg")
    if ok:
        try:
            import imageio_ffmpeg  # noqa: WPS433

            exe = imageio_ffmpeg.get_ffmpeg_exe()
            if exe and os.path.isfile(exe):
                return exe, "imageio-ffmpeg"
        except Exception:  # noqa: BLE001
            pass
    return None, None


def cmd_info(args):
    ok_rvc, err_rvc = _import_module("rvc_python")
    ok_torch, err_torch = _import_module("torch")
    ffmpeg, src = find_ffmpeg(args.ffmpeg)
    cuda = False
    if ok_torch:
        try:
            import torch  # noqa: WPS433

            cuda = torch.cuda.is_available()
        except Exception:  # noqa: BLE001
            pass
    payload = {
        "ok": ok_rvc and ok_torch and bool(ffmpeg),
        "python": sys.executable,
        "pythonVersion": sys.version.split()[0],
        "rvcPython": {"installed": ok_rvc, "error": err_rvc},
        "torch": {"installed": ok_torch, "error": err_torch},
        "ffmpeg": {"path": ffmpeg, "source": src},
        "cudaAvailable": cuda,
        "device": ("cuda:0" if cuda else "cpu:0"),
    }
    missing = []
    if not ok_rvc:
        missing.append("rvc-python")
    if not ok_torch:
        missing.append("torch（rvc-python 会自动带，若没装请手动装）")
    if not ffmpeg:
        missing.append("ffmpeg（或用 imageio-ffmpeg 自动提供）")
    payload["missing"] = missing
    payload["hint"] = (
        "环境已就绪。" if not missing else "缺依赖，执行：python %s install" % os.path.basename(__file__)
    )
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if payload["ok"] else 2


def cmd_install(args):
    py = sys.executable
    cmds = [[py, "-m", "pip", "install", "--upgrade"] + REQUIRED_PIP]
    if args.torch_cpu:
        # 无 NVIDIA 显卡时显式装 CPU 版 torch，体积小很多
        cmds.insert(
            0,
            [
                py,
                "-m",
                "pip",
                "install",
                "torch",
                "torchaudio",
                "--index-url",
                "https://download.pytorch.org/whl/cpu",
            ],
        )
    for c in cmds:
        print(">>>", " ".join(c))
        rc = subprocess.call(c)
        if rc != 0:
            print(json.dumps({"ok": False, "failedCommand": c}, ensure_ascii=False))
            return 1
    print(json.dumps({"ok": True, "installed": REQUIRED_PIP}, ensure_ascii=False, indent=2))
    print("装好了，再跑一次 info 确认。")
    return 0


def _transcode(src, dst, ffmpeg, extra=None):
    cmd = [ffmpeg, "-y", "-i", src]
    if extra:
        cmd += extra
    cmd += [dst]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0 or not os.path.isfile(dst):
        tail = proc.stderr.decode("utf-8", "replace")[-400:]
        raise RuntimeError("转码失败：%s → %s\n%s" % (src, dst, tail))
    return dst


def detect_pitch_shift(wav_path, target_hz=220.0):
    """分析输入音频的基频中位数，算出该补几个半音（按八度取整）。

    解决的真问题：**男声输入 + 女声模型**。男声基频中位数约 110~130Hz，女声模型的目标
    音域约 200~240Hz，差约一个八度；不补调的话转换结果全程偏低，像男声硬夹嗓子。

    规则（只修「真差一个八度」的情况，和 RVC 社区实践一致：男→女 +12，女→男 -12）：
      比值 = target_hz / 输入中位基频
      半音数 = round(log2(比值)) * 12，但仅当 log2(比值) 离某个整数不到 0.25 个八度时才采用
    ——即输入确实在「目标音域的整八度边上」才对齐。实测依据：男声 ~120Hz 配女声模型
    220Hz（比值 1.83，log2=0.87，离 1 只差 0.13）→ +12；而 350Hz 的高女声（比值 0.63，
    log2=-0.67，离 -1 还差 0.33）→ 不动它（硬压 -12 等于把高女声摁进男声区，那才是事故）。
    纯音乐/噪声（浊音帧占比过低）不猜，返回 0。
    """
    import math

    import numpy as np
    import soundfile as sf

    try:
        import pyworld as pw  # noqa: WPS433
    except Exception:
        return 0, None, None

    try:
        x, sr = sf.read(wav_path, dtype="float64")
    except Exception:
        return 0, None, None
    if x.ndim > 1:
        x = x.mean(axis=1)
    n = len(x)
    if n < sr:  # 不足 1 秒，没有分析价值
        return 0, None, None

    # 整首跑 harvest 太慢（4 分钟约几十秒）；在 25%/50%/75% 处各采一段 8 秒，
    # 中位数对采样位置不敏感，足够可靠。
    seg = min(8 * sr, max(n // 3, sr // 2))
    medians = []
    voiced_ratio = 0.0
    frames_total = 0
    for frac in (0.25, 0.5, 0.75):
        s = int(n * frac)
        s = max(0, min(s, n - seg))
        chunk = x[s : s + seg]
        if len(chunk) < sr // 2:
            continue
        f0, _ = pw.harvest(chunk, sr, frame_period=10.0)
        voiced = f0[f0 > 60]  # 清音/噪声的基频估计无意义，滤掉
        frames_total += len(f0)
        voiced_ratio += len(voiced)
        if len(voiced):
            medians.append(float(np.median(voiced)))
    if not medians or frames_total == 0:
        return 0, None, None
    voiced_ratio /= frames_total
    if voiced_ratio < 0.15:  # 浊音太少：多半是纯音乐/噪声，不猜
        return 0, None, round(voiced_ratio, 3)
    median_hz = float(np.median(medians))
    ratio = target_hz / max(median_hz, 1.0)
    octaves = math.log2(ratio)
    nearest = round(octaves)
    # 只有「离整八度不到 0.25 个八度」才对齐：真·男女声互换；
    # 差得远的（如 350Hz 高女声对 220Hz 目标）保持原样，别瞎调。
    if abs(octaves - nearest) >= 0.25:
        return 0, median_hz, round(voiced_ratio, 3)
    shift = int(nearest * 12)
    if abs(shift) > 24:  # 极端值兜底
        shift = 0
    return shift, median_hz, round(voiced_ratio, 3)


def separate_vocals(src, cache_dir):
    """用 Demucs 把整首歌拆成「人声」和「伴奏」两条轨，带缓存。

    为什么要拆：RVC 是对**整条音轨**做音色替换，把伴奏一起喂进去会连音乐一起毁掉。
    正确做法是先分离，只把人声送去转换，最后再和原伴奏混回来（AI 翻唱的标准流程）。

    缓存：分离一次要十几秒到一两分钟（视显卡和时长），同一首歌不重复分离。
    失败时返回 (None, None)，调用方退回「整轨直转」（没伴奏，但至少能出声）。
    """
    import hashlib

    try:
        import torch
    except Exception:
        torch = None
    device = "cpu"
    if torch is not None:
        try:
            device = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            device = "cpu"

    # 分离模型名：htdemucs_ft 是 4 模型集成（fine-tuned），实测把「句末降调卡顿」
    # 的 f0 异常从 31 处降到 12 处（-61%），首次加载约 6 分钟、之后 10 秒/首。
    # 可用环境变量 RVC_DEMUCS_MODEL 改回 htdemucs。
    model_name = (os.environ.get("RVC_DEMUCS_MODEL") or "htdemucs_ft").strip() or "htdemucs_ft"
    try:
        # ⚠️ 缓存键必须带上模型名 —— 否则换了分离模型还会命中旧缓存，
        #    表现为「改了参数但效果没变」，极难排查。
        digest = "%s|%s|%s|%s" % (os.path.abspath(src), os.path.getsize(src),
                                  int(os.path.getmtime(src)), model_name)
    except Exception:
        return None, None
    key = hashlib.md5(digest.encode("utf-8")).hexdigest()[:16]
    work = os.path.join(cache_dir, key)
    vocals_cached = os.path.join(work, "vocals.wav")
    inst_cached = os.path.join(work, "no_vocals.wav")
    if os.path.isfile(vocals_cached) and os.path.isfile(inst_cached):
        return vocals_cached, inst_cached

    # 缓存上限：只留最近 20 首（每首两条 wav 约 70MB，不设上限会一直涨）。
    try:
        if os.path.isdir(cache_dir):
            entries = [(os.path.getmtime(os.path.join(cache_dir, d)), d) for d in os.listdir(cache_dir)]
            entries = [e for e in entries if os.path.isdir(os.path.join(cache_dir, e[1]))]
            if len(entries) > 20:
                entries.sort()
                for _ts, name in entries[:len(entries) - 20]:
                    shutil.rmtree(os.path.join(cache_dir, name), ignore_errors=True)
    except Exception:
        pass

    os.makedirs(work, exist_ok=True)
    cmd = [
        sys.executable, "-m", "demucs",
        "--two-stems=vocals", "-n", model_name,
        "--device", device, "-o", work, src,
    ]
    # ★ 2026-10-19：管道输出的编码问题。桥接用 execFile 捕获输出时 Windows 默认走 GBK，
    #   demucs/tqdm 会打印进度条里的非 GBK 字符，直接 UnicodeEncodeError 崩掉子进程
    #   （下载器就是这么挂的）。显式把子进程钉成 UTF-8，跟终端里手跑保持一致。
    env = dict(os.environ)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    proc = subprocess.run(cmd, capture_output=True, env=env)
    stem = os.path.splitext(os.path.basename(src))[0]
    got_v = os.path.join(work, model_name, stem, "vocals.wav")
    got_i = os.path.join(work, model_name, stem, "no_vocals.wav")
    if proc.returncode != 0 or not (os.path.isfile(got_v) and os.path.isfile(got_i)):
        tail = proc.stderr.decode("utf-8", "replace")[-300:]
        print("[warn] 人声分离失败（%s）：%s" % (proc.returncode, tail), file=sys.stderr)
        # 落盘一份：桥接只把成功的 stdout 交给上层，stderr 里的 warn 看不到，
        # 出了问题只能靠这个文件回溯（.sing-cache/sep-error.log）。
        try:
            with open(os.path.join(os.path.dirname(cache_dir), "sep-error.log"), "a", encoding="utf-8") as fh:
                fh.write("[%s] rc=%s device=%s src=%s\nfound=%s/%s\n%s\n\n" % (
                    time.strftime("%Y-%m-%d %H:%M:%S"), proc.returncode, device, src,
                    os.path.isfile(got_v), os.path.isfile(got_i), tail))
        except Exception:
            pass
        return None, None
    shutil.move(got_v, vocals_cached)
    shutil.move(got_i, inst_cached)
    shutil.rmtree(os.path.join(work, model_name), ignore_errors=True)
    # ★ 干声源判断：库里不少歌本来就是纯人声（比如「我的悲伤是水做的-人声」），
    #   分离出来的伴奏轨几乎是静音。这种情况再走混音只是白加一条静音轨，
    #   不如退回整轨直转（对干声来说那才是正确做法）。实测真伴奏 RMS≈0.22，
    #   纯人声源只有 0.001~0.002，阈值取 0.005 足够区分。
    try:
        import numpy as np
        import soundfile as sf
        inst, _sr = sf.read(inst_cached, dtype="float32", always_2d=True)
        inst_rms = float(np.sqrt(np.mean(inst.astype("float64") ** 2)))
        if inst_rms < 0.005:
            print("[info] 伴奏轨接近静音（RMS=%.4f），判断为干声源，退回整轨直转" % inst_rms, file=sys.stderr)
            return None, None
    except Exception:
        pass
    return vocals_cached, inst_cached


def mix_with_instrumental(vocal_path, inst_path, out_path, ffmpeg, vocal_gain=1.0, inst_gain=0.9, ref_path=None):
    """把「转换后的人声」和「原伴奏」混成一条音轨。

    用 numpy 直接相加而不是 ffmpeg 的 amix —— amix 默认会把两路音量各砍一半，
    还得额外补增益；直接相加的电平更好预测。长度不一致时按较短的那条截断。

    ref_path：原曲。分离再混音会损失一部分能量（实测成品只有原曲一半响），
    所以最后按原曲的 RMS 自动补增益，让成品听起来和正常歌曲一样响。
    """
    import numpy as np
    import soundfile as sf

    try:
        v, sr_v = sf.read(vocal_path, dtype="float32", always_2d=True)
        i, sr_i = sf.read(inst_path, dtype="float32", always_2d=True)
    except Exception as exc:
        print("[warn] 混音读取失败：%s" % exc, file=sys.stderr)
        return False
    if sr_v != sr_i:  # 采样率不同时以人声轨为准，伴奏按比例重采样
        try:
            import torch
            import torchaudio
            i = torchaudio.functional.resample(torch.from_numpy(i.T), sr_i, sr_v).numpy().T
            sr = sr_v
        except Exception:
            sr = sr_v
    else:
        sr = sr_v
    n = min(len(v), len(i))
    if n <= 0:
        return False
    mix = v[:n] * float(vocal_gain) + i[:n] * float(inst_gain)
    # 电平对齐：成品比原曲轻是常态（分离会掉能量），按原曲 RMS 补回来，最多 3 倍
    try:
        mix_rms = float(np.sqrt(np.mean(mix.astype("float64") ** 2)))
        if ref_path and os.path.isfile(ref_path) and mix_rms > 1e-6:
            import soundfile as _sf
            ref, _sr = _sf.read(ref_path, dtype="float32", always_2d=True)
            ref = ref[:n]
            ref_rms = float(np.sqrt(np.mean(ref.astype("float64") ** 2)))
            if ref_rms > 1e-6:
                gain = min(3.0, max(0.5, ref_rms / mix_rms))
                mix = (mix.astype("float64") * gain).astype("float32")
    except Exception:
        pass
    # 防削波：超过 0.99 就整体压回去，避免爆音
    peak = float(np.max(np.abs(mix))) if mix.size else 0.0
    if peak > 0.99:
        mix = mix * (0.99 / peak)
    tmp_wav = out_path + ".mix.wav"
    try:
        sf.write(tmp_wav, mix, sr)
        # 响度归一化：分离再混音的成品「峰均比」比原曲高（瞬态尖、平均响度低），
        # 单纯加增益会削波，所以用 loudnorm 按感知响度拉平到流媒体常用值（-14 LUFS）。
        # loudnorm 不可用时退回普通编码，不能因为一个滤镜让整首歌失败。
        try:
            _transcode(tmp_wav, out_path, ffmpeg, ["-af", "loudnorm=I=-14:TP=-1.0", "-b:a", "192k"])
        except Exception:
            _transcode(tmp_wav, out_path, ffmpeg, ["-b:a", "192k"])
    except Exception as exc:
        print("[warn] 混音写盘失败：%s" % exc, file=sys.stderr)
        return False
    finally:
        try:
            os.remove(tmp_wav)
        except Exception:
            pass
    return os.path.isfile(out_path) and os.path.getsize(out_path) > 200


def cmd_infer(args):
    started = time.time()
    model = os.path.abspath(args.model)
    if not os.path.isfile(model):
        return _fail("模型文件不存在：%s" % model)
    src = os.path.abspath(args.input)
    if not os.path.isfile(src):
        return _fail("输入音频不存在：%s" % src)

    ok_rvc, err = _import_module("rvc_python")
    if not ok_rvc:
        return _fail("未安装 rvc-python（%s）。先执行：python %s install" % (err, os.path.basename(__file__)), code=2)

    ffmpeg, _ = find_ffmpeg(args.ffmpeg)
    if not ffmpeg:
        return _fail("找不到 ffmpeg，无法转码。执行：python %s install" % os.path.basename(__file__), code=2)

    out = os.path.abspath(args.output)
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    tmp_dir = os.path.join(os.path.dirname(out) or ".", ".rvc-tmp")
    os.makedirs(tmp_dir, exist_ok=True)

    # 0) ★ 2026-10-19「保留伴奏」：先把人声和伴奏分开，只把人声送去 RVC，最后混回伴奏。
    #    RVC 是对整条音轨做音色替换，把伴奏一起喂进去会连音乐一起毁掉——所以这一步是
    #    「唱歌带背景音乐」的关键。分离失败就退回原来的整轨直转（没伴奏，但至少能出声）。
    inst_path = None
    src_for_rvc = src
    if getattr(args, "keep_bgm", False):
        sep_cache = os.path.join(os.path.dirname(out) or ".", ".sep-cache")
        vocals_path, inst_path = separate_vocals(src, sep_cache)
        if vocals_path and inst_path:
            src_for_rvc = vocals_path
        else:
            inst_path = None
            print("[warn] 分离失败，退回整轨直转（成品不带伴奏）", file=sys.stderr)

    # 1) 统一先转成 16bit PCM wav（rvc_python 对 wav 最稳）
    stem = os.path.splitext(os.path.basename(src))[0]
    in_wav = os.path.join(tmp_dir, stem + ".in.wav")
    _transcode(src_for_rvc, in_wav, ffmpeg, ["-ac", "1", "-ar", "44100", "-sample_fmt", "s16"])
    intermediate = os.path.join(tmp_dir, stem + ".rvc.wav")

    # 2) 调 rvc_python 推理
    from rvc_python.infer import RVCInference  # noqa: WPS433

    # 2.5) 自动升降调（2026-10-18，用户报「男声配女声模型转出来音调偏低」）：
    # 不补调时男声（~120Hz）配女声模型（~220Hz）差近一个八度，输出全程偏低。
    # 检测失败/纯音乐时保持原样，绝不瞎调。
    effective_pitch = int(args.pitch)
    auto_pitch_info = None
    if args.auto_pitch:
        shift, median_hz, voiced = detect_pitch_shift(in_wav, args.pitch_target_hz)
        if shift and median_hz:
            effective_pitch = shift
            auto_pitch_info = {
                "detectedHz": round(median_hz, 1),
                "targetHz": args.pitch_target_hz,
                "shift": shift,
                "voicedRatio": voiced,
            }
            print(
                "[auto-pitch] 输入基频中位数 %.1fHz → 目标 %.0fHz，补调 %+d 半音" % (median_hz, args.pitch_target_hz, shift),
                file=sys.stderr,
            )

    index_path = os.path.abspath(args.index) if args.index and os.path.isfile(args.index) else ""

    def _build_and_infer(dev):
        r = RVCInference(
            device=dev,
            model_path=model,
            index_path=index_path,
            version=args.version,
        )
        r.set_params(
            f0method=args.f0_method,
            f0up_key=effective_pitch,
            index_rate=float(args.index_ratio),
            filter_radius=int(args.filter_radius),
            resample_sr=int(args.resample_sr),
            rms_mix_rate=float(args.rms_mix_rate),
            protect=float(args.protect),
        )
        # 不用 r.infer_file()：它在 vc_single 出错时拿到的是个错误元组，
        # 直接丢给 scipy 写盘，报出来是 `AttributeError: 'tuple' object has no attribute 'dtype'`
        # —— 一句完全指错方向的话（真正的原因被吞在元组第一个元素里）。
        # 这里自己调底层并解出真实原因。
        from scipy.io import wavfile  # noqa: WPS433

        file_index = (r.models.get(r.current_model) or {}).get("index", "") if hasattr(r, "models") else ""
        wav_opt = r.vc.vc_single(
            sid=0,
            input_audio_path=in_wav,
            f0_up_key=getattr(r, "f0up_key", effective_pitch),
            f0_method=getattr(r, "f0method", args.f0_method),
            file_index=file_index or index_path,
            index_rate=float(args.index_ratio),
            filter_radius=int(args.filter_radius),
            resample_sr=int(args.resample_sr),
            rms_mix_rate=float(args.rms_mix_rate),
            protect=float(args.protect),
            f0_file="",
            file_index2="",
        )
        if not hasattr(wav_opt, "dtype"):
            # vc_single 出错时返回 (错误信息字符串, (None, None))，不抛异常
            detail = ""
            if isinstance(wav_opt, tuple) and wav_opt:
                detail = str(wav_opt[0])
                # 错误信息里经常塞着整段 traceback，只留最后一行最有价值的
                detail = [ln for ln in detail.splitlines() if ln.strip()][-1:] or [detail]
                detail = detail[0]
            raise RuntimeError((detail or "vc_single 返回了非音频结果（不是合法的音频数组）")[:400])
        wavfile.write(intermediate, r.vc.tgt_sr, wav_opt)
        return r

    # ★ 2026-10-19（用户报「同一首歌一会儿失败一会儿成功」）：
    #   根因是 CUDA OOM —— GPU 被浏览器/游戏之类的程序占着，跟歌本身无关，
    #   实测 2 分 34 秒的歌挂了，4 分半的反而成功。以前 OOM 直接抛栈退出，
    #   桥接只截到 stderr 开头（一堆 hubert 配置），谁也看不出是显存的事。
    #   现在分三级兜底：清显存重试 → 退 CPU（慢 3~5 倍但稳）→ 才报错，且报人话。
    try:
        _build_and_infer(args.device)
    except Exception as exc:  # noqa: BLE001
        first = "%s: %s" % (type(exc).__name__, exc)
        if not _is_oom(first):
            return _fail("RVC 推理失败：%s" % first[:400])
        print("[warn] 显存不足，清缓存后重试：%s" % first[:160], file=sys.stderr)
        _free_gpu()
        try:
            _build_and_infer(args.device)
        except Exception as exc2:  # noqa: BLE001
            second = "%s: %s" % (type(exc2).__name__, exc2)
            if not _is_oom(second):
                return _fail("RVC 推理失败：%s" % second[:400])
            print("[warn] 仍是显存不足，退回 CPU 推理（会慢十几倍）", file=sys.stderr)
            _free_gpu()
            try:
                # ⚠️ 必须是精确的 "cpu"，不能写 "cpu:0"：
                # rvc_python/configs/config.py 里是 `self.is_half = True if device != "cpu" else False`，
                # 写成 "cpu:0" 会让它保持 FP16，而 CPU 不支持 half 的 batch_norm，
                # 结果是 RuntimeError: "batch_norm" not implemented for 'Half'（实测踩过）。
                _build_and_infer("cpu")
            except Exception as exc3:  # noqa: BLE001
                third = "%s: %s" % (type(exc3).__name__, exc3)
                return _fail(
                    "显存不足（GPU 被别的程序占用），退回 CPU 也失败：%s"
                    "——建议关掉占显存的程序后重试" % third[:300]
                )

    if not os.path.isfile(intermediate):
        return _fail("推理未产出文件：%s" % intermediate)

    # 3) 输出成目标格式（mp3 更小，QQ 语音条也认）
    if inst_path and os.path.isfile(inst_path):
        # 带伴奏：转换后的人声 + 原伴奏混音；混音失败也要有产出（退回纯人声）
        if not mix_with_instrumental(
            intermediate, inst_path, out, ffmpeg,
            vocal_gain=float(args.vocal_gain), inst_gain=float(args.inst_gain), ref_path=src,
        ):
            print("[warn] 混音失败，退回纯人声输出", file=sys.stderr)
            if out.lower().endswith(".wav"):
                shutil.move(intermediate, out)
            else:
                _transcode(intermediate, out, ffmpeg, ["-b:a", "128k"])
    elif out.lower().endswith(".wav"):
        shutil.move(intermediate, out)
    else:
        _transcode(intermediate, out, ffmpeg, ["-b:a", "128k"])

    # 清理中间产物
    try:
        for f in (in_wav, intermediate):
            if os.path.isfile(f):
                os.remove(f)
    except Exception:  # noqa: BLE001
        pass

    elapsed = int((time.time() - started) * 1000)
    payload = {
        "ok": True,
        "output": out,
        "elapsedMs": elapsed,
        "model": model,
        "index": index_path,
        "device": args.device,
        "pitch": effective_pitch,
        "sizeBytes": os.path.getsize(out) if os.path.isfile(out) else 0,
    }
    if auto_pitch_info:
        payload["autoPitch"] = auto_pitch_info
    if getattr(args, "keep_bgm", False):
        payload["keepBgm"] = {
            "requested": True,
            "mixed": bool(inst_path and os.path.isfile(inst_path)),
            "vocalGain": float(args.vocal_gain),
            "instGain": float(args.inst_gain),
        }
    print(json.dumps(payload, ensure_ascii=False))
    return 0


def _fail(msg, code=1):
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    return code


def _is_oom(msg):
    """判断异常是不是「显存不足」。"""
    m = str(msg or "").lower()
    return ("out of memory" in m) or ("cuda oom" in m) or ("not enough memory" in m)


def _free_gpu():
    """尽力清一下显存碎片（PyTorch 自己缓存的块不会自动还给别的进程）。"""
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            try:
                torch.cuda.ipc_collect()
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001
        pass


def main():
    ap = argparse.ArgumentParser(description="RVC 音色转换 CLI（QQ Bridge 用）")
    sub = ap.add_subparsers(dest="command")

    p_info = sub.add_parser("info", help="检查推理环境是否就绪")
    p_info.add_argument("--ffmpeg", default="", help="手动指定 ffmpeg 路径")
    p_info.set_defaults(func=cmd_info)

    p_inst = sub.add_parser("install", help="安装 rvc-python 等依赖")
    p_inst.add_argument("--torch-cpu", action="store_true", help="无独显时先装 CPU 版 torch（体积小很多）")
    p_inst.set_defaults(func=cmd_install)

    p_infer = sub.add_parser("infer", help="用指定音色模型转换音频")
    p_infer.add_argument("-m", "--model", required=True, help="音色模型 .pth 路径")
    p_infer.add_argument("-i", "--input", required=True, help="输入音频（干声/原唱）")
    p_infer.add_argument("-o", "--output", required=True, help="输出音频")
    p_infer.add_argument("--index", default="", help="可选 .index 检索索引，能提升音色相似度")
    p_infer.add_argument("--pitch", type=int, default=0, help="变调，半音数（男转女 +12）；--auto-pitch 开启时会被检测结果覆盖")
    p_infer.add_argument("--auto-pitch", action="store_true", help="自动升降调：先分析输入基频中位数，离目标音域差一整八度就自动补调（男声配女声模型必备）")
    p_infer.add_argument("--pitch-target-hz", type=float, default=220.0, help="--auto-pitch 的目标基频 Hz：女声模型约 220，男声模型约 120")
    p_infer.add_argument("--index-ratio", type=float, default=0.75, help="检索特征占比 0~1")
    p_infer.add_argument("--filter-radius", type=int, default=3, help="基频中值滤波半径")
    p_infer.add_argument("--resample-sr", type=int, default=0, help="输出重采样率，0=不重采样")
    p_infer.add_argument("--rms-mix-rate", type=float, default=0.25, help="音量包络混合比")
    p_infer.add_argument("--protect", type=float, default=0.33, help="清辅音保护，越小越像目标音色")
    p_infer.add_argument("--f0-method", default="rmvpe", choices=["harvest", "crepe", "rmvpe", "pm"])
    p_infer.add_argument("--version", default="v2", choices=["v1", "v2"], help="模型版本")
    p_infer.add_argument("--device", default="", help="cpu:0 / cuda:0，留空自动判断")
    p_infer.add_argument("--ffmpeg", default="", help="手动指定 ffmpeg 路径")
    # ★ 2026-10-19：保留背景音乐。开启后先分离人声/伴奏（Demucs htdemucs），
    #   只把人声过 RVC，最后与原伴奏混音 —— 这样唱歌才有背景音乐。
    #   分离/混音任一步失败都自动退回「整轨直转」，不会让点歌失败。
    p_infer.add_argument("--keep-bgm", action="store_true", help="保留背景音乐：先人声分离，只转换人声，再与原伴奏混音（唱歌带伴奏）")
    p_infer.add_argument("--vocal-gain", type=float, default=1.0, help="--keep-bgm 时人声音量倍数（默认 1.0）")
    p_infer.add_argument("--inst-gain", type=float, default=0.9, help="--keep-bgm 时伴奏音量倍数（默认 0.9，压一点让人声更突出）")
    p_infer.set_defaults(func=cmd_infer)

    args = ap.parse_args()
    if not args.command:
        ap.print_help()
        return 1
    if args.command == "infer" and not args.device:
        ok_torch, _ = _import_module("torch")
        args.device = "cpu:0"
        if ok_torch:
            try:
                import torch  # noqa: WPS433

                args.device = "cuda:0" if torch.cuda.is_available() else "cpu:0"
            except Exception:  # noqa: BLE001
                pass
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
