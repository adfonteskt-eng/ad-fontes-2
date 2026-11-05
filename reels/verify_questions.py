"""Fetch verse text for each trivia question and refuse anything that isn't backed by it.

Scripture integrity rule (same as Ad Fontes Receipts Mode): no verse text is typed
by hand or by a model. Every verse shown in a reel is fetched by reference, and
every answer must literally appear in that fetched text.

Usage: python3 verify_questions.py questions/batch-001.json  ->  build/batch-001.verified.json
"""
import json, os, re, sys, time, urllib.parse, urllib.request

API = "https://bible-api.com/{ref}?translation=web"   # World English Bible, public domain
TRANSLATION = "WEB"

def norm(s):
    s = s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", s).strip().lower()

def clean(s):
    return re.sub(r"\s+", " ", s).strip()

def fetch(ref, cache):
    if ref in cache:
        return cache[ref]
    url = API.format(ref=urllib.parse.quote(ref))
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=15) as r:
                data = json.load(r)
            break
        except Exception as e:
            if attempt == 2:
                raise RuntimeError(f"could not fetch {ref}: {e}")
            time.sleep(1.5 * (attempt + 1))
    if not data.get("verses"):
        raise RuntimeError(f"no verses returned for {ref}")
    cache[ref] = {"reference": data["reference"], "text": clean(data["text"])}
    return cache[ref]

def find_original(haystack, needle):
    """Case-insensitive find that returns the span in the original string."""
    i = norm(haystack).find(norm(needle))
    if i < 0:
        return None
    # norm() only collapses whitespace/quotes; on already-cleaned text indexes line up.
    return haystack[i:i + len(needle)]

def check(q, verse):
    errs = []
    text = verse["text"]
    excerpt = q.get("excerpt") or text
    if norm(excerpt) not in norm(text):
        errs.append("excerpt is not a verbatim part of the fetched verse")
    opts = q.get("options", [])
    if q["type"] == "mc" or (q["type"] == "fill" and opts):
        if len({norm(o) for o in opts}) != len(opts):
            errs.append("duplicate options")
        if not 2 <= len(opts) <= 4:
            errs.append("need 2-4 options")
    if q["type"] == "open":
        # open recall (list format): short answer shown in the list, backed by a verse span
        if not q.get("answer") or len(q["answer"]) > 28:
            errs.append("answer missing or too long for the list (max 28 chars)")
        if norm(q["answer_in_verse"]) not in norm(excerpt):
            errs.append("answer_in_verse not found in the verse excerpt shown")
        highlight = q["answer_in_verse"]
    elif q["type"] == "mc":
        if q["answer"] not in opts:
            errs.append("answer is not one of the options")
        if norm(q["answer_in_verse"]) not in norm(excerpt):
            errs.append("answer_in_verse not found in the verse excerpt shown")
        highlight = q["answer_in_verse"]
    elif q["type"] == "fill":
        if opts and q["blank"] not in opts:
            errs.append("blank is not one of the options")
        if norm(q["blank"]) not in norm(excerpt):
            errs.append("blank not found in the verse excerpt")
        highlight = q["blank"]
    else:
        errs.append(f"unknown type {q['type']}")
        highlight = ""
    return errs, clean(excerpt), highlight

def main(path):
    questions = json.load(open(path))
    cache, out, failed = {}, [], []
    for q in questions:
        try:
            verse = fetch(q["reference"], cache)
            errs, excerpt, highlight = check(q, verse)
        except Exception as e:
            errs, excerpt, highlight = [str(e)], "", ""
            verse = None
        if errs:
            failed.append((q["id"], errs))
            continue
        # Use the API's own wording/casing for everything that gets displayed.
        excerpt_src = find_original(verse["text"], excerpt)
        hl_src = find_original(excerpt_src, highlight)
        out.append({**q,
                    "reference": verse["reference"],
                    "translation": TRANSLATION,
                    "verse_text": verse["text"],
                    "excerpt": excerpt_src,
                    "highlight": hl_src,
                    "verified_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    os.makedirs("build", exist_ok=True)
    dest = os.path.join("build", os.path.basename(path).replace(".json", ".verified.json"))
    json.dump(out, open(dest, "w"), indent=2, ensure_ascii=False)
    for qid, errs in failed:
        print(f"REJECTED {qid}: " + "; ".join(errs))
    print(f"{len(out)} verified, {len(failed)} rejected -> {dest}")
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
