"""Render verified trivia questions into 1080x1920 reels.

Input: a *.verified.json file from verify_questions.py (never unverified questions).
Output per question in out/: <id>.mp4, <id>-cover.jpg, <id>-caption.txt

Usage: python3 render.py build/batch-001.verified.json [question-id ...]
"""
import functools, json, math, os, subprocess, sys, tempfile, wave
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

# ---- Brand (one place to change the name/copy) ----------------------------
BRAND = "Ad Fontes"
BRAND_LINE = "Every answer, traced to its source."
CTA_SUB = "Study the Bible in the original Greek & Hebrew."
CTA_LINK = "Link in bio"

W, H, FPS = 1080, 1920, 30
X0 = 96                      # left margin
MAXW = W - X0 - 150          # right edge leaves room for IG/YT action buttons
HERE = os.path.dirname(os.path.abspath(__file__))
SCENES_DIR = os.environ.get("AD_FONTES_SCENES", os.path.join(HERE, "..", "public", "scenes"))

CREAM = (244, 236, 220)
GOLD = (222, 184, 112)
INK = (22, 16, 10)
SHADE = (14, 10, 6)

# Timeline (seconds)
T = dict(hook_out=1.7, q_in=1.7, opts_in=2.15, cd_start=3.0, cd_len=5.0,
         reveal=8.0, answer_in=9.7, cta_in=13.7, end=15.7)

# ---- helpers ---------------------------------------------------------------
FEATURES = ["lnum"]   # lining figures
_fonts = {}
def font(name, size):
    key = (name, size)
    if key not in _fonts:
        files = {
            "serif": "cormorant-garamond-latin-600-normal.woff",
            "serif-bold": "cormorant-garamond-latin-700-normal.woff",
            "serif-italic": "cormorant-garamond-latin-600-italic.woff",
            "sans": "inter-latin-500-normal.woff",
            "sans-semi": "inter-latin-600-normal.woff",
            "sans-bold": "inter-latin-700-normal.woff",
            "sans-black": "inter-latin-800-normal.woff",
        }
        f = ImageFont.truetype(os.path.join(HERE, "fonts", files[name]), size)
        f.getlength = functools.partial(f.getlength, features=FEATURES)
        f.getbbox = functools.partial(f.getbbox, features=FEATURES)
        _fonts[key] = f
    return _fonts[key]

def clamp(x): return 0.0 if x < 0 else 1.0 if x > 1 else x
def ease(x): x = clamp(x); return 1 - (1 - x) ** 3

def window(t, a, b=None, fin=0.4, fout=0.35):
    """Opacity for an element visible from a to b with eased fades."""
    v = ease((t - a) / fin)
    if b is not None:
        v = min(v, ease((b - t) / fout))
    return v

def rgba(c, a): return (*c, int(255 * clamp(a)))

def wrap(text, f, maxw):
    lines, cur = [], ""
    for w in text.split():
        trial = (cur + " " + w).strip()
        if f.getlength(trial) <= maxw or not cur:
            cur = trial
        else:
            lines.append(cur); cur = w
    if cur: lines.append(cur)
    return lines

def tracked(d, xy, text, f, fill, tracking):
    x, y = xy
    for ch in text:
        d.text((x, y), ch, font=f, fill=fill)
        x += f.getlength(ch) + tracking
    return x

def line_h(f, k=1.12): return int(f.size * k)

# ---- rich verse layout (highlight / blank) ---------------------------------
def verse_tokens(excerpt, highlight, as_blank):
    i = excerpt.find(highlight)
    pre, post = excerpt[:i], excerpt[i + len(highlight):]
    toks = [{"t": w, "k": "n"} for w in pre.split()]
    if as_blank:
        # keep trailing punctuation glued to the blank so it wraps together
        toks.append({"t": highlight, "k": "blank"})
    else:
        toks += [{"t": w, "k": "hl"} for w in highlight.split()]
    rest = post.split()
    if rest and post[:1] not in (" ", "") and toks:
        toks[-1] = {**toks[-1], "tail": rest.pop(0)}
    toks += [{"t": w, "k": "n"} for w in rest]
    return toks

def tok_width(tok, f):
    w = f.getlength(tok["t"])
    if tok["k"] == "blank":
        w = max(w, 200) + 16
    if tok.get("tail"):
        w += f.getlength(tok["tail"])
    return w

def layout_rich(toks, f, maxw):
    sp = f.getlength(" ")
    lines, cur, x = [], [], 0
    for tok in toks:
        w = tok_width(tok, f)
        if cur and x + sp + w > maxw:
            lines.append(cur); cur, x = [], 0
        if cur: x += sp
        cur.append((tok, x)); x += w
    if cur: lines.append(cur)
    return lines

def draw_rich(d, lines, f, x0, y0, a, reveal_a=0.0):
    lh = line_h(f, 1.18)
    for li, line in enumerate(lines):
        y = y0 + li * lh
        for tok, x in line:
            X = x0 + x
            if tok["k"] == "blank":
                bw = max(f.getlength(tok["t"]), 200) + 16
                uy = y + int(f.size * 0.98)
                d.rectangle([X, uy, X + bw, uy + 4], fill=rgba(GOLD, a * (1 - reveal_a * 0.6)))
                if reveal_a > 0:
                    d.text((X + 8, y), tok["t"], font=f, fill=rgba(GOLD, a * reveal_a))
                tail_x = X + bw
            else:
                col = GOLD if tok["k"] == "hl" else CREAM
                d.text((X, y), tok["t"], font=f, fill=rgba(col, a))
                tail_x = X + f.getlength(tok["t"])
            if tok.get("tail"):
                col = CREAM
                d.text((tail_x, y), tok["tail"], font=f, fill=rgba(col, a))
    return y0 + len(lines) * lh

# ---- background ------------------------------------------------------------
def load_background(scene):
    path = None
    if scene:
        for ext in (".webp", ".jpg", ".png"):
            p = os.path.join(SCENES_DIR, scene + ext)
            if os.path.exists(p): path = p; break
        if not path:  # allow partial ids like "scene-08"
            for fn in sorted(os.listdir(SCENES_DIR)) if os.path.isdir(SCENES_DIR) else []:
                if fn.startswith(scene[:8]) and fn.endswith((".webp", ".jpg", ".png")):
                    path = os.path.join(SCENES_DIR, fn); break
    if path:
        img = Image.open(path).convert("RGB")
    else:
        print(f"  (scene '{scene}' not found, using plain background)")
        img = Image.new("RGB", (2400, 1018), (60, 44, 30))
    scale = H * 1.06 / img.height
    img = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
    # A slight, deliberate softness reads as depth-of-field and hides upscaling.
    return img.filter(ImageFilter.GaussianBlur(2.2))

def build_overlay():
    y = np.linspace(0, 1, H)[:, None]
    # darker at top (label), lighter mid, darkest at bottom (platform UI + legibility)
    a = 0.62 - 0.22 * np.exp(-((y - 0.42) / 0.22) ** 2) + 0.3 * np.clip((y - 0.62) / 0.38, 0, 1)
    x = np.linspace(-1, 1, W)[None, :]
    a = a + 0.12 * (x ** 2)
    a = np.clip(a, 0, 0.92)
    arr = np.zeros((H, W, 4), np.uint8)
    arr[..., 0], arr[..., 1], arr[..., 2] = SHADE
    arr[..., 3] = (a * 255).astype(np.uint8)
    return Image.fromarray(arr, "RGBA")

TEXT_ZONE = (X0, 300, X0 + MAXW, 1500)
TARGET_LUMA = 70.0   # 85th-percentile background brightness (0-255) allowed behind text

def adaptive_overlay(bg, overlay, dur):
    """Darken the text zone further when a scene is bright, so cream and gold text
    stay readable on every scene, not just the dark ones."""
    lum = []
    for k in range(6):
        f = bg_frame(bg, dur * k / 5, dur).convert("RGBA")
        f.alpha_composite(overlay)
        a = np.asarray(f.convert("L").crop(TEXT_ZONE), dtype=float)
        bands = np.array_split(a, 8, axis=0)          # judge each horizontal band of text
        lum.append(max(np.percentile(x, 90) for x in bands))
    mean = max(lum)
    if mean <= TARGET_LUMA:
        return overlay
    extra = 1 - TARGET_LUMA / mean
    y = np.arange(H)[:, None]
    top, bot = TEXT_ZONE[1] - 120, TEXT_ZONE[3] + 160
    ramp = np.clip(np.minimum((y - top) / 220, (bot - y) / 260), 0, 1)
    shade = np.zeros((H, W, 4), np.uint8)
    shade[..., 0], shade[..., 1], shade[..., 2] = SHADE
    shade[..., 3] = np.broadcast_to(ramp * extra * 255, (H, W)).astype(np.uint8)
    out = overlay.copy()
    out.alpha_composite(Image.fromarray(shade, "RGBA"))
    print(f"  scene brightness {mean:.0f} -> extra shade {extra:.0%}")
    return out

def bg_frame(bg, t, dur):
    p = t / dur
    travel = min(560, bg.width - W - 40)
    cx = (bg.width - W) / 2 - travel / 2 + travel * p
    cy = (bg.height - H) / 2 + 18 * math.sin(p * math.pi)
    x, y = int(cx), int(max(0, min(bg.height - H, cy)))
    return bg.crop((x, y, x + W, y + H))

# ---- scene drawing ---------------------------------------------------------
def draw_label(d, t, q):
    a = window(t, 0.1, T["cta_in"], fin=0.5)
    if a <= 0: return
    text = "FINISH THE VERSE" if q["type"] == "fill" else "HARD BIBLE TRIVIA"
    if t >= T["answer_in"]:
        text = "THE ANSWER"
    y = 340
    d.rectangle([X0, y + 15, X0 + 44, y + 17], fill=rgba(GOLD, a))
    tracked(d, (X0 + 62, y), text, font("sans-black", 26), rgba(GOLD, a), 5)

def draw_hook(d, t, q):
    a = window(t, 0.15, T["hook_out"], fin=0.45, fout=0.3)
    if a <= 0: return
    f = font("serif-bold", 112)
    lines = wrap(q["hook"], f, MAXW)
    lh = line_h(f, 1.02)
    y = 860 - len(lines) * lh // 2 + int((1 - ease((t - 0.15) / 0.6)) * 30)
    for i, ln in enumerate(lines):
        d.text((X0, y + i * lh), ln, font=f, fill=rgba(CREAM, a))
    f2 = font("sans-semi", 32)
    d.text((X0, y + len(lines) * lh + 34), "Answer before the timer runs out.", font=f2,
           fill=rgba(CREAM, a * 0.75))

def question_layout(q):
    """Returns (draw_fn_for_prompt, prompt_bottom_y)."""
    y = 440
    if q["type"] == "mc":
        f = font("serif-bold", 86)
        lines = wrap(q["question"], f, MAXW)
        return ("mc", lines, f), y + len(lines) * line_h(f, 1.06)
    f = font("serif-italic", 70)
    toks = verse_tokens(q["excerpt"], q["highlight"], as_blank=True)
    lines = layout_rich(toks, f, MAXW)
    bottom = y + len(lines) * line_h(f, 1.18) + 14 + 44
    return ("fill", lines, f), bottom

def draw_question(d, t, q, layout, prompt_bottom):
    a = window(t, T["q_in"], T["answer_in"], fin=0.45, fout=0.4)
    if a <= 0: return
    kind, lines, f = layout
    dy = int((1 - ease((t - T["q_in"]) / 0.5)) * 26)
    y = 440 + dy
    if kind == "mc":
        for i, ln in enumerate(lines):
            d.text((X0, y + i * line_h(f, 1.06)), ln, font=f, fill=rgba(CREAM, a))
    else:
        reveal_a = ease((t - T["reveal"]) / 0.4)
        end = draw_rich(d, lines, f, X0, y, a, reveal_a)
        d.text((X0, end + 14), q["reference"], font=font("sans-semi", 30), fill=rgba(CREAM, a * 0.7))

    # options
    n = len(q["options"])
    oy = prompt_bottom + 56
    ph, gap = 116, 22
    correct = q["answer"] if q["type"] == "mc" else q["blank"]
    rv = ease((t - T["reveal"]) / 0.3)
    for i, opt in enumerate(q["options"]):
        oa = a * window(t, T["opts_in"] + 0.12 * i, None, fin=0.35)
        if oa <= 0: continue
        dx = int((1 - ease((t - T["opts_in"] - 0.12 * i) / 0.4)) * 40)
        is_c = opt == correct
        if not is_c: oa *= 1 - 0.62 * rv
        top = oy + i * (ph + gap)
        box = [X0 + dx, top, X0 + dx + MAXW, top + ph]
        if is_c and rv > 0:
            d.rounded_rectangle(box, 24, fill=rgba(SHADE, oa * 0.55 * (1 - rv)))
            d.rounded_rectangle(box, 24, fill=rgba(GOLD, oa * 0.95 * rv))
        else:
            d.rounded_rectangle(box, 24, fill=rgba(SHADE, oa * 0.55))
        d.rounded_rectangle(box, 24, outline=rgba(CREAM, oa * 0.28), width=2)
        txt_col = tuple(int(CREAM[k] + (INK[k] - CREAM[k]) * (rv if is_c else 0)) for k in range(3))
        let_col = tuple(int(GOLD[k] + (INK[k] - GOLD[k]) * (rv if is_c else 0)) for k in range(3))
        d.text((X0 + dx + 36, top + ph // 2), "ABCD"[i], font=font("sans-bold", 32),
               fill=rgba(let_col, oa), anchor="lm")
        d.text((X0 + dx + 100, top + ph // 2 + 2), opt, font=font("serif-bold", 60),
               fill=rgba(txt_col, oa), anchor="lm")

    # countdown
    cy = oy + n * (ph + gap) + 30
    ca = a * window(t, T["cd_start"] - 0.3, T["reveal"] + 0.2, fin=0.3, fout=0.25)
    if ca > 0:
        remain = clamp(1 - (t - T["cd_start"]) / T["cd_len"])
        secs = math.ceil(remain * T["cd_len"]) if t >= T["cd_start"] else int(T["cd_len"])
        d.text((X0, cy), f"Lock in your answer", font=font("sans-semi", 30), fill=rgba(CREAM, ca * 0.8))
        d.text((X0 + MAXW, cy), str(max(secs, 0)), font=font("sans-black", 34),
               fill=rgba(GOLD, ca), anchor="ra")
        by = cy + 56
        d.rounded_rectangle([X0, by, X0 + MAXW, by + 6], 3, fill=rgba(CREAM, ca * 0.2))
        if remain > 0:
            d.rounded_rectangle([X0, by, X0 + max(6, int(MAXW * remain)), by + 6], 3, fill=rgba(GOLD, ca))

def draw_answer(d, t, q):
    a = window(t, T["answer_in"] + 0.15, T["cta_in"], fin=0.5, fout=0.4)
    if a <= 0: return
    big = q["answer"] if q["type"] == "mc" else q["blank"]
    fb = font("serif-bold", 150 if len(big) <= 10 else 112)
    blines = wrap(big, fb, MAXW)
    fv = font("serif-italic", 60)
    vlines = layout_rich(verse_tokens(q["excerpt"], q["highlight"], as_blank=False), fv, MAXW)
    blh, vlh = line_h(fb, 1.0), line_h(fv, 1.18)
    total = len(blines) * blh + 50 + len(vlines) * vlh + 30 + 40
    y = max(400, 940 - total // 2) + int((1 - ease((t - T["answer_in"] - 0.15) / 0.6)) * 30)
    for i, ln in enumerate(blines):
        d.text((X0, y + i * blh), ln, font=fb, fill=rgba(CREAM, a))
    y += len(blines) * blh + 50
    va = a * ease((t - T["answer_in"] - 0.55) / 0.5)
    d.rectangle([X0, y - 22, X0 + 4, y - 22 + len(vlines) * vlh + 4], fill=rgba(GOLD, va * 0.8))
    end = draw_rich(d, vlines, fv, X0 + 34, y - 10, va)
    d.text((X0 + 34, end + 22), f"{q['reference']}  ·  {q['translation']}", font=font("sans-semi", 32),
           fill=rgba(GOLD, va))

def draw_cta(d, t, q):
    a = window(t, T["cta_in"] + 0.15, None, fin=0.55)
    if a <= 0: return
    y = 760 + int((1 - ease((t - T["cta_in"]) / 0.7)) * 26)
    d.rectangle([X0, y, X0 + 64, y + 3], fill=rgba(GOLD, a))
    tracked(d, (X0, y + 40), BRAND.upper(), font("sans-black", 62), rgba(GOLD, a), 14)
    f = font("serif-italic", 66)
    yy = y + 150
    for ln in wrap(BRAND_LINE, f, MAXW):
        d.text((X0, yy), ln, font=f, fill=rgba(CREAM, a)); yy += line_h(f, 1.05)
    fs = font("sans", 32)
    yy += 24
    for ln in wrap(CTA_SUB, fs, MAXW):
        d.text((X0, yy), ln, font=fs, fill=rgba(CREAM, a * 0.78)); yy += line_h(fs, 1.3)
    yy += 36
    fl = font("sans-bold", 30)
    lw = fl.getlength(CTA_LINK)
    d.rounded_rectangle([X0, yy, X0 + lw + 64, yy + 70], 35, fill=rgba(GOLD, a))
    d.text((X0 + 32, yy + 35), CTA_LINK, font=fl, fill=rgba(INK, a), anchor="lm")

# ---- audio -----------------------------------------------------------------
def synth_audio(path, dur, sr=44100):
    n = int(dur * sr); t = np.arange(n) / sr
    out = np.zeros(n)
    # warm, low pad (A, E, C#) with slow swell
    for f0, v in ((110, 0.05), (164.81, 0.035), (220, 0.03), (277.18, 0.018)):
        out += v * np.sin(2 * np.pi * f0 * t) * (0.75 + 0.25 * np.sin(2 * np.pi * 0.11 * t + f0))
    out *= np.clip(t / 1.2, 0, 1) * np.clip((dur - t) / 1.5, 0, 1)
    def blip(at, freq, length, vol, decay):
        i0 = int(at * sr); m = int(length * sr)
        if i0 >= n: return
        tt = np.arange(min(m, n - i0)) / sr
        out[i0:i0 + len(tt)] += vol * np.sin(2 * np.pi * freq * tt) * np.exp(-tt * decay)
    for k in range(int(T["cd_len"])):
        blip(T["cd_start"] + k, 1650 if k < T["cd_len"] - 1 else 1250, 0.08, 0.18, 60)
    for f0, v in ((659.25, 0.16), (987.77, 0.11), (1318.5, 0.07)):   # reveal chime
        blip(T["reveal"], f0, 2.2, v, 2.4)
    for f0, v in ((220, 0.08), (329.63, 0.06)):                      # soft CTA swell
        blip(T["cta_in"], f0, 2.0, v, 1.6)
    out = np.clip(out, -0.95, 0.95)
    pcm = (out * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())

# ---- caption ---------------------------------------------------------------
def caption(q):
    if q["type"] == "mc":
        head = f"{q['hook']}. {q['question']}"
    else:
        head = f"{q['hook']} ({q['reference']})"
    return (f"{head}\n\nComment your answer before the reveal.\n\n"
            f"Answer from {q['reference']} ({q['translation']}), pulled straight from the text.\n\n"
            f"{BRAND} — {BRAND_LINE.lower().rstrip('.')}. {CTA_LINK}.\n\n"
            "#bibletrivia #biblestudy #scripture #christian #faith")

# ---- main ------------------------------------------------------------------
def render(q, outdir):
    for k in ("verse_text", "excerpt", "highlight", "verified_at"):
        if not q.get(k):
            raise SystemExit(f"{q.get('id')}: not verified (missing {k}); run verify_questions.py first")
    os.makedirs(outdir, exist_ok=True)
    dur = T["end"]
    bg = load_background(q.get("scene"))
    overlay = adaptive_overlay(bg, build_overlay(), dur)
    layout, pbottom = question_layout(q)
    wav = os.path.join(tempfile.gettempdir(), q["id"] + ".wav")
    synth_audio(wav, dur)
    mp4 = os.path.join(outdir, q["id"] + ".mp4")
    cmd = ["ffmpeg", "-y", "-loglevel", "error",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
           "-i", wav, "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-shortest", mp4]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    cover_t = T["cd_start"] + 0.4
    nframes = int(dur * FPS)
    for fi in range(nframes):
        t = fi / FPS
        frame = bg_frame(bg, t, dur).convert("RGBA")
        frame.alpha_composite(overlay)
        layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer, "RGBA")
        d.text = functools.partial(d.text, features=FEATURES)
        draw_label(d, t, q); draw_hook(d, t, q)
        draw_question(d, t, q, layout, pbottom)
        draw_answer(d, t, q); draw_cta(d, t, q)
        frame.alpha_composite(layer)
        rgb = frame.convert("RGB")
        if fi == int(cover_t * FPS):
            rgb.save(os.path.join(outdir, q["id"] + "-cover.jpg"), quality=90)
        proc.stdin.write(rgb.tobytes())
    proc.stdin.close()
    if proc.wait() != 0:
        raise SystemExit("ffmpeg failed")
    os.remove(wav)
    open(os.path.join(outdir, q["id"] + "-caption.txt"), "w").write(caption(q))
    return mp4

if __name__ == "__main__":
    src = sys.argv[1]
    only = set(sys.argv[2:])
    qs = [q for q in json.load(open(src)) if not only or q["id"] in only]
    for q in qs:
        print("rendering", q["id"])
        print("  ->", render(q, os.path.join(HERE, "out")))
