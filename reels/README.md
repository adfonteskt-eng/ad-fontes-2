# Ad Fontes trivia reels

Hard Bible trivia reels (Instagram Reels / YouTube Shorts) that promote Ad Fontes.
Same rule as Receipts Mode: no Scripture is typed from memory, by a person or a model.

## Pipeline

```
generate_questions.py  ->  questions/batch-*.json      Claude drafts questions + references,
                                                       then copies answer wording from fetched text
verify_questions.py    ->  build/*.verified.json       fetches each verse (WEB, public domain) and
                                                       rejects any answer not literally in the text
render.py              ->  out/<id>.mp4, -cover.jpg,   1080x1920, 15.7s, over the 15 scene images
                           -caption.txt
```

One command: `./make_reels.sh 3` (or `./make_reels.sh 3 the life of Elijah`).

## Question rules (enforced in the generator prompt + verifier)
- Answer must be stated plainly in one cited verse (max 3 verses). No inference.
- Specific facts only (names, numbers, places, exact wording). Nothing contested
  between traditions, no prophecy interpretation, no politics.
- Two types: `mc` (3-4 options) and `fill` (finish-the-verse).
- References already used in `questions/` are never reused.

## Template
Hook (0-1.7s) -> question + options -> 5s countdown with ticks -> gold reveal (8s)
-> answer with the source verse highlighted + reference (9.7s) -> Ad Fontes CTA (13.7s).
Brand copy lives at the top of `render.py` (`BRAND`, `BRAND_LINE`, `CTA_SUB`, `CTA_LINK`).
Bright scenes get extra shading automatically so text stays readable.

## Why WEB
The World English Bible is public domain, so verse text can appear in social posts
without translation licensing questions. The app's YouVersion translations stay in the app.

Fonts: Cormorant Garamond + Inter (SIL OFL, licenses in `fonts/`).
