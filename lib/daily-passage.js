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
//
// `tag`: a short one-line reason to open it today, shown on the homepage
// right under the reference itself (see server.js's GET /api/daily and
// public/app.js's loadDailyPassage()) — meant to work as a hook, not a
// summary of the verse's meaning (that's what asking about it is for).
export const DAILY_PASSAGES = [
  { usfm: "GEN.1.1", label: "Genesis 1:1", tag: "Where the whole story begins." },
  { usfm: "GEN.1.27", label: "Genesis 1:27", tag: "What it means to be made in God's image." },
  { usfm: "GEN.3.15", label: "Genesis 3:15", tag: "The first promise of a rescue, right after the first fall." },
  { usfm: "GEN.12.2", label: "Genesis 12:2", tag: "A promise to one man that reshapes the rest of the Bible." },
  { usfm: "GEN.15.6", label: "Genesis 15:6", tag: "Faith counted as righteousness — centuries before Paul explains why." },
  { usfm: "GEN.50.20", label: "Genesis 50:20", tag: "What Joseph says to the brothers who sold him into slavery." },
  { usfm: "EXO.3.14", label: "Exodus 3:14", tag: "God gives Moses a name that's really an answer." },
  { usfm: "EXO.20.3", label: "Exodus 20:3", tag: "The first of the Ten Commandments, and why it comes first." },
  { usfm: "DEU.6.4", label: "Deuteronomy 6:4", tag: "The Shema — the core confession of Israel's faith." },
  { usfm: "DEU.6.5", label: "Deuteronomy 6:5", tag: "Love God with all your heart, soul, and strength — what that actually asks." },
  { usfm: "DEU.31.6", label: "Deuteronomy 31:6", tag: "Moses' charge to Israel before Joshua leads them in." },
  { usfm: "JOS.1.9", label: "Joshua 1:9", tag: "Be strong and courageous — spoken right as the real work begins." },
  { usfm: "RUT.1.16", label: "Ruth 1:16", tag: "A foreigner's vow of loyalty that becomes part of the Messiah's lineage." },
  { usfm: "1SA.16.7", label: "1 Samuel 16:7", tag: "Man looks at the outside; God looks at the heart." },
  { usfm: "2SA.7.16", label: "2 Samuel 7:16", tag: "God's covenant to establish David's throne forever." },
  { usfm: "JOB.19.25", label: "Job 19:25", tag: "Job's declaration of hope from the middle of unexplained suffering." },
  { usfm: "JOB.42.2", label: "Job 42:2", tag: "What Job finally says after God answers him out of the storm." },
  { usfm: "PSA.1.1", label: "Psalm 1:1", tag: "The two ways to live, laid out before the Psalter even begins." },
  { usfm: "PSA.19.1", label: "Psalm 19:1", tag: "What creation itself is declaring, without saying a word." },
  { usfm: "PSA.23.1", label: "Psalm 23:1", tag: "The Lord is my shepherd — maybe the most-loved line in the Psalms." },
  { usfm: "PSA.27.1", label: "Psalm 27:1", tag: "David's confidence in the face of real fear." },
  { usfm: "PSA.34.8", label: "Psalm 34:8", tag: "Taste and see that the Lord is good." },
  { usfm: "PSA.46.1", label: "Psalm 46:1", tag: "A very present help in trouble — the psalm behind 'A Mighty Fortress'." },
  { usfm: "PSA.51.10", label: "Psalm 51:10", tag: "David's prayer for a clean heart, written after his worst failure." },
  { usfm: "PSA.90.12", label: "Psalm 90:12", tag: "Teach us to number our days — Moses' prayer for wisdom." },
  { usfm: "PSA.100.3", label: "Psalm 100:3", tag: "Know that the Lord, he is God — a short psalm worth slowing down for." },
  { usfm: "PSA.103.12", label: "Psalm 103:12", tag: "As far as the east is from the west — what that distance actually means." },
  { usfm: "PSA.119.105", label: "Psalm 119:105", tag: "A lamp to my feet — from the longest chapter in the Bible." },
  { usfm: "PSA.121.1", label: "Psalm 121:1", tag: "I lift up my eyes to the hills — where does help actually come from?" },
  { usfm: "PSA.139.14", label: "Psalm 139:14", tag: "Fearfully and wonderfully made." },
  { usfm: "PSA.145.18", label: "Psalm 145:18", tag: "The Lord is near to all who call on him in truth." },
  { usfm: "PRO.3.5", label: "Proverbs 3:5", tag: "Trust in the Lord with all your heart." },
  { usfm: "PRO.3.6", label: "Proverbs 3:6", tag: "In all your ways acknowledge him — the promise that follows verse 5." },
  { usfm: "PRO.16.9", label: "Proverbs 16:9", tag: "We plan our way, but the Lord establishes our steps." },
  { usfm: "PRO.22.6", label: "Proverbs 22:6", tag: "Train up a child — a proverb, not an ironclad promise. Worth studying the difference." },
  { usfm: "PRO.31.30", label: "Proverbs 31:30", tag: "Charm is deceitful — the closing word on the woman who fears the Lord." },
  { usfm: "ECC.3.1", label: "Ecclesiastes 3:1", tag: "A time for everything — the Preacher's honest look at life under the sun." },
  { usfm: "SNG.8.7", label: "Song of Songs 8:7", tag: "Many waters cannot quench love." },
  { usfm: "ISA.9.6", label: "Isaiah 9:6", tag: "Unto us a child is born — a promise written centuries before Bethlehem." },
  { usfm: "ISA.40.31", label: "Isaiah 40:31", tag: "Those who wait on the Lord shall renew their strength." },
  { usfm: "ISA.41.10", label: "Isaiah 41:10", tag: "Fear not, for I am with you." },
  { usfm: "ISA.53.5", label: "Isaiah 53:5", tag: "The suffering servant, and who Isaiah is actually describing." },
  { usfm: "ISA.55.8", label: "Isaiah 55:8", tag: "My thoughts are not your thoughts — a word for whatever feels unresolved." },
  { usfm: "JER.29.11", label: "Jeremiah 29:11", tag: "Plans to prosper you — a promise usually quoted without its original context." },
  { usfm: "JER.31.3", label: "Jeremiah 31:3", tag: "I have loved you with an everlasting love." },
  { usfm: "LAM.3.22", label: "Lamentations 3:22", tag: "His mercies are new every morning — hope written from inside real grief." },
  { usfm: "EZK.36.26", label: "Ezekiel 36:26", tag: "A new heart and a new spirit — God's promise of inward change." },
  { usfm: "DAN.3.17", label: "Daniel 3:17", tag: "But if not — three men's answer right before the furnace." },
  { usfm: "HOS.6.6", label: "Hosea 6:6", tag: "I desire mercy, not sacrifice — a line Jesus later quotes twice." },
  { usfm: "JOL.2.25", label: "Joel 2:25", tag: "I will restore the years the locust has eaten." },
  { usfm: "AMO.5.24", label: "Amos 5:24", tag: "Let justice roll down like waters." },
  { usfm: "MIC.6.8", label: "Micah 6:8", tag: "What does the Lord require of you — as plain a summary as Scripture gives." },
  { usfm: "NAM.1.7", label: "Nahum 1:7", tag: "The Lord is good, a stronghold in the day of trouble." },
  { usfm: "HAB.3.19", label: "Habakkuk 3:19", tag: "Joy in the middle of a book that opens with a complaint to God." },
  { usfm: "ZEP.3.17", label: "Zephaniah 3:17", tag: "The Lord will rejoice over you with singing." },
  { usfm: "HAG.2.9", label: "Haggai 2:9", tag: "The latter glory of this house shall be greater than the former." },
  { usfm: "ZEC.4.6", label: "Zechariah 4:6", tag: "Not by might, nor by power, but by my Spirit." },
  { usfm: "MAL.3.6", label: "Malachi 3:6", tag: "I the Lord do not change — the last word of the Old Testament era." },
  { usfm: "MAT.5.3", label: "Matthew 5:3", tag: "Blessed are the poor in spirit — the first line of the Beatitudes." },
  { usfm: "MAT.5.16", label: "Matthew 5:16", tag: "Let your light shine — what Jesus expects it to be seen doing." },
  { usfm: "MAT.6.26", label: "Matthew 6:26", tag: "Look at the birds of the air — Jesus' case against anxiety." },
  { usfm: "MAT.6.33", label: "Matthew 6:33", tag: "Seek first the kingdom of God." },
  { usfm: "MAT.11.28", label: "Matthew 11:28", tag: "Come to me, all who labor and are heavy laden." },
  { usfm: "MAT.28.19", label: "Matthew 28:19", tag: "The Great Commission — Jesus' last instruction before ascending." },
  { usfm: "MRK.10.45", label: "Mark 10:45", tag: "The Son of Man came not to be served but to serve." },
  { usfm: "MRK.12.30", label: "Mark 12:30", tag: "The greatest commandment, as Jesus states it himself." },
  { usfm: "LUK.2.10", label: "Luke 2:10", tag: "Fear not, for behold, I bring you good tidings of great joy." },
  { usfm: "LUK.6.31", label: "Luke 6:31", tag: "The Golden Rule, in Jesus' own words." },
  { usfm: "LUK.15.20", label: "Luke 15:20", tag: "The father runs — the moment the prodigal son turns for home." },
  { usfm: "JHN.1.1", label: "John 1:1", tag: "In the beginning was the Word — John's opening claim about who Jesus is." },
  { usfm: "JHN.3.16", label: "John 3:16", tag: "For God so loved the world — maybe the most familiar verse in Scripture, worth a fresh look." },
  { usfm: "JHN.8.32", label: "John 8:32", tag: "You will know the truth, and the truth will set you free." },
  { usfm: "JHN.10.10", label: "John 10:10", tag: "I came that they may have life, and have it abundantly." },
  { usfm: "JHN.13.34", label: "John 13:34", tag: "A new commandment — love one another as I have loved you." },
  { usfm: "JHN.14.6", label: "John 14:6", tag: "I am the way, the truth, and the life." },
  { usfm: "JHN.15.5", label: "John 15:5", tag: "I am the vine, you are the branches." },
  { usfm: "ACT.1.8", label: "Acts 1:8", tag: "Jesus' last words before the ascension, and the mission that follows." },
  { usfm: "ACT.17.28", label: "Acts 17:28", tag: "In him we live and move and have our being — Paul quoting Greek poets in Athens." },
  { usfm: "ROM.3.23", label: "Romans 3:23", tag: "All have sinned and fall short of the glory of God." },
  { usfm: "ROM.5.8", label: "Romans 5:8", tag: "God shows his love in that while we were still sinners, Christ died for us." },
  { usfm: "ROM.8.1", label: "Romans 8:1", tag: "No condemnation for those in Christ Jesus." },
  { usfm: "ROM.8.28", label: "Romans 8:28", tag: "All things work together for good — what that promise actually covers." },
  { usfm: "ROM.8.38", label: "Romans 8:38", tag: "Nothing can separate us from the love of God." },
  { usfm: "ROM.12.2", label: "Romans 12:2", tag: "Do not be conformed to this world, but be transformed." },
  { usfm: "1CO.10.13", label: "1 Corinthians 10:13", tag: "God is faithful and will provide a way through temptation." },
  { usfm: "1CO.13.4", label: "1 Corinthians 13:4", tag: "Love is patient, love is kind — a definition worth sitting with." },
  { usfm: "1CO.13.13", label: "1 Corinthians 13:13", tag: "Faith, hope, and love remain — and the greatest of these is love." },
  { usfm: "1CO.15.55", label: "1 Corinthians 15:55", tag: "O death, where is your victory? Paul's answer to the last enemy." },
  { usfm: "2CO.4.16", label: "2 Corinthians 4:16", tag: "Though our outer self is wasting away, our inner self is renewed." },
  { usfm: "2CO.5.17", label: "2 Corinthians 5:17", tag: "If anyone is in Christ, he is a new creation." },
  { usfm: "2CO.12.9", label: "2 Corinthians 12:9", tag: "My grace is sufficient for you — spoken to Paul about his own weakness." },
  { usfm: "GAL.2.20", label: "Galatians 2:20", tag: "I have been crucified with Christ — Paul's language for a changed identity." },
  { usfm: "GAL.5.22", label: "Galatians 5:22", tag: "The fruit of the Spirit — what actually grows from a life shaped by God." },
  { usfm: "GAL.6.9", label: "Galatians 6:9", tag: "Let us not grow weary of doing good." },
  { usfm: "EPH.2.8", label: "Ephesians 2:8", tag: "By grace you have been saved through faith." },
  { usfm: "EPH.2.10", label: "Ephesians 2:10", tag: "We are his workmanship, created for good works prepared in advance." },
  { usfm: "EPH.4.32", label: "Ephesians 4:32", tag: "Be kind to one another, forgiving each other." },
  { usfm: "EPH.6.10", label: "Ephesians 6:10", tag: "Be strong in the Lord — the opening line before the armor of God." },
  { usfm: "PHP.1.6", label: "Philippians 1:6", tag: "He who began a good work in you will bring it to completion." },
  { usfm: "PHP.4.6", label: "Philippians 4:6", tag: "Do not be anxious about anything — Paul's actual instructions, not just the feeling." },
  { usfm: "PHP.4.13", label: "Philippians 4:13", tag: "I can do all things through him — a verse often lifted from its own context." },
  { usfm: "COL.3.23", label: "Colossians 3:23", tag: "Whatever you do, work heartily, as for the Lord." },
  { usfm: "1TH.5.16", label: "1 Thessalonians 5:16", tag: "Rejoice always — one line from a short run of blunt instructions." },
  { usfm: "1TH.5.18", label: "1 Thessalonians 5:18", tag: "Give thanks in all circumstances — not for all circumstances." },
  { usfm: "2TI.1.7", label: "2 Timothy 1:7", tag: "God gave us a spirit not of fear but of power, love, and self-control." },
  { usfm: "2TI.3.16", label: "2 Timothy 3:16", tag: "All Scripture is breathed out by God — Paul's own claim about the Bible." },
  { usfm: "HEB.4.12", label: "Hebrews 4:12", tag: "The word of God is living and active, sharper than any two-edged sword." },
  { usfm: "HEB.11.1", label: "Hebrews 11:1", tag: "Faith is the assurance of things hoped for — the definition that opens the 'hall of faith'." },
  { usfm: "HEB.12.1", label: "Hebrews 12:1", tag: "Run with endurance the race set before us." },
  { usfm: "HEB.13.8", label: "Hebrews 13:8", tag: "Jesus Christ is the same yesterday, today, and forever." },
  { usfm: "JAS.1.5", label: "James 1:5", tag: "If any of you lacks wisdom, let him ask God." },
  { usfm: "JAS.1.17", label: "James 1:17", tag: "Every good gift is from above, from the Father of lights." },
  { usfm: "JAS.4.7", label: "James 4:7", tag: "Resist the devil, and he will flee from you." },
  { usfm: "1PE.5.7", label: "1 Peter 5:7", tag: "Cast all your anxieties on him, because he cares for you." },
  { usfm: "2PE.3.9", label: "2 Peter 3:9", tag: "The Lord is not slow to fulfill his promise — Peter on why he waits." },
  { usfm: "1JN.1.9", label: "1 John 1:9", tag: "If we confess our sins, he is faithful and just to forgive." },
  { usfm: "1JN.4.8", label: "1 John 4:8", tag: "God is love — one of the most quoted, least simple claims in the Bible." },
  { usfm: "1JN.4.18", label: "1 John 4:18", tag: "Perfect love casts out fear." },
  { usfm: "JUD.1.24", label: "Jude 1:24", tag: "Now to him who is able to keep you from stumbling — a doxology worth reading slowly." },
  { usfm: "REV.3.20", label: "Revelation 3:20", tag: "Behold, I stand at the door and knock." },
  { usfm: "REV.21.4", label: "Revelation 21:4", tag: "He will wipe away every tear — Scripture's closing picture of what's coming." },
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
 * Returns { usfm, label, tag } for the given date (defaults to now) — the
 * same passage for every caller on the same UTC calendar day, cycling
 * through DAILY_PASSAGES in order and wrapping around once the list is
 * exhausted.
 */
export function getDailyPassage(date = new Date()) {
  const index = dayOfYearUTC(date) % DAILY_PASSAGES.length;
  return DAILY_PASSAGES[index];
}
