// "Today's passage" on the homepage — a lightweight habit hook, not a
// feature that needs accounts or a database. Everyone sees the same
// reference on a given calendar day (UTC), picked deterministically from a
// curated list rather than randomly, so it's reproducible (useful for
// caching/testing) and so the list visibly cycles through a broad spread of
// Scripture rather than clustering on whatever a random draw happens to
// favor.
//
// Deliberately just a reference + label, not a gathered passage: the
// frontend already has a complete, working flow for turning a reference
// into a full study (translations/interlinear/commentary/chat reply) via
// the chat box — reusing that means this feature adds zero new gather
// logic, just a way to pre-fill today's question.

// Spans both testaments and a broad range of themes (creation, covenant,
// wisdom, prophetic promise, gospel narrative, the teaching of Jesus,
// epistles, eschatology) rather than clustering on a handful of famous
// verses — the point of a daily rotation is to nudge someone toward
// passages they might not have opened on their own.
export const DAILY_PASSAGES = [
  { usfm: "GEN.1.1", label: "Genesis 1:1" },
  { usfm: "GEN.1.27", label: "Genesis 1:27" },
  { usfm: "GEN.3.15", label: "Genesis 3:15" },
  { usfm: "GEN.12.2", label: "Genesis 12:2" },
  { usfm: "GEN.15.6", label: "Genesis 15:6" },
  { usfm: "GEN.50.20", label: "Genesis 50:20" },
  { usfm: "EXO.3.14", label: "Exodus 3:14" },
  { usfm: "EXO.20.3", label: "Exodus 20:3" },
  { usfm: "DEU.6.4", label: "Deuteronomy 6:4" },
  { usfm: "DEU.6.5", label: "Deuteronomy 6:5" },
  { usfm: "DEU.31.6", label: "Deuteronomy 31:6" },
  { usfm: "JOS.1.9", label: "Joshua 1:9" },
  { usfm: "RUT.1.16", label: "Ruth 1:16" },
  { usfm: "1SA.16.7", label: "1 Samuel 16:7" },
  { usfm: "2SA.7.16", label: "2 Samuel 7:16" },
  { usfm: "JOB.19.25", label: "Job 19:25" },
  { usfm: "JOB.42.2", label: "Job 42:2" },
  { usfm: "PSA.1.1", label: "Psalm 1:1" },
  { usfm: "PSA.19.1", label: "Psalm 19:1" },
  { usfm: "PSA.23.1", label: "Psalm 23:1" },
  { usfm: "PSA.27.1", label: "Psalm 27:1" },
  { usfm: "PSA.34.8", label: "Psalm 34:8" },
  { usfm: "PSA.46.1", label: "Psalm 46:1" },
  { usfm: "PSA.51.10", label: "Psalm 51:10" },
  { usfm: "PSA.90.12", label: "Psalm 90:12" },
  { usfm: "PSA.100.3", label: "Psalm 100:3" },
  { usfm: "PSA.103.12", label: "Psalm 103:12" },
  { usfm: "PSA.119.105", label: "Psalm 119:105" },
  { usfm: "PSA.121.1", label: "Psalm 121:1" },
  { usfm: "PSA.139.14", label: "Psalm 139:14" },
  { usfm: "PSA.145.18", label: "Psalm 145:18" },
  { usfm: "PRO.3.5", label: "Proverbs 3:5" },
  { usfm: "PRO.3.6", label: "Proverbs 3:6" },
  { usfm: "PRO.16.9", label: "Proverbs 16:9" },
  { usfm: "PRO.22.6", label: "Proverbs 22:6" },
  { usfm: "PRO.31.30", label: "Proverbs 31:30" },
  { usfm: "ECC.3.1", label: "Ecclesiastes 3:1" },
  { usfm: "SNG.8.7", label: "Song of Songs 8:7" },
  { usfm: "ISA.9.6", label: "Isaiah 9:6" },
  { usfm: "ISA.40.31", label: "Isaiah 40:31" },
  { usfm: "ISA.41.10", label: "Isaiah 41:10" },
  { usfm: "ISA.53.5", label: "Isaiah 53:5" },
  { usfm: "ISA.55.8", label: "Isaiah 55:8" },
  { usfm: "JER.29.11", label: "Jeremiah 29:11" },
  { usfm: "JER.31.3", label: "Jeremiah 31:3" },
  { usfm: "LAM.3.22", label: "Lamentations 3:22" },
  { usfm: "EZK.36.26", label: "Ezekiel 36:26" },
  { usfm: "DAN.3.17", label: "Daniel 3:17" },
  { usfm: "HOS.6.6", label: "Hosea 6:6" },
  { usfm: "JOL.2.25", label: "Joel 2:25" },
  { usfm: "AMO.5.24", label: "Amos 5:24" },
  { usfm: "MIC.6.8", label: "Micah 6:8" },
  { usfm: "NAM.1.7", label: "Nahum 1:7" },
  { usfm: "HAB.3.19", label: "Habakkuk 3:19" },
  { usfm: "ZEP.3.17", label: "Zephaniah 3:17" },
  { usfm: "HAG.2.9", label: "Haggai 2:9" },
  { usfm: "ZEC.4.6", label: "Zechariah 4:6" },
  { usfm: "MAL.3.6", label: "Malachi 3:6" },
  { usfm: "MAT.5.3", label: "Matthew 5:3" },
  { usfm: "MAT.5.16", label: "Matthew 5:16" },
  { usfm: "MAT.6.26", label: "Matthew 6:26" },
  { usfm: "MAT.6.33", label: "Matthew 6:33" },
  { usfm: "MAT.11.28", label: "Matthew 11:28" },
  { usfm: "MAT.28.19", label: "Matthew 28:19" },
  { usfm: "MRK.10.45", label: "Mark 10:45" },
  { usfm: "MRK.12.30", label: "Mark 12:30" },
  { usfm: "LUK.2.10", label: "Luke 2:10" },
  { usfm: "LUK.6.31", label: "Luke 6:31" },
  { usfm: "LUK.15.20", label: "Luke 15:20" },
  { usfm: "JHN.1.1", label: "John 1:1" },
  { usfm: "JHN.3.16", label: "John 3:16" },
  { usfm: "JHN.8.32", label: "John 8:32" },
  { usfm: "JHN.10.10", label: "John 10:10" },
  { usfm: "JHN.13.34", label: "John 13:34" },
  { usfm: "JHN.14.6", label: "John 14:6" },
  { usfm: "JHN.15.5", label: "John 15:5" },
  { usfm: "ACT.1.8", label: "Acts 1:8" },
  { usfm: "ACT.17.28", label: "Acts 17:28" },
  { usfm: "ROM.3.23", label: "Romans 3:23" },
  { usfm: "ROM.5.8", label: "Romans 5:8" },
  { usfm: "ROM.8.1", label: "Romans 8:1" },
  { usfm: "ROM.8.28", label: "Romans 8:28" },
  { usfm: "ROM.8.38", label: "Romans 8:38" },
  { usfm: "ROM.12.2", label: "Romans 12:2" },
  { usfm: "1CO.10.13", label: "1 Corinthians 10:13" },
  { usfm: "1CO.13.4", label: "1 Corinthians 13:4" },
  { usfm: "1CO.13.13", label: "1 Corinthians 13:13" },
  { usfm: "1CO.15.55", label: "1 Corinthians 15:55" },
  { usfm: "2CO.4.16", label: "2 Corinthians 4:16" },
  { usfm: "2CO.5.17", label: "2 Corinthians 5:17" },
  { usfm: "2CO.12.9", label: "2 Corinthians 12:9" },
  { usfm: "GAL.2.20", label: "Galatians 2:20" },
  { usfm: "GAL.5.22", label: "Galatians 5:22" },
  { usfm: "GAL.6.9", label: "Galatians 6:9" },
  { usfm: "EPH.2.8", label: "Ephesians 2:8" },
  { usfm: "EPH.2.10", label: "Ephesians 2:10" },
  { usfm: "EPH.4.32", label: "Ephesians 4:32" },
  { usfm: "EPH.6.10", label: "Ephesians 6:10" },
  { usfm: "PHP.1.6", label: "Philippians 1:6" },
  { usfm: "PHP.4.6", label: "Philippians 4:6" },
  { usfm: "PHP.4.13", label: "Philippians 4:13" },
  { usfm: "COL.3.23", label: "Colossians 3:23" },
  { usfm: "1TH.5.16", label: "1 Thessalonians 5:16" },
  { usfm: "1TH.5.18", label: "1 Thessalonians 5:18" },
  { usfm: "2TI.1.7", label: "2 Timothy 1:7" },
  { usfm: "2TI.3.16", label: "2 Timothy 3:16" },
  { usfm: "HEB.4.12", label: "Hebrews 4:12" },
  { usfm: "HEB.11.1", label: "Hebrews 11:1" },
  { usfm: "HEB.12.1", label: "Hebrews 12:1" },
  { usfm: "HEB.13.8", label: "Hebrews 13:8" },
  { usfm: "JAS.1.5", label: "James 1:5" },
  { usfm: "JAS.1.17", label: "James 1:17" },
  { usfm: "JAS.4.7", label: "James 4:7" },
  { usfm: "1PE.5.7", label: "1 Peter 5:7" },
  { usfm: "2PE.3.9", label: "2 Peter 3:9" },
  { usfm: "1JN.1.9", label: "1 John 1:9" },
  { usfm: "1JN.4.8", label: "1 John 4:8" },
  { usfm: "1JN.4.18", label: "1 John 4:18" },
  { usfm: "JUD.1.24", label: "Jude 1:24" },
  { usfm: "REV.3.20", label: "Revelation 3:20" },
  { usfm: "REV.21.4", label: "Revelation 21:4" },
];

// Day-of-year in UTC, so the passage flips at the same instant worldwide
// rather than depending on server-local time (which shouldn't matter on a
// UTC-configured host like Render anyway, but this makes it correct
// regardless of that).
function dayOfYearUTC(date) {
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 0);
  const startOfDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.floor((startOfDay - startOfYear) / 86400000);
}

/**
 * Returns { usfm, label } for the given date (defaults to now) — the same
 * passage for every caller on the same UTC calendar day, cycling through
 * DAILY_PASSAGES in order and wrapping around once the list is exhausted.
 */
export function getDailyPassage(date = new Date()) {
  const index = dayOfYearUTC(date) % DAILY_PASSAGES.length;
  return DAILY_PASSAGES[index];
}
