"""旁白回检：裁掉首尾静音，用 faster-whisper 转写每句，与稿子逐字比对，并写出实际时长

用法: .venv/bin/python audio/asr_check.py audio/lines.json audio/out/vo [模型名，默认 small]
输出: audio/out/vo/timing.json（每句裁剪后的时长、识别文本、字符准确率）
"""
import json
import os
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

if Path("/root/.ccr/ca-bundle.crt").exists():
    os.environ.setdefault("REQUESTS_CA_BUNDLE", "/root/.ccr/ca-bundle.crt")
    os.environ.setdefault("SSL_CERT_FILE", "/root/.ccr/ca-bundle.crt")

from faster_whisper import WhisperModel  # noqa: E402
from opencc import OpenCC  # noqa: E402

# whisper 的中文输出常混入繁体，比对前统一转简体
T2S = OpenCC("t2s")
DIGITS = {"13": "十三"}


def trim(path: Path, thresh_db: float = -45.0, pad: float = 0.04) -> float:
    """原地裁掉首尾静音，返回裁剪后时长（秒）"""
    x, sr = sf.read(path)
    win = int(sr * 0.01)
    env = np.sqrt(np.convolve(x ** 2, np.ones(win) / win, mode="same"))
    loud = np.where(20 * np.log10(env + 1e-9) > thresh_db)[0]
    a = max(0, loud[0] - int(pad * sr))
    b = min(len(x), loud[-1] + int(pad * sr))
    y = x[a:b]
    # 首尾 10 ms 淡入淡出，避免咔哒声
    f = int(sr * 0.01)
    y[:f] *= np.linspace(0, 1, f)
    y[-f:] *= np.linspace(1, 0, f)
    sf.write(path, y, sr)
    return len(y) / sr


def norm(s: str) -> str:
    # 繁转简、数字转汉字；只比对字母、数字和汉字，忽略标点、空格和大小写
    s = T2S.convert(s)
    for k, v in DIGITS.items():
        s = s.replace(k, v)
    return re.sub(r"[^0-9a-z一-鿿]", "", s.lower())


def main() -> None:
    lines = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    vo = Path(sys.argv[2])
    model = WhisperModel(sys.argv[3] if len(sys.argv) > 3 else "small", device="cpu", compute_type="int8")
    report = []
    for line in lines:
        wav = vo / f"{line['id']}.wav"
        dur = trim(wav)
        # 直接传 16 kHz 波形，绕开 faster-whisper 与新版 PyAV 的解码兼容问题
        x, sr = sf.read(wav, dtype="float32")
        audio16 = resample_poly(x, 16000, sr).astype(np.float32)
        segs, _ = model.transcribe(audio16, language="zh", beam_size=5,
                                   initial_prompt="Claude Code、七牛、npx qiniu-coding-helper、API Key、qnaigc、modelink、Haiku、Sonnet、Opus、doctor、restore")
        heard = T2S.convert("".join(s.text for s in segs).strip())
        acc = SequenceMatcher(None, norm(line["text"]), norm(heard)).ratio()
        report.append({"id": line["id"], "at": line["at"], "dur": round(dur, 3), "text": line["text"], "heard": heard, "acc": round(acc, 3)})
        flag = "OK " if acc >= 0.9 else "!! "
        print(f"{flag}{line['id']}  {dur:5.2f}s  {acc:.2f}  {heard}")
    (vo / "timing.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
