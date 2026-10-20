"""由旁白实际时长生成字幕：film/cues.js（画面硬字幕）与 .srt（外挂字幕）

字幕至少停留 1.8 s，并按约 4.5 字/秒保证读得完；不压到下一句。
用法: python3 audio/srt.py audio/out/vo/timing.json film/cues.js out/qiniu-coding-helper.srt
"""
import json
import re
import sys
from pathlib import Path


def chars(s: str) -> float:
    # 汉字按 1 字、英文单词按 1 字计
    return len(re.findall(r"[一-鿿]", s)) + len(re.findall(r"[A-Za-z0-9-]+", s))


def ts(t: float) -> str:
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def main() -> None:
    timing = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    cues = []
    for i, c in enumerate(timing):
        end = max(c["at"] + c["dur"] + 0.5, c["at"] + 1.8, c["at"] + chars(c["text"]) / 4.5)
        if i + 1 < len(timing):
            end = min(end, timing[i + 1]["at"] - 0.15)
        cues.append([round(c["at"], 2), round(end, 2), c["text"]])
    js = "// 由 audio/srt.py 根据旁白实际时长生成，请勿手改\nwindow.CUES = " + json.dumps(cues, ensure_ascii=False, indent=0) + ";\n"
    Path(sys.argv[2]).write_text(js, encoding="utf-8")
    srt = "\n".join(f"{i + 1}\n{ts(a)} --> {ts(b)}\n{s}\n" for i, (a, b, s) in enumerate(cues))
    Path(sys.argv[3]).parent.mkdir(parents=True, exist_ok=True)
    Path(sys.argv[3]).write_text(srt, encoding="utf-8")
    for a, b, s in cues:
        print(f"{a:6.2f} → {b:6.2f}  {s}")


if __name__ == "__main__":
    main()
