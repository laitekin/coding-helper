"""旁白合成：按 lines.json 逐句合成，输出 24 kHz 单声道 WAV

支持多家 TTS，Key 一律从环境变量读取，不写进仓库：
  edge      edge-tts（免费，无需 Key）
  dashscope 阿里云百炼 CosyVoice        DASHSCOPE_API_KEY
  volc      火山引擎豆包语音合成大模型    VOLC_TTS_TOKEN（控制台 API Key）
  minimax   MiniMax 语音合成             MINIMAX_API_KEY

用法: .venv/bin/python audio/tts.py audio/lines.json audio/out/vo [--provider edge] [--voice 音色] [--only s01,s05]
"""
import argparse
import asyncio
import base64
import json
import os
import subprocess
import uuid
from pathlib import Path

import requests

# 云端环境走代理时，让各家 SDK 信任代理的 CA
_CA = "/root/.ccr/ca-bundle.crt"
if Path(_CA).exists():
    os.environ.setdefault("SSL_CERT_FILE", _CA)
    os.environ.setdefault("REQUESTS_CA_BUNDLE", _CA)
    import certifi
    certifi.where = lambda: _CA

DEFAULT_VOICE = {
    "edge": "zh-CN-YunxiNeural",
    "dashscope": "longanyang",                         # 龙安洋：阳光青年男声
    "volc": "zh_male_m191_uranus_bigtts",              # 豆包语音 2.0 男声
    "minimax": "male-qn-qingse",                       # 青涩青年
}


def edge(text: str, voice: str, line: dict) -> bytes:
    import edge_tts

    async def run() -> bytes:
        comm = edge_tts.Communicate(text, voice, rate=line.get("rate", "+0%"))
        buf = b""
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                buf += chunk["data"]
        return buf
    return asyncio.run(run())


def dashscope(text: str, voice: str, line: dict) -> bytes:
    import dashscope as ds
    from dashscope.audio.tts_v2 import SpeechSynthesizer
    ds.api_key = os.environ["DASHSCOPE_API_KEY"]
    if os.environ.get("DASHSCOPE_WS_URL"):
        ds.base_websocket_api_url = os.environ["DASHSCOPE_WS_URL"]
    model = os.environ.get("DASHSCOPE_TTS_MODEL", "cosyvoice-v3-plus")
    audio = SpeechSynthesizer(model=model, voice=voice).call(text)
    if not audio:
        raise RuntimeError("百炼没有返回音频，请检查 Key、模型与音色是否匹配")
    return audio


def volc(text: str, voice: str, line: dict) -> bytes:
    # 新版控制台的 API Key（UUID 格式）走 v3 接口的 X-Api-Key 鉴权；返回逐行 JSON，data 为 base64 音频分片
    headers = {
        "X-Api-Key": os.environ["VOLC_TTS_TOKEN"],
        "X-Api-Resource-Id": os.environ.get("VOLC_TTS_RESOURCE", "seed-tts-2.0"),
        "X-Api-Request-Id": str(uuid.uuid4()),
    }
    body = {"user": {"uid": "coding-helper-video"},
            "req_params": {"text": text, "speaker": voice, "audio_params": {"format": "mp3", "sample_rate": 24000}}}
    r = requests.post("https://openspeech.bytedance.com/api/v3/tts/unidirectional", headers=headers, json=body, timeout=60)
    audio = b""
    for raw in r.text.splitlines():
        if not raw.strip():
            continue
        msg = json.loads(raw)
        if msg.get("data"):
            audio += base64.b64decode(msg["data"])
        code = msg.get("code", msg.get("header", {}).get("code", 0))
        if code not in (0, 20000000):
            raise RuntimeError(f"豆包返回错误: {code} {msg.get('message', msg.get('header', {}).get('message'))}")
    if not audio:
        raise RuntimeError(f"豆包没有返回音频（HTTP {r.status_code}）")
    return audio


def minimax(text: str, voice: str, line: dict) -> bytes:
    body = {
        "model": os.environ.get("MINIMAX_TTS_MODEL", "speech-2.8-hd"),
        "text": text,
        "stream": False,
        "voice_setting": {"voice_id": voice, "speed": line.get("speed", 1.0), "vol": 1, "pitch": 0},
        "audio_setting": {"sample_rate": 32000, "bitrate": 128000, "format": "mp3", "channel": 1},
    }
    host = os.environ.get("MINIMAX_HOST", "https://api.minimaxi.com")
    r = requests.post(f"{host}/v1/t2a_v2", json=body, timeout=60,
                      headers={"Authorization": f"Bearer {os.environ['MINIMAX_API_KEY']}"})
    data = r.json()
    if data.get("base_resp", {}).get("status_code") != 0:
        raise RuntimeError(f"MiniMax 返回错误: {data.get('base_resp')}")
    return bytes.fromhex(data["data"]["audio"])


PROVIDERS = {"edge": edge, "dashscope": dashscope, "volc": volc, "minimax": minimax}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("lines")
    ap.add_argument("out_dir")
    ap.add_argument("--provider", default=os.environ.get("TTS_PROVIDER", "edge"), choices=PROVIDERS)
    ap.add_argument("--voice")
    ap.add_argument("--only", help="只合成这些 id，逗号分隔")
    a = ap.parse_args()
    lines = json.loads(Path(a.lines).read_text(encoding="utf-8"))
    if a.only:
        keep = set(a.only.split(","))
        lines = [l for l in lines if l["id"] in keep]
    out_dir = Path(a.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    voice = a.voice or DEFAULT_VOICE[a.provider]
    for line in lines:
        audio = PROVIDERS[a.provider](line["text"], voice, line)
        src = out_dir / f"{line['id']}.src"
        src.write_bytes(audio)
        wav = out_dir / f"{line['id']}.wav"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(src), "-ac", "1", "-ar", "24000", str(wav)], check=True)
        src.unlink()
        print(wav)


if __name__ == "__main__":
    main()
