"""配乐 + 音效 + 旁白混音，输出 48 kHz 立体声 WAV（响度标准化在 mux.sh 中完成）

全部声音由代码合成：方波/三角波芯片音色、噪声鼓组、程序化拟音。
时间轴与 film/index.html 的分镜一致：96 BPM，4/4，1 小节 = 2.5 s，共 30 小节。

用法: .venv/bin/python audio/mix.py audio/lines.json audio/out/vo audio/out
输出: <out>/music.wav <out>/sfx.wav <out>/voice.wav <out>/mix.wav
"""
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import butter, resample_poly, sosfilt

SR = 48000
DUR = 75.0
BPM = 96
BEAT = 60 / BPM
BAR = BEAT * 4
N = int(SR * (DUR + 2.0))  # 尾部多留 2 秒给余响，最后再裁
RNG = np.random.default_rng(20261020)  # 固定种子，结果可复现


# ---------- 基础 ----------
def bar_t(bar: int, beat: float = 0.0) -> float:
    """第 bar 小节（从 1 开始）第 beat 拍（从 0 开始）的时间"""
    return (bar - 1) * BAR + beat * BEAT


def mtof(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


def env_adsr(n: int, a=0.005, d=0.08, s=0.6, r=0.05) -> np.ndarray:
    t = np.arange(n) / SR
    e = np.ones(n) * s
    na, nd, nr = int(a * SR), int(d * SR), int(r * SR)
    e[:na] = np.linspace(0, 1, max(na, 1))[:len(e[:na])]
    e[na:na + nd] = np.linspace(1, s, max(nd, 1))[:len(e[na:na + nd])]
    if nr and n > nr:
        e[-nr:] *= np.linspace(1, 0, nr)
    return e * (t >= 0)


def pulse(f: float, n: int, duty=0.5) -> np.ndarray:
    # 加法合成的带限方波/脉冲波，避免混叠
    t = np.arange(n) / SR
    out = np.zeros(n)
    k = 1
    while k * f < SR * 0.45 and k <= 40:
        out += np.sin(np.pi * k * duty) / k * np.cos(2 * np.pi * k * f * t)
        k += 1
    return out * 1.1


def tri(f: float, n: int) -> np.ndarray:
    t = np.arange(n) / SR
    ph = (f * t) % 1.0
    return 4 * np.abs(ph - 0.5) - 1


def noise(n: int) -> np.ndarray:
    return RNG.uniform(-1, 1, n)


def filt(x, kind, fc, order=2):
    fc = np.atleast_1d(fc) if kind == "band" else fc
    sos = butter(order, fc, btype=kind, fs=SR, output="sos")
    return sosfilt(sos, x)


class Bus:
    """立体声总线，add() 按时间、增益、声像叠加单声道片段"""

    def __init__(self):
        self.x = np.zeros((N, 2))

    def add(self, sig: np.ndarray, at: float, gain=1.0, pan=0.0):
        i = int(at * SR)
        if i >= N or i + len(sig) <= 0:
            return
        if i < 0:
            sig, i = sig[-i:], 0
        sig = sig[:N - i]
        l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
        self.x[i:i + len(sig), 0] += sig * gain * l * np.sqrt(2)
        self.x[i:i + len(sig), 1] += sig * gain * r * np.sqrt(2)


# ---------- 乐器 ----------
def note_pulse(m, dur, duty=0.25, vib=0.0):
    n = int(dur * SR)
    s = pulse(mtof(m), n, duty)
    if vib:
        t = np.arange(n) / SR
        # 颤音用轻微的音量起伏代替，保持音高干净
        s *= 1 - vib * (0.5 + 0.5 * np.sin(2 * np.pi * 5.5 * t)) * np.clip(t / 0.25, 0, 1)
    return s * env_adsr(n, 0.004, 0.09, 0.45, min(0.06, dur * 0.4))


def note_tri(m, dur):
    n = int(dur * SR)
    return tri(mtof(m), n) * env_adsr(n, 0.005, 0.05, 0.8, min(0.05, dur * 0.3))


def kick():
    n = int(0.32 * SR)
    t = np.arange(n) / SR
    f = 45 + 110 * np.exp(-t * 28)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)
    s += filt(noise(n), "high", 2000) * np.exp(-t * 120) * 0.25
    return s


def snare():
    n = int(0.22 * SR)
    t = np.arange(n) / SR
    s = filt(noise(n), "band", [900, 6000]) * np.exp(-t * 22) * 0.8
    s += np.sin(2 * np.pi * 185 * t) * np.exp(-t * 30) * 0.5
    return s


def hat(open_=False):
    n = int((0.16 if open_ else 0.05) * SR)
    t = np.arange(n) / SR
    return filt(noise(n), "high", 7000) * np.exp(-t * (18 if open_ else 80))


def crash(dur=2.2):
    n = int(dur * SR)
    t = np.arange(n) / SR
    return filt(noise(n), "high", 3500) * np.exp(-t * 2.2)


def reverse_cymbal(dur=1.25):
    n = int(dur * SR)
    t = np.arange(n) / SR
    return filt(noise(n), "high", 3000) * (t / dur) ** 3


# ---------- 配乐 ----------
CH = {  # 和弦（MIDI，根音在低八度）
    "Am": [57, 60, 64], "F": [53, 57, 60], "C": [48, 52, 55], "G": [55, 59, 62],
}
CHORDS = (["Am", "Am", "F", "F"]                     # A 引子 1–4
          + ["Am", "F", "C", "G"] * 3 + ["Am", "F", "G"]  # B 向导 5–19
          + [None]                                    # 20 真静音
          + ["C", "G", "Am", "F", "G"]                # C 接入 21–25
          + ["Am", "F", "C", "G", "C"])               # D 收尾 26–30
assert len(CHORDS) == 30

# C 段主旋律：(小节, 拍, MIDI, 拍长)
LEAD = [
    (21, 0, 76, 1), (21, 1, 79, .5), (21, 1.5, 81, .5), (21, 2, 79, 1), (21, 3, 76, 1),
    (22, 0, 74, 1), (22, 1, 79, 1), (22, 2, 83, 1.5), (22, 3.5, 81, .5),
    (23, 0, 84, 1.5), (23, 1.5, 83, .5), (23, 2, 81, 1), (23, 3, 76, 1),
    (24, 0, 77, 1), (24, 1, 81, 1), (24, 2, 84, 1), (24, 3, 81, 1),
    (25, 0, 83, 1), (25, 1, 86, 1), (25, 2, 84, 2),
]


def score() -> Bus:
    b = Bus()
    for bar in range(1, 31):
        ch = CHORDS[bar - 1]
        if ch is None:
            continue
        root, tones = CH[ch][0], CH[ch]
        t0 = bar_t(bar)
        sec = "A" if bar <= 4 else "B" if bar <= 19 else "C" if bar <= 25 else "D"
        # 第 28 小节前半小节：第二处静音
        half_silent = bar == 28
        # 低频持续音（A、D 段）
        if sec in "AD" and not half_silent:
            b.add(note_tri(root - 12, BAR) * 0.9, t0, 0.20)
        # 琶音
        step = BEAT / 2 if sec in "AD" else BEAT / 4
        cnt = int(round(BAR / step))
        for i in range(cnt):
            at = t0 + i * step
            if half_silent and i < cnt // 2:
                continue
            if bar == 30 and i > 0:
                break
            m = tones[i % 3] + 24 + (12 if (i // 3) % 2 and sec == "C" else 0)
            g = {"A": .10, "B": .075, "C": .085, "D": .10}[sec]
            b.add(note_pulse(m, step * 0.9, 0.25), at, g, pan=-0.35 if i % 2 else 0.35)
        # 贝斯（B、C 段，八分音符）
        if sec in "BC":
            for i in range(8):
                m = root - 12 + (12 if sec == "C" and i % 2 else 0)
                b.add(note_tri(m, BEAT / 2 * 0.85), t0 + i * BEAT / 2, 0.30)
        # 鼓组
        if sec in "BC":
            for beat in range(4):
                at = t0 + beat * BEAT
                if beat in (0, 2):
                    b.add(kick(), at, 0.55)
                else:
                    b.add(snare(), at, 0.32, 0.05)
                if sec == "C" and beat == 3:
                    b.add(kick(), at + BEAT / 2, 0.4)
            hats = 8 if sec == "B" else 16
            for i in range(hats):
                b.add(hat(open_=(sec == "C" and i % 4 == 2)), t0 + i * BAR / hats, 0.09 if i % 2 else 0.13, 0.4)
    # C 段主旋律（带一点颤音起伏）
    for bar, beat, m, dl in LEAD:
        b.add(note_pulse(m, dl * BEAT * 0.95, 0.5, vib=0.25), bar_t(bar, beat), 0.13, 0.0)
    # 过渡：A→B 反向镲（第 4 小节第 4 拍甩镜），C 段起点镲片
    b.add(reverse_cymbal(1.25), bar_t(5) - 1.25, 0.25, 0.1)
    b.add(crash(), bar_t(21), 0.30, -0.1)
    # 尾和弦：第 30 小节第 1 拍，C 大三和弦长音
    for m in (60, 64, 67, 72):
        n = int(3.2 * SR)
        s = pulse(mtof(m), n, 0.5) * np.exp(-np.arange(n) / SR * 1.1)
        b.add(s, bar_t(30), 0.07, pan=(m - 66) / 12)
    b.add(note_tri(36, 3.0), bar_t(30), 0.30)
    b.add(crash(3.0), bar_t(30), 0.18)
    # 整体柔化，去掉方波的刺耳高频
    b.x = filt(b.x.T, "low", 9000).T
    return b


# ---------- 音效 ----------
def key_click():
    n = int(0.045 * SR)
    t = np.arange(n) / SR
    s = filt(noise(n), "band", [1800, 7000]) * np.exp(-t * 160)
    s += np.sin(2 * np.pi * 2600 * t) * np.exp(-t * 300) * 0.3
    return s


def enter_key():
    n = int(0.12 * SR)
    t = np.arange(n) / SR
    s = filt(noise(n), "band", [600, 4000]) * np.exp(-t * 60)
    s += np.sin(2 * np.pi * 140 * t) * np.exp(-t * 45) * 0.6
    return s


def blip(m, dur=0.07, duty=0.5):
    n = int(dur * SR)
    return pulse(mtof(m), n, duty) * np.exp(-np.arange(n) / SR * 40)


def chime(m, dur=0.6):
    n = int(dur * SR)
    t = np.arange(n) / SR
    return (np.sin(2 * np.pi * mtof(m) * t) + 0.35 * np.sin(2 * np.pi * mtof(m + 12) * t)) * np.exp(-t * 6)


def whoosh(dur, rise=True):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = noise(n)
    # 分段带通扫频
    out = np.zeros(n)
    seg = 8
    for k in range(seg):
        a, b = k * n // seg, (k + 1) * n // seg
        p = (k + .5) / seg
        fc = 400 * (12 ** (p if rise else 1 - p))
        out[a:b] = filt(x[a:b], "band", [fc * .7, min(fc * 1.4, 20000)])
    e = np.sin(np.pi * t / dur) ** 1.5
    return out * e


def plug_hit():
    n = int(0.5 * SR)
    t = np.arange(n) / SR
    s = np.sin(2 * np.pi * np.cumsum(60 + 120 * np.exp(-t * 30)) / SR) * np.exp(-t * 10) * 1.2
    s += filt(noise(n), "band", [1500, 9000]) * np.exp(-t * 35) * 0.9
    s += np.sin(2 * np.pi * 1800 * t) * np.exp(-t * 50) * 0.4
    return s


def flip():
    n = int(0.06 * SR)
    t = np.arange(n) / SR
    return filt(noise(n), "band", [2500, 8000]) * np.exp(-t * 90) + np.sin(2 * np.pi * 1200 * t) * np.exp(-t * 120) * 0.3


def rewind(dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = 300 + 900 * (t / dur) + 80 * np.sin(2 * np.pi * 9 * t)
    s = np.sign(np.sin(2 * np.pi * np.cumsum(f) / SR)) * 0.25 + filt(noise(n), "band", [800, 5000]) * 0.6
    return filt(s, "low", 6000) * np.minimum(1, np.minimum(t / 0.05, (dur - t) / 0.1))


def shimmer(dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    s = sum(np.sin(2 * np.pi * mtof(m) * t) for m in (88, 91, 95)) / 3
    return s * (0.5 + 0.5 * np.sin(2 * np.pi * 4 * t)) * np.minimum(1, np.minimum(t / .2, (dur - t) / .2))


def fan(dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    return filt(noise(n), "low", 300) * np.minimum(1, np.minimum(t / .5, (dur - t) / .5))


def typing(b: Bus, start: float, chars: int, span: float, gain=0.22):
    for i in range(chars):
        at = start + span * i / max(chars, 1) + (RNG.uniform(-.008, .008))
        b.add(key_click(), at, gain * RNG.uniform(.7, 1.0), RNG.uniform(-.2, .2))


def sfx() -> Bus:
    b = Bus()
    # S01 0–5：风扇底噪、光标「滴」、敲 claude、回车、「?」弹出
    b.add(fan(10.0), 0, 0.05)
    for i in range(2):
        b.add(blip(96, 0.03), i * BEAT, 0.05)
    typing(b, 1.25, 6, 0.5)
    b.add(enter_key(), 2.1, 0.3)
    b.add(blip(79, .09) + 0.6 * np.pad(blip(84, .09), (int(.06 * SR), 0))[:int(.09 * SR)], BAR + BEAT, 0.16)
    # S02 5–10：片名逐字亮起（升调小音），甩镜呼呼声
    for i in range(19):
        b.add(blip(84 + [0, 2, 4, 7, 9][i % 5] + 12 * (i // 10), 0.04, 0.25), 5 + 0.6 + i * BEAT / 4, 0.035, -0.5 + i / 19)
    b.add(whoosh(0.7, rise=True), 5 + 4.2, 0.35)
    # S03 10–15：打命令、回车、Logo 每行一个音
    typing(b, 10.15, 23, 1.0)
    b.add(enter_key(), 11.3, 0.3)
    for j, m in enumerate([72, 74, 76, 79, 81, 84]):
        b.add(chime(m, 0.5), 10 + 1.25 + j * BEAT, 0.12)
    b.add(chime(88, 1.2), 10 + 1.25 + 5 * BEAT + .3, 0.06)
    # S04 15–20：语言确认、线路切换「嘀」、确认
    b.add(blip(81, .06), 15 + 2 * BEAT, 0.12)
    for at in (17.5, 18.125):
        b.add(blip(86, .05, .25), at, 0.10)
    b.add(chime(84, 0.4), 15 + BAR + 2 * BEAT, 0.12)
    # S05 20–27.5：粘贴、回车、光点去程/回程、成功、已保存
    b.add(key_click() * 1.5, 21.0, 0.35)
    b.add(enter_key(), 21.875, 0.3)
    b.add(whoosh(1.5, True), 22.0, 0.22, 0.4)
    b.add(whoosh(1.4, False), 23.6, 0.22, -0.2)
    b.add(chime(88, 0.9) + chime(84, 0.9) * .6, 25.0, 0.18)
    b.add(blip(91, .05), 25.625, 0.07)
    # S06 27.5–35：光标下移、勾选
    inst = [1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 1]
    for i, on in enumerate(inst):
        at = 27.5 + 1.25 + i * BEAT / 2
        b.add(blip(88, .025, .25), at, 0.05)
        if on:
            b.add(key_click() * 1.3 + 0.6 * blip(91, .045), at, 0.22)
    b.add(enter_key(), 27.5 + 6.25, 0.3)
    # S07 35–42.5：三次确认、输入 sonnet
    for at in (36.25, 39.375, 41.25):
        b.add(chime(84, 0.35), at, 0.10)
    typing(b, 36.9, 6, 1.0)
    # S08 42.5–47.5：逐个写入成功、高亮、文件夹飞入
    for i in range(7):
        b.add(blip(79 + [0, 2, 4, 7, 9, 12, 14][i], .05, .25), 42.5 + .3 + i * BEAT / 2 + .28, 0.07)
    for at in (43.1, 43.75, 44.375, 45.0):
        b.add(blip(72, .04, .5), at, 0.05, 0.4)
    b.add(whoosh(0.6, False), 45.5, 0.18, -0.3)
    b.add(blip(76, .08), 46.1, 0.08)
    # S09 47.5–52.5：静音一小节里只有一声回车；插上「啪」；翻牌
    b.add(enter_key(), 48.75, 0.35)
    b.add(plug_hit(), 50.0, 0.65)
    for k in range(7):
        b.add(flip(), 50.0 + k * BEAT / 2, 0.30, -0.3 + k * 0.1)
    # S10 52.5–62.5：打 claude、欢迎框、提问、思考、流式输出、跳切
    typing(b, 52.5, 6, 0.35)
    b.add(enter_key(), 52.9, 0.28)
    b.add(chime(81, 0.5), 53.05, 0.08)
    typing(b, 53.7, 9, 1.2)
    b.add(enter_key(), 55.1, 0.28)
    b.add(shimmer(1.3), 55.3, 0.035)
    for i in range(60):
        b.add(key_click(), 56.8 + i * 0.05, 0.06, RNG.uniform(-.3, .3))
    b.add(whoosh(0.35, True), 59.75, 0.25)
    b.add(chime(91, 0.8), 60.0, 0.07)
    # S11 62.5–67.5：体检打勾、倒带、还原完成
    for i in range(6):
        b.add(chime(84 + [0, 2, 4, 7, 9, 12][i], 0.35), 62.5 + .3 + i * BEAT / 2, 0.08, 0.2)
    b.add(rewind(1.7), 65.0, 0.18)
    b.add(chime(88, 0.7), 66.7, 0.12)
    # S12 67.5–75：风扇回来、Clawd 打字、挥手、尾卡
    b.add(fan(7.5), 67.5, 0.05)
    typing(b, 68.75, 23, 1.6)
    b.add(whoosh(0.3, True), 71.25, 0.15, 0.3)
    b.add(whoosh(0.3, False), 71.6, 0.12, 0.3)
    return b


# ---------- 旁白 ----------
def voice(lines, vo_dir: Path) -> np.ndarray:
    v = np.zeros(N)
    for line in lines:
        x, sr = sf.read(vo_dir / f"{line['id']}.wav", dtype="float64")
        x = resample_poly(x, SR, sr)
        x = filt(x, "high", 80)
        # 简单压缩：超过阈值的部分按 3:1 压
        thr = 0.25
        a = np.abs(x)
        x = np.where(a > thr, np.sign(x) * (thr + (a - thr) / 3), x)
        i = int(line["at"] * SR)
        v[i:i + len(x)] += x[:N - i]
    return v


def rms(x):
    return np.sqrt(np.mean(x ** 2) + 1e-12)


def main():
    lines = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    vo_dir, out = Path(sys.argv[2]), Path(sys.argv[3])
    out.mkdir(parents=True, exist_ok=True)
    mus, fx, vo = score().x, sfx().x, voice(lines, vo_dir)

    # 旁白归一到 -18 dBFS RMS（只算有声部分）
    act = np.abs(vo) > 1e-4
    vo *= 10 ** (-18 / 20) / rms(vo[act])
    # 配乐整体 -24 dBFS RMS，旁白出现时再压低 6 dB（平滑的侧链包络），人声比音乐高约 12 dB
    mus *= 10 ** (-24 / 20) / rms(mus[np.abs(mus).sum(1) > 1e-5])
    win = int(0.02 * SR)
    lvl = np.convolve(np.abs(vo), np.ones(win) / win, mode="same") > 0.01
    # 一阶包络跟随，快压（50 ms）慢放（400 ms）；在 1 kHz 下计算再插值回采样率
    CR = 1000
    duck = lvl[::SR // CR].astype(float)
    k_att, k_rel = 1 - np.exp(-1 / (0.05 * CR)), 1 - np.exp(-1 / (0.4 * CR))
    gc = np.zeros(len(duck))
    cur = 0.0
    for i, tgt in enumerate(duck):
        cur += (tgt - cur) * (k_att if tgt > cur else k_rel)
        gc[i] = cur
    g = np.interp(np.arange(N), np.arange(len(gc)) * (SR // CR), gc)
    mus *= (1 - g * (1 - 10 ** (-6 / 20)))[:, None]
    fx *= 10 ** (-3 / 20)

    mix = mus + fx + np.stack([vo, vo], axis=1)
    mix = filt(mix.T, "high", 30).T
    mix = mix[:int(DUR * SR)]
    # 末尾 0.4 s 淡出
    f = int(0.4 * SR)
    mix[-f:] *= np.linspace(1, 0, f)[:, None]
    peak = np.max(np.abs(mix))
    if peak > 0.95:
        mix *= 0.95 / peak
    for name, x in (("music", mus[:int(DUR * SR)]), ("sfx", fx[:int(DUR * SR)]), ("voice", vo[:int(DUR * SR)]), ("mix", mix)):
        sf.write(out / f"{name}.wav", x, SR, subtype="PCM_24")
        print(out / f"{name}.wav")


if __name__ == "__main__":
    main()
