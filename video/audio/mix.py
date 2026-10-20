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
# v2 结构：A 引子 1–2 → B 律动 3–16（小牛落地进鼓）→ 17 真静音 → C 全编制 18–24（融合 + Claude Code）
#          → D 轻律动 25–26 → E 收尾 27–30（不再断，尾和弦在第 30 小节第 1 拍一直响到淡出）
CH = {  # 和弦（MIDI，根音在低八度）
    "Am": [57, 60, 64], "F": [53, 57, 60], "C": [48, 52, 55], "G": [55, 59, 62],
}
CHORDS = (["Am", "Am"]                                # A 1–2
          + ["Am", "F", "C", "G"] * 3 + ["Am", "G"]   # B 3–16
          + [None]                                    # 17 真静音
          + ["C", "G", "Am", "F", "C", "G", "F"]      # C 18–24
          + ["Am", "G"]                               # D 25–26
          + ["Am", "F", "G", "C"])                    # E 27–30
assert len(CHORDS) == 30


def section(bar: int) -> str:
    return "A" if bar <= 2 else "B" if bar <= 16 else "S" if bar == 17 else "C" if bar <= 24 else "D" if bar <= 26 else "E"


# 主旋律：(小节, 拍, MIDI, 拍长)；C 段完整一遍，E 段轻声重现前三小节
MOTIF = [
    (0, 0, 76, 1), (0, 1, 79, .5), (0, 1.5, 81, .5), (0, 2, 79, 1), (0, 3, 76, 1),
    (1, 0, 74, 1), (1, 1, 79, 1), (1, 2, 83, 1.5), (1, 3.5, 81, .5),
    (2, 0, 84, 1.5), (2, 1.5, 83, .5), (2, 2, 81, 1), (2, 3, 76, 1),
    (3, 0, 77, 1), (3, 1, 81, 1), (3, 2, 84, 1), (3, 3, 81, 1),
    (4, 0, 79, .5), (4, .5, 81, .5), (4, 1, 84, 1), (4, 2, 83, 1), (4, 3, 79, 1),
    (5, 0, 81, 1), (5, 1, 79, .5), (5, 1.5, 76, .5), (5, 2, 74, 2),
    (6, 0, 77, 1), (6, 1, 81, 1), (6, 2, 84, 2),
]


def clap():
    n = int(0.18 * SR)
    t = np.arange(n) / SR
    env = sum(np.exp(-np.clip(t - d, 0, None) * 60) * (t >= d) for d in (0, .008, .017))
    return filt(noise(n), "band", [1000, 5000]) * env * 0.6


def stab(m_list, dur):
    # 反拍和弦短切（让律动「跳」起来）
    n = int(dur * SR)
    s = sum(pulse(mtof(m), n, 0.5) for m in m_list) / len(m_list)
    return s * np.exp(-np.arange(n) / SR * 18)


def score() -> Bus:
    b = Bus()
    for bar in range(1, 31):
        ch = CHORDS[bar - 1]
        if ch is None:
            continue
        sec = section(bar)
        root, tones = CH[ch][0], CH[ch]
        t0 = bar_t(bar)
        last = bar == 30
        # 低频持续音（A、E 段）
        if sec in "AE" and not last:
            b.add(note_tri(root - 12, BAR) * 0.9, t0, 0.18)
        # 琶音：A/E 八分音符，其余十六分音符；C 段每三音升八度跳一下
        step = BEAT / 2 if sec in "AE" else BEAT / 4
        for i in range(int(round(BAR / step))):
            if last and i > 0:
                break
            m = tones[i % 3] + 24 + (12 if (i // 3) % 2 and sec == "C" else 0)
            g = {"A": .10, "B": .07, "C": .08, "D": .07, "E": .09}[sec]
            b.add(note_pulse(m, step * 0.9, 0.25), t0 + i * step, g, pan=-0.35 if i % 2 else 0.35)
        if last:
            continue
        # 贝斯：B/C/D 段用切分节奏（1、2+、3、4+），E 段四分音符
        if sec in "BCD":
            for beat, dl, up in ((0, .75, 0), (1.5, .5, 12), (2, .75, 0), (3.5, .5, 12)):
                b.add(note_tri(root - 12 + up, BEAT * dl * 0.9), t0 + beat * BEAT, 0.32)
        elif sec == "E":
            for beat in range(4):
                b.add(note_tri(root - 12, BEAT * .8), t0 + beat * BEAT, 0.24)
        # 反拍和弦短切
        if sec in "BCD":
            for beat in (.5, 1.5, 2.5, 3.5):
                b.add(stab([m + 12 for m in tones], BEAT * .3), t0 + beat * BEAT, 0.05 if sec != "C" else 0.065, 0.2)
        # 鼓组
        if sec in "BCDE":
            for beat in range(4):
                at = t0 + beat * BEAT
                if beat in (0, 2):
                    b.add(kick(), at, 0.55 if sec != "E" else 0.4)
                else:
                    b.add(snare(), at, 0.26 if sec != "E" else 0.18, 0.05)
                    b.add(clap(), at, 0.22 if sec in "BC" else 0.12, -0.1)
                if sec == "C" and beat == 3:
                    b.add(kick(), at + BEAT / 2, 0.38)
            hats = 16 if sec in "BC" else 8
            for i in range(hats):
                # 十六分音符的后半拍稍微推后，带一点摇摆感
                swing = BEAT / 4 * 0.18 if (hats == 16 and i % 2) else 0
                b.add(hat(open_=(sec == "C" and i % 8 == 6)), t0 + i * BAR / hats + swing, 0.08 if i % 2 else 0.12, 0.4)
    # 主旋律
    for bar0, gain, count in ((18, 0.13, 7), (27, 0.08, 3)):
        for k, beat, m, dl in MOTIF:
            if k < count:
                b.add(note_pulse(m, dl * BEAT * 0.95, 0.5, vib=0.25), bar_t(bar0 + k, beat), gain, 0.0)
    # 过渡：小牛落地（第 3 小节第 2 拍）镲片；静音前一拍反向镲；跺脚（第 18 小节）镲片
    b.add(crash(1.6), bar_t(3, 1), 0.22, 0.1)
    b.add(reverse_cymbal(1.0), bar_t(18) - 1.0, 0.18, -0.1)
    b.add(crash(), bar_t(18), 0.32, -0.1)
    # 尾和弦：第 30 小节第 1 拍，C 大三和弦长音，一直响到片尾淡出
    for m in (60, 64, 67, 72):
        n = int(3.0 * SR)
        s = pulse(mtof(m), n, 0.5) * np.exp(-np.arange(n) / SR * 0.9)
        b.add(s, bar_t(30), 0.07, pan=(m - 66) / 12)
    b.add(note_tri(36, 2.8), bar_t(30), 0.30)
    b.add(crash(3.0), bar_t(30), 0.18)
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


def boing(m=72, dur=0.16):
    # 角色起跳的「啵嘤」：上扬的短音
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = mtof(m) * (1 + 0.8 * t / dur)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 18)


def pop(m=84):
    n = int(0.06 * SR)
    t = np.arange(n) / SR
    return np.sin(2 * np.pi * mtof(m) * t * (1 + 2 * t)) * np.exp(-t * 60)


def fall_whistle(dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = 1800 * (1 - 0.7 * t / dur)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.minimum(1, t / .05) * 0.6


SLOT_T = [0, .94, 1.875, 2.81, 3.75, 4.69]
PENTA = [0, 2, 4, 7, 9]


def sfx() -> Bus:
    b = Bus()
    # S01 0–5：底噪；Clawd 蹦进来（四跳）、打 claude、回车、「?」；四位探头
    b.add(fan(10.0), 0, 0.04)
    for i, at in enumerate([.1, .1 + BEAT / 2, .1 + BEAT, .1 + BEAT * 1.5]):
        b.add(boing(67 + i * 2), at, 0.07)
    typing(b, 1.35, 6, 0.55)
    b.add(enter_key(), 2.05, 0.28)
    b.add(blip(79, .09) + 0.6 * np.pad(blip(84, .09), (int(.06 * SR), 0))[:int(.09 * SR)], BAR + BEAT, 0.15)
    for i in range(4):
        b.add(pop(76 + PENTA[i]), 3.3 + i * BEAT / 4, 0.09, -0.5 + i / 3)
    # S02 5–10：小牛下落哨音、落地重击、大家被震起；片名逐字；转场甩镜
    b.add(fall_whistle(.6), 5.02, 0.10)
    b.add(plug_hit(), 5.625, 0.7)
    for i in range(5):
        b.add(boing(70 + i), 5.675 + i * .06, 0.05, -0.6 + i * .15)
    for i in range(19):
        b.add(pop(84 + PENTA[i % 5] + 12 * (i // 10)), 6.25 + i * BEAT / 4, 0.04, -0.5 + i / 19)
    b.add(whoosh(0.5, True), 9.78, 0.32)
    # S03 10–17.5：一条命令；打字、粘贴 Key、标注弹出、回车、三个 ✔、插线、欢呼
    typing(b, 10.2, 24, 0.7)
    typing(b, 11.05, 7, 0.35)
    b.add(key_click() * 1.4 + 0.5 * shimmer(.2)[:int(.045 * SR)], 11.7, 0.3)
    typing(b, 12.0, 26, 1.1, 0.18)
    for at, m in ((12.25, 79), (12.55, 83), (13.2, 86)):
        b.add(pop(m), at, 0.10)
    b.add(enter_key(), 13.75, 0.32)
    for i, m in enumerate((84, 88, 91)):
        b.add(chime(m, 0.5), 14.06 + i * BEAT / 2, 0.12)
    b.add(plug_hit(), 14.74, 0.35)
    b.add(boing(74), 14.82, 0.09)
    # S04 17.5–25：老虎机滚动与落定；角色冒出；all 全员到齐
    b.add(whoosh(0.4, False), 17.32, 0.22)
    for i, st in enumerate(SLOT_T):
        if i == 0:
            continue
        for k in range(4):
            b.add(blip(96, .02, .25), 17.5 + st - .22 + k * .055, 0.04)
        b.add(chime(79 + PENTA[i % 5], 0.35), 17.5 + st, 0.10)
        b.add(boing(70 + i * 2), 17.5 + st + .05, 0.06)
    for i in range(8):
        b.add(pop(84 + PENTA[i % 5] + (12 if i > 4 else 0)), 17.5 + 4.74 + i * BEAT / 4, 0.07, -0.6 + i * .17)
    # S05 25–37.5：向导串场；卡片推移、Logo 逐行、线路切换、Key 校验、勾选、选模型
    b.add(whoosh(0.4, True), 24.82, 0.22)
    typing(b, 25.0, 23, 0.35, 0.15)
    for j in range(6):
        b.add(chime(72 + PENTA[j % 5] + (12 if j == 5 else 0), 0.4), 25.45 + j * BEAT / 4, 0.08)
    b.add(boing(72), 26.55, 0.07)
    for at in (27.2, 29.7, 32.2, 34.7):
        b.add(whoosh(0.35, True), at, 0.16)
    for at in (28.4, 28.85):
        b.add(blip(86, .05, .25), at, 0.09)
    b.add(chime(84, 0.4), 29.35, 0.11)
    b.add(key_click() * 1.4, 30.25, 0.3)
    b.add(whoosh(0.6, True), 30.35, 0.18, 0.4)
    b.add(whoosh(0.6, False), 30.95, 0.18, -0.2)
    b.add(chime(88, 0.7) + chime(84, 0.7) * .6, 31.55, 0.15)
    for i in range(13):
        if i == 11:
            continue
        b.add(key_click() * 1.2 + 0.5 * blip(91, .045), 32.75 + i * BEAT / 4, 0.16)
    for i, at in enumerate((35.5, 36.1, 36.7)):
        b.add(chime(84 + PENTA[i + 1], 0.35), at, 0.11)
    # S06 37.5–40：diff 逐行、文件夹飞、备份徽章
    b.add(whoosh(0.4, False), 37.32, 0.2)
    for i in range(3):
        b.add(blip(76 + PENTA[i], .05), 37.65 + i * BEAT / 2, 0.08)
    b.add(whoosh(0.65, False), 38.4, 0.16, -0.3)
    b.add(chime(84, 0.5), 39.05, 0.11)
    b.add(boing(72), 39.1, 0.07)
    # S07 40–50：静音一小节（只有小牛起跳前的一点动静）→ 跺脚 → 线缆逐个点亮 → Logo
    b.add(whoosh(0.4, True), 39.82, 0.18)
    b.add(boing(60, .2), 42.3, 0.06)
    b.add(plug_hit(), 42.5, 0.75)
    for i in range(13):
        b.add(flip() + 0.5 * pop(79 + PENTA[i % 5] + 12 * (i // 5)), 42.62 + i * BEAT / 4, 0.18, -0.6 + i * .1)
    for j in range(6):
        b.add(chime(84 + PENTA[j % 5], 0.5), 44.8 + j * BEAT / 4, 0.07)
    # S08 50–60：Claude Code
    b.add(whoosh(0.4, True), 49.82, 0.18)
    typing(b, 50.0, 6, 0.35)
    b.add(enter_key(), 50.4, 0.25)
    b.add(chime(81, 0.5), 50.55, 0.08)
    typing(b, 51.1, 9, 1.1)
    b.add(enter_key(), 52.4, 0.25)
    b.add(shimmer(1.2), 52.4, 0.035)
    for i in range(56):
        b.add(key_click(), 53.9 + i * 0.05, 0.05, RNG.uniform(-.3, .3))
    b.add(whoosh(0.35, True), 57.3, 0.22)
    b.add(chime(91, 0.8), 57.5, 0.07)
    b.add(boing(74), 57.85, 0.08)
    b.add(chime(96, 0.5) + chime(91, 0.5), 58.12, 0.07)
    # S09 60–65：体检、确认、倒带、还原
    b.add(whoosh(0.4, False), 59.82, 0.2)
    for i in range(6):
        b.add(chime(84 + PENTA[i % 5], 0.3), 60.25 + i * BEAT / 2, 0.08, -0.3)
    b.add(blip(81, .06), 61.9, 0.08, 0.3)
    b.add(rewind(1.6), 62.4, 0.16, 0.3)
    b.add(chime(88, 0.6), 64.0, 0.11, 0.3)
    b.add(boing(72), 64.05, 0.07, 0.3)
    # S10 65–75：呼应开场，一条命令配好全部；全员冒出欢呼；尾卡
    b.add(whoosh(0.4, False), 64.82, 0.2)
    b.add(fan(10.0), 65.0, 0.03)
    typing(b, 65.35, 41, 1.6, 0.18)
    b.add(enter_key(), 67.3, 0.3)
    for i, m in enumerate((84, 88, 91)):
        b.add(chime(m, 0.45), 67.5 + i * BEAT / 2, 0.11)
    b.add(boing(74, .2), 68.3, 0.09)
    for i in range(13):
        b.add(pop(79 + PENTA[i % 5] + 12 * (i // 5)), 68.2 + i * BEAT / 8, 0.05, -0.6 + i * .1)
    b.add(reverse_cymbal(0.8), 69.6 - 0.8 + 0.4, 0.12)
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
