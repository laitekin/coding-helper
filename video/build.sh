#!/usr/bin/env bash
# 一条命令重建整片：旁白 → 回检 → 字幕 → 配乐/音效/混音 → 画面 → 合成
# 用法: bash video/build.sh [--skip-tts]
# 依赖: Node 18+、ffmpeg、uv、全局安装的 playwright（或设置 PLAYWRIGHT_PATH）
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  uv venv -q .venv
  uv pip install -q --python .venv/bin/python numpy scipy soundfile edge-tts faster-whisper opencc-python-reimplemented
fi
export PLAYWRIGHT_PATH="${PLAYWRIGHT_PATH:-$(npm root -g)/playwright/index.mjs}"

if [ "${1:-}" != "--skip-tts" ]; then
  .venv/bin/python audio/tts.py audio/lines.json audio/out/vo
fi
.venv/bin/python audio/asr_check.py audio/lines.json audio/out/vo small
python3 audio/srt.py audio/out/vo/timing.json film/cues.js film/out/qiniu-coding-helper.srt
.venv/bin/python audio/mix.py audio/lines.json audio/out/vo audio/out
node film/tools/video.mjs --workers 4
bash mux.sh film/out/video.mp4 audio/out/mix.wav film/out/qiniu-coding-helper.mp4
