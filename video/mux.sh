#!/usr/bin/env bash
# 合成：画面 + 混音，两遍 loudnorm 到 -14 LUFS / -1.5 dBTP（给 AAC 编码过冲留余量）
# 用法: bash mux.sh <video.mp4> <mix.wav> <out.mp4>
set -euo pipefail
video="$1"; audio="$2"; out="$3"

# 第一遍：测量响度
stats=$(ffmpeg -hide_banner -nostats -i "$audio" -af loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json -f null - 2>&1 | sed -n '/^{/,/^}/p')
get() { echo "$stats" | sed -n "s/.*\"$1\" : \"\([^\"]*\)\".*/\1/p"; }

# 第二遍：按测量值线性标准化，与画面合成
ffmpeg -hide_banner -loglevel error -y -i "$video" -i "$audio" \
  -af "loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=$(get input_i):measured_TP=$(get input_tp):measured_LRA=$(get input_lra):measured_thresh=$(get input_thresh):offset=$(get target_offset):linear=true,aresample=48000" \
  -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "$out"
echo "$out"
