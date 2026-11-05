"""Render a 5-question "list" trivia reel (the format that does well on Reels/Shorts).

A numbered list 1-5 stays on screen the whole reel; each question gets a countdown,
then its answer drops into the list with its verse reference. Ends on
"How many did you get?" so people comment their score.

Input: one verified set (build/set-*.verified.json from verify_questions.py), 3-6 questions.
Output: out/<set>.mp4, out/<set>-cover.jpg, out/<set>-caption.txt

Usage: python3 render_list.py build/set-001.verified.json
"""
import functools, json, math, os, subprocess, sys, tempfile, wave
import numpy as np
from PIL import Image, ImageDraw

import render as R          # shared fonts, colors, backgrounds, verse layout
from render import W, H, FPS, X0, MAXW, CREAM, GOLD, INK, SHADE, font, wrap, ease, window, rgba, tracked, line_h

TITLE = "Hard Bible Trivia"
OUTRO_TITLE = "How many did you get?"
OUTRO_SUB = "Comment your score. Share to challenge a friend."

# layout (px)
LABEL_Y = 300
Q_Y = 372
LIST_Y = 960
ROW_H = 112

# timing (s)
INTRO = 2.6
COUNT = 3.0
REVEAL = 1.9
XFADE = 0.6
OUTRO = 5.0

def read_time(q):
    text = q["excerpt"] if q["type"] == "fill" else q["question"]
    return max(2.2, min(3.8, 1.5 + 0.1 * len(text.split())))

def build_timeline(qs):
    t, segs = INTRO, []
    for q in qs:
        r = read_time(q)
        segs.append(dict(start=t, cd=t + r, reveal=t + r + COUNT, end=t + r + COUNT + REVEAL))
        t = segs[-1]["end"]
    return segs, t, t + OUTRO

# ---------------------------------------------------------------------------
def draw_list(d, t, qs, segs, outro_t):
    n = len(qs)
    a_list = window(t, 0.5, None, fin=0.6)
    for i, (q, s) in enumerate(zip(qs, segs)):
        y = LIST_Y + i * ROW_H
        active = s["start"] <= t < s["end"]
        filled = t >= s["reveal"]
        num_col = GOLD if (active or filled) else CREAM
        num_a = a_list * (1.0 if (active or filled) else 0.55)
        d.text((X0, y + 6), f"{i + 1}.", font=font("sans-black", 40), fill=rgba(num_col, num_a))
        ax = X0 + 72
        if filled:
            k = ease((t - s["reveal"]) / 0.45)
            dx = int((1 - k) * 24)
            flash = max(0.0, 1 - (t - s["reveal"]) / 0.9)          # gold -> cream
            col = tuple(int(CREAM[c] + (GOLD[c] - CREAM[c]) * flash) for c in range(3))
            d.text((ax + dx, y - 4), q["answer"], font=font("serif-bold", 58), fill=rgba(col, a_list * k))
            d.text((ax + dx + 2, y + 62), q["reference"], font=font("sans-semi", 26),
                   fill=rgba(GOLD, a_list * k * 0.85))
        else:
            # empty slot: a faint rule; the active one is brighter
            ra = a_list * (0.55 if active else 0.18)
            d.rectangle([ax, y + 44, ax + 300, y + 46], fill=rgba(CREAM, ra))

def draw_label(d, t, text, a):
    if a <= 0: return
    d.rectangle([X0, LABEL_Y + 15, X0 + 44, LABEL_Y + 17], fill=rgba(GOLD, a))
    tracked(d, (X0 + 62, LABEL_Y), text, font("sans-black", 26), rgba(GOLD, a), 5)

def draw_intro(d, t, n):
    a = window(t, 0.1, INTRO, fin=0.45, fout=0.35)
    if a <= 0: return
    draw_label(d, t, f"{n} QUESTIONS · KEEP SCORE", a)
    f = font("serif-bold", 128)
    y = Q_Y + 40 + int((1 - ease((t - 0.1) / 0.6)) * 30)
    for i, ln in enumerate(wrap(TITLE, f, MAXW)):
        d.text((X0, y + i * line_h(f, 1.0)), ln, font=f, fill=rgba(CREAM, a))

def countdown(d, t, s, y, a):
    remain = min(1.0, max(0.0, 1 - (t - s["cd"]) / COUNT))
    secs = max(1, math.ceil(remain * COUNT))
    r = 46
    cx, cy = X0 + r, y + r
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=rgba(CREAM, a * 0.22), width=5)
    if remain > 0:
        d.arc([cx - r, cy - r, cx + r, cy + r], -90, -90 + 360 * remain, fill=rgba(GOLD, a), width=5)
    d.text((cx, cy + 2), str(secs), font=font("sans-black", 44), fill=rgba(CREAM, a), anchor="mm")

def draw_question(d, t, i, q, s, n):
    a = window(t, s["start"] + 0.05, s["end"], fin=0.35, fout=0.3)
    if a <= 0: return
    label = "FINISH THE VERSE" if q["type"] == "fill" else f"QUESTION {i + 1} OF {n}"
    draw_label(d, t, label, a)
    dy = int((1 - ease((t - s["start"]) / 0.45)) * 22)
    y = Q_Y + dy
    rv = ease((t - s["reveal"]) / 0.35)
    if q["type"] == "fill":
        f = font("serif-italic", 68)
        lines = R.layout_rich(R.verse_tokens(q["excerpt"], q["blank"], as_blank=True), f, MAXW)
        end = R.draw_rich(d, lines, f, X0, y, a, rv)
        d.text((X0, end + 12), q["reference"], font=font("sans-semi", 30), fill=rgba(CREAM, a * 0.7))
        below = end + 80
    else:
        f = font("serif-bold", 78)
        lines = wrap(q["question"], f, MAXW)
        for k, ln in enumerate(lines):
            d.text((X0, y + k * line_h(f, 1.06)), ln, font=f, fill=rgba(CREAM, a))
        below = y + len(lines) * line_h(f, 1.06) + 40
    # countdown, then (for open questions) the verse that answers it
    ca = a * window(t, s["cd"] - 0.25, s["reveal"] + 0.05, fin=0.25, fout=0.2)
    if ca > 0:
        countdown(d, t, s, below, ca)
    if q["type"] != "fill":
        va = a * ease((t - s["reveal"] - 0.1) / 0.4)
        if va > 0:
            fv = font("serif-italic", 46)
            vl = R.layout_rich(R.verse_tokens(q["excerpt"], q["highlight"], as_blank=False), fv, MAXW - 30)
            vl = vl[:4]
            d.rectangle([X0, below - 4, X0 + 4, below - 4 + len(vl) * line_h(fv, 1.18)], fill=rgba(GOLD, va * 0.8))
            R.draw_rich(d, vl, fv, X0 + 28, below - 8, va)

def draw_outro(d, t, outro_t):
    a = window(t, outro_t + 0.1, None, fin=0.5)
    if a <= 0: return
    y = Q_Y + int((1 - ease((t - outro_t) / 0.6)) * 26)
    f = font("serif-bold", 84)
    for ln in wrap(OUTRO_TITLE, f, MAXW):
        d.text((X0, y), ln, font=f, fill=rgba(CREAM, a)); y += line_h(f, 1.02)
    fs = font("sans-semi", 34)
    y += 18
    for ln in wrap(OUTRO_SUB, fs, MAXW):
        d.text((X0, y), ln, font=fs, fill=rgba(CREAM, a * 0.85)); y += line_h(fs, 1.3)
    b = window(t, outro_t + 1.2, None, fin=0.6)
    y += 44
    d.rectangle([X0, y, X0 + 56, y + 3], fill=rgba(GOLD, b))
    tracked(d, (X0, y + 22), R.BRAND.upper(), font("sans-black", 36), rgba(GOLD, b), 10)
    d.text((X0, y + 74), R.BRAND_LINE, font=font("serif-italic", 44), fill=rgba(CREAM, b))

# ---------------------------------------------------------------------------
def synth_audio(path, segs, dur, outro_t, sr=44100):
    n = int(dur * sr); t = np.arange(n) / sr
    out = np.zeros(n)
    for f0, v in ((110, 0.045), (164.81, 0.03), (220, 0.026), (277.18, 0.015)):
        out += v * np.sin(2 * np.pi * f0 * t) * (0.75 + 0.25 * np.sin(2 * np.pi * 0.09 * t + f0))
    out *= np.clip(t / 1.5, 0, 1) * np.clip((dur - t) / 2.0, 0, 1)
    def blip(at, freq, length, vol, decay):
        i0 = int(at * sr)
        if i0 >= n: return
        tt = np.arange(min(int(length * sr), n - i0)) / sr
        out[i0:i0 + len(tt)] += vol * np.sin(2 * np.pi * freq * tt) * np.exp(-tt * decay)
    for s in segs:
        blip(s["start"], 330, 0.6, 0.06, 6)                    # soft cue for a new question
        for k in range(int(COUNT)):
            blip(s["cd"] + k, 1650, 0.08, 0.16, 60)
        for f0, v in ((659.25, 0.15), (987.77, 0.1), (1318.5, 0.06)):
            blip(s["reveal"], f0, 1.8, v, 2.6)
    for f0, v in ((220, 0.08), (329.63, 0.06), (440, 0.04)):
        blip(outro_t, f0, 2.5, v, 1.4)
    pcm = (np.clip(out, -0.95, 0.95) * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())

def caption(qs):
    refs = ", ".join(q["reference"] for q in qs)
    return (f"{len(qs)} Bible questions. How many can you get without looking it up?\n\n"
            "Comment your score and share this with a friend who thinks they know their Bible.\n\n"
            f"Every answer comes straight from the text: {refs} (WEB).\n\n"
            f"{R.BRAND}: {R.BRAND_LINE} {R.CTA_LINK}.\n\n"
            "#bibletrivia #biblequiz #biblestudy #scripture #christian")

class Backgrounds:
    """One drifting scene per question, cross-faded, each with its own legibility shading."""
    def __init__(self, qs, segs, dur):
        self.items = []
        for q, s in zip(qs, segs):
            bg = R.load_background(q.get("scene"))
            span = s["end"] - s["start"] + 2 * XFADE
            ov = R.adaptive_overlay(bg, R.build_overlay(), span)
            self.items.append((bg, ov, span))
        self.segs, self.dur = segs, dur

    def frame_for(self, k, t):
        bg, ov, span = self.items[k]
        s = self.segs[k]
        start = 0.0 if k == 0 else s["start"] - XFADE
        local = min(max(t - start, 0), span)
        f = R.bg_frame(bg, local, span).convert("RGBA")
        f.alpha_composite(ov)
        return f

    def at(self, t):
        # index of the scene that owns time t
        k = 0
        for i, s in enumerate(self.segs):
            if t >= s["start"]:
                k = i
        cur = self.frame_for(k, t)
        if k > 0 and t < self.segs[k]["start"] + XFADE:
            prev = self.frame_for(k - 1, t)
            m = ease((t - self.segs[k]["start"]) / XFADE)
            return Image.blend(prev, cur, m)
        return cur

def render(path):
    qs = json.load(open(path))
    for q in qs:
        for k in ("verse_text", "excerpt", "highlight", "verified_at"):
            if not q.get(k):
                raise SystemExit(f"{q.get('id')}: not verified (missing {k}); run verify_questions.py first")
    if not 3 <= len(qs) <= 6:
        raise SystemExit("a list reel needs 3-6 questions")
    name = os.path.basename(path).replace(".verified.json", "")
    outdir = os.path.join(R.HERE, "out"); os.makedirs(outdir, exist_ok=True)
    segs, outro_t, dur = build_timeline(qs)
    print(f"{name}: {len(qs)} questions, {dur:.1f}s")
    bgs = Backgrounds(qs, segs, dur)
    wav = os.path.join(tempfile.gettempdir(), name + ".wav")
    synth_audio(wav, segs, dur, outro_t)
    mp4 = os.path.join(outdir, name + ".mp4")
    cmd = ["ffmpeg", "-y", "-loglevel", "error",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
           "-i", wav, "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-shortest", mp4]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    cover_f = int(1.6 * FPS)
    for fi in range(int(dur * FPS)):
        t = fi / FPS
        frame = bgs.at(t)
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer, "RGBA")
        d.text = functools.partial(d.text, features=R.FEATURES)
        draw_intro(d, t, len(qs))
        for i, (q, s) in enumerate(zip(qs, segs)):
            draw_question(d, t, i, q, s, len(qs))
        draw_outro(d, t, outro_t)
        draw_list(d, t, qs, segs, outro_t)
        frame.alpha_composite(layer)
        rgb = frame.convert("RGB")
        if fi == cover_f:
            rgb.save(os.path.join(outdir, name + "-cover.jpg"), quality=90)
        proc.stdin.write(rgb.tobytes())
    proc.stdin.close()
    if proc.wait() != 0:
        raise SystemExit("ffmpeg failed")
    os.remove(wav)
    open(os.path.join(outdir, name + "-caption.txt"), "w").write(caption(qs))
    print("  ->", mp4)

if __name__ == "__main__":
    for p in sys.argv[1:]:
        render(p)
