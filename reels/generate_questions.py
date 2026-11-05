"""Draft a batch of trivia questions with Claude, grounded in fetched verse text.

Pass 1: Claude proposes questions + references (it never supplies verse wording).
Pass 2: the script fetches each verse (WEB, public domain); Claude then picks the
        excerpt / answer phrase by copying from that fetched text.
Then:   verify_questions.py rules are applied; anything that fails is dropped.

Usage: python3 generate_questions.py 6            -> questions/batch-YYYYMMDD-HHMM.json
       python3 generate_questions.py 6 --theme "the judges of Israel"
Needs ANTHROPIC_API_KEY (read from ../.env if not in the environment).
"""
import argparse, glob, json, os, random, re, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from verify_questions import fetch, check  # same rules as the render gate

MODEL = os.environ.get("REELS_MODEL", "claude-sonnet-5")
API = "https://api.anthropic.com/v1/messages"

HOOKS = ["Only 1 in 10 get this right", "Most Christians miss this one",
         "Bible scholars only", "Can you finish this verse?",
         "Even pastors get this wrong", "Think you know your Bible?"]

RULES = """You write HARD but FAIR Bible trivia for short vertical videos (Instagram Reels / YouTube Shorts).
They promote "Ad Fontes", a Bible study app whose promise is that every answer traces to its source.

Hard rules:
- Every question is answered by the LITERAL WORDING of ONE verse (or a range of at most 3 verses).
  The correct answer must be stated plainly in that text. No inference, no outside history.
- Specific, checkable facts only: names, numbers, places, objects, who-said-what, and exact verse wording.
- Avoid anything contested between Christian traditions or politically charged: no doctrine
  (baptism, predestination, end times, gifts, church government), no interpretation of prophecy,
  no "which denomination", no gender/sexuality/politics, no dating debates.
- NO details that differ between ancient manuscripts or major translations (e.g. Goliath's height,
  the ending of Mark, John 7:53-8:11, numbers that differ between Kings and Chronicles, or between
  the Hebrew and the Greek Old Testament). If you are not sure a detail is stable, skip it.
- Avoid trick questions and questions about what the Bible does NOT say.
- "Hard" means a lesser-known detail, not an ambiguous one. Wrong options must be clearly wrong
  according to the cited text, but plausible to someone who hasn't read it closely.
- Options: 3-4 short options (1-4 words each), all the same type (all names, all numbers...).
- Mix testaments and books. Do not repeat any reference listed under "Already used".
- Two types:
  * "mc": a question with options.
  * "fill": finish-the-verse. The blank is a distinctive 1-3 word phrase from a well-known verse.
"""

def api_key():
    k = os.environ.get("ANTHROPIC_API_KEY")
    if k:
        return k
    env = os.path.join(HERE, "..", ".env")
    if os.path.exists(env):
        for line in open(env):
            if line.startswith("ANTHROPIC_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("ANTHROPIC_API_KEY not set")

def claude(prompt, max_tokens=4000):
    body = json.dumps({"model": MODEL, "max_tokens": max_tokens,
                       "messages": [{"role": "user", "content": prompt}]}).encode()
    req = urllib.request.Request(API, data=body, headers={
        "x-api-key": api_key(), "anthropic-version": "2023-06-01", "content-type": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                data = json.load(r)
            return "".join(b.get("text", "") for b in data["content"])
        except Exception as e:
            if attempt == 2:
                raise
            time.sleep(3 * (attempt + 1))

def extract_json(text):
    m = re.search(r"\[.*\]", text, re.S)
    if not m:
        open(os.path.join(HERE, "build", "last-model-output.txt"), "w").write(text)
        raise ValueError("no JSON array in model output (saved to build/last-model-output.txt)")
    return json.loads(m.group(0))

def used_references():
    refs = set()
    for p in glob.glob(os.path.join(HERE, "questions", "*.json")):
        try:
            refs |= {q["reference"] for q in json.load(open(p))}
        except Exception:
            pass
    return refs

def scenes():
    path = os.path.join(HERE, "..", "public", "scenes", "scenes.json")
    if not os.path.exists(path):
        return []
    return [(s["file"].rsplit(".", 1)[0], s["scene"]) for s in json.load(open(path))]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("count", type=int)
    ap.add_argument("--theme", default="")
    ap.add_argument("--fill-ratio", type=float, default=0.34)
    a = ap.parse_args()

    used = sorted(used_references())
    want = a.count
    n_fill = round(want * a.fill_ratio)
    scene_list = scenes()
    scene_txt = "\n".join(f"- {sid}: {name}" for sid, name in scene_list) or "- (none)"

    # ---- pass 1: propose (over-generate; some will be rejected) ----
    p1 = f"""{RULES}
Write {want + 4} candidates: about {n_fill + 2} of type "fill", the rest "mc".
{('Theme for this batch: ' + a.theme) if a.theme else ''}
Already used (do not reuse these references): {', '.join(used) or 'none'}

Hook options (pick one per question, vary them): {json.dumps(HOOKS)}
Background scenes (pick the id whose mood best fits the question):
{scene_txt}

Return ONLY a JSON array. Each item:
{{"id": "short-kebab-id", "type": "mc"|"fill", "hook": "...", "question": "... (mc only)",
  "options": ["...", "..."], "answer": "... (mc only, must equal one option)",
  "fill_answer": "... (fill only, the missing words, must equal one option)",
  "reference": "Book C:V", "scene": "scene id"}}
Do NOT include any verse text; it will be fetched separately."""
    try:
        cands = extract_json(claude(p1))
    except ValueError:
        cands = extract_json(claude(p1))

    # ---- fetch the real text ----
    cache, grounded_in = {}, []
    for c in cands:
        try:
            v = fetch(c["reference"], cache)
            grounded_in.append({**c, "verse_text": v["text"], "reference": v["reference"]})
        except Exception as e:
            print(f"skip {c.get('id')}: {e}")

    # ---- pass 2: ground answers in the fetched text (copy, don't recall) ----
    p2 = f"""Below are trivia drafts, each with the exact verse text (World English Bible).
For each item, using ONLY the given verse_text:
- If the verse text does not plainly state the correct answer, set "drop": true.
- Also set "drop": true if this detail is known to differ between manuscripts or between major
  translations, or if any wrong option is actually a reading found in some manuscripts.
- "excerpt": copy a contiguous span of verse_text (max ~170 characters) that contains the answer.
  Copy it character-for-character.
- mc: "answer_in_verse": copy the shortest span of the excerpt that states the answer.
- fill: "blank": copy the exact words from the excerpt that will be blanked out (must match
  fill_answer in meaning; then set options so the correct option is exactly this blank text).
- If the verse uses different wording than the answer/option (e.g. "nine hundred sixty-nine"
  for 969), keep the option short and readable but make answer_in_verse the verse's own words.
Return ONLY the JSON array with these fields added (keep all others).

{json.dumps(grounded_in, ensure_ascii=False, indent=1)}"""
    try:
        grounded = extract_json(claude(p2, max_tokens=6000))
    except ValueError:
        grounded = extract_json(claude(p2, max_tokens=6000))

    # ---- verify with the same rules as the render gate ----
    keep, rejected = [], []
    for q in grounded:
        if q.get("drop"):
            rejected.append((q.get("id"), "model dropped: not stated in text")); continue
        q.pop("fill_answer", None)
        q.pop("verse_text", None)
        q.pop("drop", None)
        random.shuffle(q["options"])   # models tend to list the right answer first
        try:
            errs, _, _ = check(q, fetch(q["reference"], cache))
        except Exception as e:
            errs = [str(e)]
        if errs:
            rejected.append((q.get("id"), "; ".join(errs)))
        elif len(keep) < want:
            keep.append(q)
    os.makedirs(os.path.join(HERE, "questions"), exist_ok=True)
    out = os.path.join(HERE, "questions", time.strftime("batch-%Y%m%d-%H%M.json"))
    json.dump(keep, open(out, "w"), indent=2, ensure_ascii=False)
    for qid, why in rejected:
        print(f"rejected {qid}: {why}")
    print(f"{len(keep)} questions kept -> {out}")

if __name__ == "__main__":
    main()
