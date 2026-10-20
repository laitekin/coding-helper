"""旁白合成：按 lines.json 逐句调用 edge-tts（微软神经语音，需要联网），输出 24 kHz 单声道 WAV

用法: .venv/bin/python audio/tts.py audio/lines.json audio/out/vo
"""
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

# 云端环境走代理时，让 edge-tts 信任代理的 CA（它默认只用 certifi 自带的证书）
_ca = os.environ.get("SSL_CERT_FILE") or ("/root/.ccr/ca-bundle.crt" if Path("/root/.ccr/ca-bundle.crt").exists() else None)
if _ca:
    import certifi
    certifi.where = lambda: _ca

import edge_tts  # noqa: E402


async def synth(line: dict, out_dir: Path) -> Path:
    mp3 = out_dir / f"{line['id']}.mp3"
    wav = out_dir / f"{line['id']}.wav"
    comm = edge_tts.Communicate(line["text"], line.get("voice", "zh-CN-YunxiNeural"),
                                rate=line.get("rate", "+0%"), pitch=line.get("pitch", "+0Hz"))
    await comm.save(str(mp3))
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(mp3), "-ac", "1", "-ar", "24000", str(wav)], check=True)
    mp3.unlink()
    return wav


async def main() -> None:
    lines = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    for line in lines:
        wav = await synth(line, out_dir)
        print(wav)


if __name__ == "__main__":
    asyncio.run(main())
