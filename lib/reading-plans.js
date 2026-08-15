// Reading plans: short, curated, ordered sequences of passages a signed-in
// user can work through at their own pace, tracking which days they've
// completed. Distinct from lib/daily-passage.js's rotation in the thing it
// optimizes for: daily-passage is the same single reference for every
// visitor on a given calendar day (a low-commitment habit hook); a reading
// plan is a named, multi-day arc a specific user opts into and returns to,
// with real per-user progress behind it.
//
// Static content, same pattern as DAILY_PASSAGES in lib/daily-passage.js —
// no admin UI or database table for the plans themselves, just a curated
// list committed to the repo. Only per-user *progress* through a plan
// (supabase/schema.sql's reading_plan_progress, keyed by this file's plan
// `id` + a day number) needs a database row; the plan content itself is
// static and versioned with the code, same reasoning as the daily passage
// list.
//
// Every `usfm` here is a single verse, deliberately — gatherPassage() and
// the original-language interlinear are both built and tested against
// single-verse references (see lib/interlinear.js's parseReference()); a
// multi-verse range like "JHN.3.16-18" fetches translations fine via
// YouVersion's own range syntax but isn't guaranteed to resolve cleanly in
// the tagged Greek/Hebrew lookup, which keys off one exact verse. A reading
// plan reusing the exact same "click a reference -> gather + chat" flow
// daily-passage already uses is only safe to do with single verses, so
// that's the whole plan's worth of reason.
//
// `label`/`tag` intentionally overlap with a handful of entries in
// DAILY_PASSAGES (lib/daily-passage.js) — some verses are simply the right
// fit for both a one-off daily nudge and a themed multi-day arc, and this
// file is kept independent (no import from daily-passage.js) so changing
// one rotation's curation never silently reshapes the other's.
export const READING_PLANS = [
  {
    id: "gospel-in-six-verses",
    title: "The Gospel in Six Verses",
    description: "The whole arc of the gospel, one verse a day: our need, God's love, grace, and what it means to be made new.",
    days: [
      { day: 1, usfm: "ROM.3.23", label: "Romans 3:23", tag: "All have sinned and fall short of the glory of God." },
      { day: 2, usfm: "ROM.5.8", label: "Romans 5:8", tag: "God shows his love in that while we were still sinners, Christ died for us." },
      { day: 3, usfm: "EPH.2.8", label: "Ephesians 2:8", tag: "By grace you have been saved through faith." },
      { day: 4, usfm: "ROM.8.1", label: "Romans 8:1", tag: "No condemnation for those in Christ Jesus." },
      { day: 5, usfm: "2CO.5.17", label: "2 Corinthians 5:17", tag: "If anyone is in Christ, he is a new creation." },
      { day: 6, usfm: "ROM.8.38", label: "Romans 8:38", tag: "Nothing can separate us from the love of God." },
    ],
  },
  {
    id: "character-of-god",
    title: "The Character of God",
    description: "Six passages, six angles on who God actually says he is — from his own name to his unchanging love.",
    days: [
      { day: 1, usfm: "EXO.3.14", label: "Exodus 3:14", tag: "God gives Moses a name that's really an answer." },
      { day: 2, usfm: "PSA.145.18", label: "Psalm 145:18", tag: "The Lord is near to all who call on him in truth." },
      { day: 3, usfm: "LAM.3.22", label: "Lamentations 3:22", tag: "His mercies are new every morning — hope written from inside real grief." },
      { day: 4, usfm: "ISA.55.8", label: "Isaiah 55:8", tag: "My thoughts are not your thoughts — a word for whatever feels unresolved." },
      { day: 5, usfm: "MAL.3.6", label: "Malachi 3:6", tag: "I the Lord do not change — the last word of the Old Testament era." },
      { day: 6, usfm: "1JN.4.8", label: "1 John 4:8", tag: "God is love — one of the most quoted, least simple claims in the Bible." },
    ],
  },
  {
    id: "facing-fear-and-anxiety",
    title: "Facing Fear and Anxiety",
    description: "Six passages worth returning to whenever fear or worry is louder than everything else.",
    days: [
      { day: 1, usfm: "JOS.1.9", label: "Joshua 1:9", tag: "Be strong and courageous — spoken right as the real work begins." },
      { day: 2, usfm: "ISA.41.10", label: "Isaiah 41:10", tag: "Fear not, for I am with you." },
      { day: 3, usfm: "MAT.6.26", label: "Matthew 6:26", tag: "Look at the birds of the air — Jesus' case against anxiety." },
      { day: 4, usfm: "PHP.4.6", label: "Philippians 4:6", tag: "Do not be anxious about anything — Paul's actual instructions, not just the feeling." },
      { day: 5, usfm: "PSA.34.8", label: "Psalm 34:8", tag: "Taste and see that the Lord is good." },
      { day: 6, usfm: "1PE.5.7", label: "1 Peter 5:7", tag: "Cast all your anxieties on him, because he cares for you." },
    ],
  },
];

/**
 * Looks up one plan by id, or undefined if it doesn't exist (a stale id
 * from an old bookmark/localStorage entry, or the plan list having changed
 * since a user started it -- callers should treat undefined as "not
 * found," not throw).
 */
export function getReadingPlan(planId) {
  return READING_PLANS.find((plan) => plan.id === planId);
}

/**
 * True if `day` is one of this plan's actual day numbers -- guards against
 * marking a nonexistent day (e.g. day 99 of a 6-day plan) "complete" via a
 * malformed or stale request.
 */
export function isValidPlanDay(plan, day) {
  return plan.days.some((d) => d.day === day);
}
