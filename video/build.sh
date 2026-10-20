#!/usr/bin/env bash
# 一条命令重建整片：旁白 → 回检 → 字幕 → 配乐/音效/混音 → 画面 → 合成
# 用法: VOICE=minimax|edge bash video/build.sh [--skip-tts]
#   minimax：MiniMax「真诚青年」，需要环境变量 MINIMAX_API_KEY
#   edge：   edge-tts「云希」，免费，无需 Key
# 依赖: Node 18+、ffmpeg、uv、全局安装的 playwright（或设置 PLAYWRIGHT_PATH）
set -euo pipefail
cd "$(dirname "$0")"
VOICE="${VOICE:-minimax}"

if [ ! -x .venv/bin/python ]; then
  uv venv -q .venv
  uv pip install -q --python .venv/bin/python numpy scipy soundfile requests edge-tts faster-whisper opencc-python-reimplemented
fi
export PLAYWRIGHT_PATH="${PLAYWRIGHT_PATH:-$(npm root -g)/playwright/index.mjs}"

vo="audio/out/vo-$VOICE"
if [ "${1:-}" != "--skip-tts" ]; then
  case "$VOICE" in
    minimax) .venv/bin/python audio/tts.py audio/lines.json "$vo" --provider minimax --voice "Chinese (Mandarin)_Sincere_Adult" ;;
    edge)    .venv/bin/python audio/tts.py audio/lines.json "$vo" --provider edge ;;
    *) echo "未知 VOICE：$VOICE（可选 minimax、edge）" >&2; exit 1 ;;
  esac
fi
.venv/bin/python audio/asr_check.py audio/lines.json "$vo" small
python3 audio/srt.py "$vo/timing.json" film/cues.js "film/out/qiniu-coding-helper-$VOICE.srt"
.venv/bin/python audio/mix.py audio/lines.json "$vo" "audio/out/mix-$VOICE"
node film/tools/video.mjs --workers 4 --out "film/out/video-$VOICE.mp4"
bash mux.sh "film/out/video-$VOICE.mp4" "audio/out/mix-$VOICE/mix.wav" "film/out/qiniu-coding-helper-$VOICE.mp4"
