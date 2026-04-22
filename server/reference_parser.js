// KAIRO — Bible Reference Parser
// Extracted from KAIRO v1 main.js. Handles spoken reference parsing with
// Deepgram STT healing, fuzzy book matching, and verse range detection.
'use strict';

const WORD_TO_NUM = {
  'zero':0,'one':1,'two':2,'three':3,'four':4,'five':5,
  'six':6,'seven':7,'eight':8,'nine':9,'ten':10,
  'eleven':11,'twelve':12,'thirteen':13,'fourteen':14,'fifteen':15,
  'sixteen':16,'seventeen':17,'eighteen':18,'nineteen':19,'twenty':20,
  'twenty-one':21,'twenty-two':22,'twenty-three':23,'twenty-four':24,
  'twenty-five':25,'twenty-six':26,'twenty-seven':27,'twenty-eight':28,
  'twenty-nine':29,'thirty':30,'thirty-one':31,'thirty-two':32,
  'thirty-three':33,'thirty-four':34,'thirty-five':35,'thirty-six':36,
  'thirty-seven':37,'thirty-eight':38,'thirty-nine':39,'forty':40,
  'forty-one':41,'forty-two':42,'forty-three':43,'forty-four':44,
  'forty-five':45,'forty-six':46,'forty-seven':47,'forty-eight':48,
  'forty-nine':49,'fifty':50,'fifty-one':51,'fifty-two':52,'fifty-three':53,
  'fifty-four':54,'fifty-five':55,'fifty-six':56,'fifty-seven':57,
  'fifty-eight':58,'fifty-nine':59,'sixty':60,'sixty-one':61,'sixty-two':62,
  'sixty-three':63,'sixty-four':64,'sixty-five':65,'sixty-six':66,
  'sixty-seven':67,'sixty-eight':68,'sixty-nine':69,'seventy':70,
  'seventy-one':71,'seventy-two':72,'seventy-three':73,'seventy-four':74,
  'seventy-five':75,'seventy-six':76,'seventy-seven':77,'seventy-eight':78,
  'seventy-nine':79,'eighty':80,'eighty-one':81,'eighty-two':82,
  'eighty-three':83,'eighty-four':84,'eighty-five':85,'eighty-six':86,
  'eighty-seven':87,'eighty-eight':88,'eighty-nine':89,'ninety':90,
  'ninety-one':91,'ninety-two':92,'ninety-three':93,'ninety-four':94,
  'ninety-five':95,'ninety-six':96,'ninety-seven':97,'ninety-eight':98,
  'ninety-nine':99,'hundred':100,'one hundred':100,
  'first':1,'second':2,'third':3,'fourth':4,'fifth':5,
  // Deepgram STT artifacts — common mishearings for number words in biblical context
  'for':4,   // "four" → "for"  (e.g. "john for verse one")
  'won':1,   // "one"  → "won"  (e.g. "chapter won verse five")
  'too':2,   // "two"  → "too"  (e.g. "verse too")
  'ate':8,   // "eight"→ "ate"  (e.g. "verse ate")
};

function spokenToNumber(word) {
  if (!word) return null;
  const w = word.toLowerCase().trim();
  if (/^\d+$/.test(w)) return parseInt(w);
  if (WORD_TO_NUM[w] !== undefined) return WORD_TO_NUM[w];
  const parts = w.split(/\s+/);
  if (parts.length === 2) {
    const a = WORD_TO_NUM[parts[0]], b = WORD_TO_NUM[parts[1]];
    if (a !== undefined && b !== undefined) {
      if (a >= 20 && b >= 1 && b <= 19) return a + b;
      if (a >= 1 && a <= 9 && b >= 10 && b <= 99) return a * 100 + b;
    }
  }
  if (parts.length === 3) {
    const a = WORD_TO_NUM[parts[0]], b = WORD_TO_NUM[parts[1]], c = WORD_TO_NUM[parts[2]];
    if (a !== undefined && b !== undefined && c !== undefined &&
        a >= 0 && a <= 9 && b >= 0 && b <= 9 && c >= 0 && c <= 9) {
      return a * 100 + b * 10 + c;
    }
  }
  return null;
}

function consumeNumber(words, idx, maxValue = Infinity) {
  if (idx >= words.length) return null;
  if (idx + 2 < words.length) { const n = spokenToNumber(words.slice(idx,idx+3).join(' ')); if (n !== null && n <= maxValue) return { value: n, consumed: 3 }; }
  if (idx + 1 < words.length) { const n = spokenToNumber(words.slice(idx,idx+2).join(' ')); if (n !== null && n <= maxValue) return { value: n, consumed: 2 }; }
  const n = spokenToNumber(words[idx]);
  if (n !== null) return { value: n, consumed: 1 };
  return null;
}

const BOOK_ALIASES = {
  'genesis':'Genesis','gen':'Genesis','exodus':'Exodus','leviticus':'Leviticus',
  'numbers':'Numbers','deuteronomy':'Deuteronomy','joshua':'Joshua','judges':'Judges','ruth':'Ruth',
  '1 samuel':'1 Samuel','first samuel':'1 Samuel','2 samuel':'2 Samuel','second samuel':'2 Samuel',
  '1 kings':'1 Kings','first kings':'1 Kings','2 kings':'2 Kings','second kings':'2 Kings',
  '1 chronicles':'1 Chronicles','first chronicles':'1 Chronicles',
  '2 chronicles':'2 Chronicles','second chronicles':'2 Chronicles',
  'ezra':'Ezra','nehemiah':'Nehemiah','esther':'Esther','job':'Job',
  'psalms':'Psalms','psalm':'Psalms','ps':'Psalms','psa':'Psalms','pss':'Psalms','psal':'Psalms','sal':'Psalms',
  'proverbs':'Proverbs','prov':'Proverbs','pro':'Proverbs','prv':'Proverbs',
  'ecclesiastes':'Ecclesiastes','eccl':'Ecclesiastes','ecc':'Ecclesiastes','qoh':'Ecclesiastes',
  'song of songs':'Song of Songs','song of solomon':'Song of Songs','sos':'Song of Songs','ss':'Song of Songs','cant':'Song of Songs',
  'isaiah':'Isaiah','isa':'Isaiah',
  'jeremiah':'Jeremiah','jer':'Jeremiah',
  'lamentations':'Lamentations','lam':'Lamentations',
  'ezekiel':'Ezekiel','ezek':'Ezekiel','eze':'Ezekiel',
  'daniel':'Daniel','dan':'Daniel',
  'hosea':'Hosea','hos':'Hosea',
  'joel':'Joel','amos':'Amos',
  'obadiah':'Obadiah','obad':'Obadiah','oba':'Obadiah',
  'jonah':'Jonah','jon':'Jonah',
  'micah':'Micah','mic':'Micah',
  'nahum':'Nahum','nah':'Nahum',
  'habakkuk':'Habakkuk','hab':'Habakkuk',
  'zephaniah':'Zephaniah','zeph':'Zephaniah','zep':'Zephaniah',
  'haggai':'Haggai','hag':'Haggai',
  'zechariah':'Zechariah','zachariah':'Zechariah','zacharias':'Zechariah','zech':'Zechariah','zec':'Zechariah',
  'malachi':'Malachi','mal':'Malachi',
  'matthew':'Matthew','matt':'Matthew','mt':'Matthew',
  'mark':'Mark','mk':'Mark','mrk':'Mark',
  'luke':'Luke','lk':'Luke','luk':'Luke',
  'john':'John','jn':'John','joh':'John',
  'acts':'Acts',
  'romans':'Romans','rom':'Romans',
  '1 corinthians':'1 Corinthians','first corinthians':'1 Corinthians','1 cor':'1 Corinthians','1cor':'1 Corinthians',
  '2 corinthians':'2 Corinthians','second corinthians':'2 Corinthians','2 cor':'2 Corinthians','2cor':'2 Corinthians',
  'galatians':'Galatians','gal':'Galatians',
  'ephesians':'Ephesians','eph':'Ephesians',
  'philippians':'Philippians','phil':'Philippians','php':'Philippians',
  'colossians':'Colossians','col':'Colossians',
  '1 thessalonians':'1 Thessalonians','first thessalonians':'1 Thessalonians','1 thess':'1 Thessalonians','1thess':'1 Thessalonians','1 th':'1 Thessalonians',
  '2 thessalonians':'2 Thessalonians','second thessalonians':'2 Thessalonians','2 thess':'2 Thessalonians','2thess':'2 Thessalonians','2 th':'2 Thessalonians',
  '1 timothy':'1 Timothy','first timothy':'1 Timothy','1 tim':'1 Timothy','1tim':'1 Timothy',
  '2 timothy':'2 Timothy','second timothy':'2 Timothy','2 tim':'2 Timothy','2tim':'2 Timothy',
  'titus':'Titus','tit':'Titus',
  'philemon':'Philemon','phlm':'Philemon','phm':'Philemon',
  'hebrews':'Hebrews','heb':'Hebrews',
  'james':'James','jas':'James','jam':'James',
  '1 peter':'1 Peter','first peter':'1 Peter','1 pet':'1 Peter','1pet':'1 Peter','1 pe':'1 Peter',
  '2 peter':'2 Peter','second peter':'2 Peter','2 pet':'2 Peter','2pet':'2 Peter','2 pe':'2 Peter',
  '1 john':'1 John','first john':'1 John','1 jn':'1 John','1jn':'1 John','1 jo':'1 John',
  '2 john':'2 John','second john':'2 John','2 jn':'2 John','2jn':'2 John',
  '3 john':'3 John','third john':'3 John','3 jn':'3 John','3jn':'3 John',
  'jude':'Jude','jud':'Jude',
  'revelation':'Revelation','revelations':'Revelation','rev':'Revelation','re':'Revelation',
};

const SINGLE_WORD_BOOKS = new Set([
  // Full names
  'genesis','exodus','leviticus','numbers','deuteronomy','joshua','judges','ruth',
  'ezra','nehemiah','esther','job','psalms','psalm','proverbs','ecclesiastes',
  'isaiah','jeremiah','lamentations','ezekiel','daniel','hosea','joel','amos',
  'obadiah','jonah','micah','nahum','habakkuk','zephaniah','haggai',
  'zechariah','zachariah','zacharias','malachi',
  'matthew','mark','luke','john','acts','romans','galatians',
  'ephesians','philippians','colossians','titus','philemon','hebrews','james','jude',
  'revelation','revelations',
  // Common typed abbreviations (all lowercase — normalised before lookup)
  'gen','exod','exo','lev','num','deut','deu','josh','jos','judg','jdg',
  'ps','psa','pss','psal','sal',
  'prov','pro','prv',
  'eccl','ecc','qoh',
  'sos','ss','cant',
  'isa','jer','lam',
  'ezek','eze','dan','hos','obad','oba','jon','mic','nah','hab',
  'zeph','zep','zech','zec','hag','mal',
  'matthew','mark','luke','john','acts','romans',
  'galatians','ephesians','philippians','colossians',
  'titus','philemon','hebrews','james','jude','revelation','revelations',
  'matt','mt','mk','mrk','lk','luk','jn','joh',
  'rom','gal','eph','php','col','tit','phlm','phm','heb','jas','jam','jud',
  'rev','re',
]);

const NUMBERED_BOOK_VARIANTS = {
  'corinthians':['1 Corinthians','2 Corinthians'],
  'thessalonians':['1 Thessalonians','2 Thessalonians'],
  'timothy':['1 Timothy','2 Timothy'],
  'peter':['1 Peter','2 Peter'],
  'samuel':['1 Samuel','2 Samuel'],
  'kings':['1 Kings','2 Kings'],
  'chronicles':['1 Chronicles','2 Chronicles'],
};
for (const b of Object.keys(NUMBERED_BOOK_VARIANTS)) {
  SINGLE_WORD_BOOKS.add(b);
  if (!BOOK_ALIASES[b]) BOOK_ALIASES[b] = NUMBERED_BOOK_VARIANTS[b][0];
}

const AMBIGUOUS_BOOKS = new Set([
  'numbers','ruth','mark','john','james','acts','judges','job',
  'joel','amos','micah','nahum','titus','jude','luke','hebrews',
  'esther','hosea','jonah','genesis','exodus','philemon','obadiah','haggai',
]);

const MAX_CHAPTERS = {
  'Genesis':50,'Exodus':40,'Leviticus':27,'Numbers':36,'Deuteronomy':34,
  'Joshua':24,'Judges':21,'Ruth':4,'1 Samuel':31,'2 Samuel':24,
  '1 Kings':22,'2 Kings':25,'1 Chronicles':29,'2 Chronicles':36,
  'Ezra':10,'Nehemiah':13,'Esther':10,'Job':42,'Psalms':150,
  'Proverbs':31,'Ecclesiastes':12,'Song of Songs':8,
  'Isaiah':66,'Jeremiah':52,'Lamentations':5,'Ezekiel':48,'Daniel':12,
  'Hosea':14,'Joel':3,'Amos':9,'Obadiah':1,'Jonah':4,'Micah':7,
  'Nahum':3,'Habakkuk':3,'Zephaniah':3,'Haggai':2,'Zechariah':14,'Malachi':4,
  'Matthew':28,'Mark':16,'Luke':24,'John':21,'Acts':28,'Romans':16,
  '1 Corinthians':16,'2 Corinthians':13,'Galatians':6,'Ephesians':6,
  'Philippians':4,'Colossians':4,'1 Thessalonians':5,'2 Thessalonians':3,
  '1 Timothy':6,'2 Timothy':4,'Titus':3,'Philemon':1,'Hebrews':13,
  'James':5,'1 Peter':5,'2 Peter':3,'1 John':5,'2 John':1,'3 John':1,
  'Jude':1,'Revelation':22,
};

const PARSER_HEALING_PAIRS = [
  // Book name repairs
  ['acts of the apostles','acts'],['acts of the apostle','acts'],
  ['acts of apostles','acts'],['acts of apostle','acts'],['book of acts','acts'],
  ['zachariah','zechariah'],['zacharias','zechariah'],
  ['naha','nahum'],      // Deepgram mishear: "Nahum" → "naha"  (4-char, below fuzzy threshold)
  ['habakkak','habakkuk'],['habaka','habakkuk'],['habacuc','habakkuk'], // Habakkuk variants
  ['zephan','zephaniah'],['zephania','zephaniah'],
  ['hagga','haggai'],['hagai','haggai'],
  ['malach','malachi'],
  ['ecclesiast','ecclesiastes'],
  ['lamentations of jeremiah','lamentations'],
  ['philippine chapter','philippians chapter'],['philippine verse','philippians verse'],['philippine','philippians'],
  ['first corinthian','1 corinthians'],['second corinthian','2 corinthians'],
  ['galatian chapter','galatians chapter'],['galatian verse','galatians verse'],['galatian','galatians'],
  ['ephesian chapter','ephesians chapter'],['ephesian verse','ephesians verse'],['ephesian','ephesians'],
  ['colossian chapter','colossians chapter'],['colossian verse','colossians verse'],['colossian','colossians'],
  ['thessalonian','1 thessalonians'],
  ['profit chapter','proverbs chapter'],['profit verse','proverbs verse'],
  ['first chronic','1 chronicles'],['second chronic','2 chronicles'],
  ['song of solomon','song of solomon'],['song of songs','song of solomon'],
  // Deepgram number mishearing
  ['chapter won ','chapter one '],['verse fork','verse four'],['verse tree','verse three'],
  ['verse ate','verse eight'],['chapter ate','chapter eight'],['verse sick','verse six'],
  ['chapter for verse','chapter four verse'],['chapter for ','chapter four '],
  ['chapter covenant verse','chapter seven verse'],['chapter covenant verses','chapter seven verses'],
  ['chapter heaven verse','chapter seven verse'],['chapter heaven verses','chapter seven verses'],
  // Common Deepgram STT mis-transcriptions
  ['revelation chapter','revelation chapter'],
  ['book of john','john'],['book of mark','mark'],['book of luke','luke'],
  ['book of matthew','matthew'],['book of acts','acts'],
  ['book of genesis','genesis'],['book of exodus','exodus'],
  ['book of psalms','psalms'],['book of proverbs','proverbs'],
  ['book of isaiah','isaiah'],['book of jeremiah','jeremiah'],
  ['book of ezekiel','ezekiel'],['book of daniel','daniel'],
  ['first john','1 john'],['second john','2 john'],['third john','3 john'],
  ['first peter','1 peter'],['second peter','2 peter'],
  ['first kings','1 kings'],['second kings','2 kings'],
  ['first samuel','1 samuel'],['second samuel','2 samuel'],
  ['first timothy','1 timothy'],['second timothy','2 timothy'],
  ['first thessalonians','1 thessalonians'],['second thessalonians','2 thessalonians'],
  ['first corinthians','1 corinthians'],['second corinthians','2 corinthians'],
  ['first chronicles','1 chronicles'],['second chronicles','2 chronicles'],
];

const HEALING_COMPILED = PARSER_HEALING_PAIRS.map(([find, replace]) => {
  const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { find, replace, regex: new RegExp(escaped + '(?![a-z])', 'g') };
});

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  const curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i-1] === b[j-1] ? prev[j-1] : 1 + Math.min(prev[j], curr[j-1], prev[j-1]);
    }
    prev.splice(0, b.length + 1, ...curr);
  }
  return prev[b.length];
}

const levenshteinCache = new Map();
function cachedLevenshtein(a, b) {
  const key = a + '|' + b;
  if (levenshteinCache.has(key)) return levenshteinCache.get(key);
  const dist = levenshtein(a, b);
  if (levenshteinCache.size > 5000) levenshteinCache.clear();
  levenshteinCache.set(key, dist);
  return dist;
}

function cleanReferenceText(text) {
  return text
    .replace(/[.,!?;]/g, ' ')
    .replace(/\bcolon\b/gi, ':')
    .replace(/(\d)\s*:\s*(\d)/g, '$1 $2')
    .replace(/(\d)\s*-\s*(\d)/g, '$1 to $2')
    .replace(/([a-z])-([a-z])/gi, '$1 $2')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

const DIGIT_WORDS_RE = (function() {
  const DIGIT_WORDS = 'zero|one|two|three|four|five|six|seven|eight|nine';
  return new RegExp(`\\b(${DIGIT_WORDS})\\s+zero\\s+(${DIGIT_WORDS})\\b`, 'g');
})();

function getNumberedPrefix(word) {
  if (word === 'first' || word === '1' || word === '1st') return '1';
  if (word === 'second' || word === '2' || word === '2nd') return '2';
  if (word === 'third' || word === '3' || word === '3rd') return '3';
  return null;
}

function parseSpokenReference(text, inBibleMode = false) {
  let cleanText = cleanReferenceText(text);

  for (const { find, replace, regex } of HEALING_COMPILED) {
    if (!cleanText.includes(find)) continue;
    regex.lastIndex = 0;
    cleanText = cleanText.replace(regex, replace);
  }

  const words = cleanText.split(/\s+/);

  for (let i = 0; i < words.length; i++) {
    let bookName = null, consumed = 0;

    if (i + 1 < words.length) {
      const num = getNumberedPrefix(words[i]);
      if (num) {
        const key = `${num} ${words[i+1]}`;
        if (BOOK_ALIASES[key]) { bookName = BOOK_ALIASES[key]; consumed = 2; }
      }
    }
    if (!bookName && SINGLE_WORD_BOOKS.has(words[i])) { bookName = BOOK_ALIASES[words[i]]; consumed = 1; }

    if (!bookName && words[i].length >= 5) {
      const nextWord = words[i+1] || '';
      if (nextWord === 'chapter' || /^\d+$/.test(nextWord) || WORD_TO_NUM[nextWord] !== undefined) {
        const candidate = words[i];
        const maxDist = candidate.length >= 8 ? 2 : 1;
        let bestDist = Infinity, bestAlias = null;
        for (const alias of SINGLE_WORD_BOOKS) {
          if (Math.abs(alias.length - candidate.length) > maxDist) continue;
          const d = cachedLevenshtein(candidate, alias);
          if (d <= maxDist && d < bestDist) { bestDist = d; bestAlias = alias; }
        }
        if (bestAlias) { bookName = BOOK_ALIASES[bestAlias]; consumed = 1; }
      }
    }

    if (!bookName) continue;

    let idx = i + consumed;
    if (idx < words.length && words[idx] === 'chapter') idx++;

    const chRes = consumeNumber(words, idx, MAX_CHAPTERS[bookName] || Infinity);
    if (!chRes) continue;
    const chapter = chRes.value;
    idx += chRes.consumed;

    const maxCh = MAX_CHAPTERS[bookName];
    if (maxCh && chapter > maxCh) {
      let peekIdx = idx;
      if (peekIdx < words.length && ['verse','verses','vers'].includes(words[peekIdx])) peekIdx++;
      const peekVRes = consumeNumber(words, peekIdx);
      if (peekVRes && peekVRes.value <= maxCh) {
        return { book: bookName, chapter: peekVRes.value, verse: chapter };
      }
      continue;
    }

    if (idx < words.length && ['and','of','from'].includes(words[idx]) &&
        idx+1 < words.length && ['verse','verses','vers'].includes(words[idx+1])) idx++;

    let hasVerseKeyword = idx < words.length && ['verse','verses','vers',':'].includes(words[idx]);
    if (hasVerseKeyword) idx++;

    let vRes = consumeNumber(words, idx);
    let lookAheadRepositioned = false;

    if (vRes && !hasVerseKeyword) {
      let lookIdx = idx + vRes.consumed;
      while (lookIdx < words.length && ['and','of','from'].includes(words[lookIdx])) lookIdx++;
      if (lookIdx < words.length && ['verse','verses','vers'].includes(words[lookIdx])) {
        lookIdx++;
        const explicitVRes = consumeNumber(words, lookIdx);
        if (explicitVRes) {
          vRes = explicitVRes;
          idx = lookIdx + explicitVRes.consumed;
          hasVerseKeyword = true;
          lookAheadRepositioned = true;
        }
      }
    }

    if (!vRes) {
      const rawBookWord = words[i];
      const hadChapterKeyword = (i + consumed < words.length && words[i + consumed] === 'chapter');
      if (AMBIGUOUS_BOOKS.has(rawBookWord) && !hadChapterKeyword && !inBibleMode) continue;
      return { book: bookName, chapter, verse: null };
    }

    const verseStart = vRes.value;
    if (!lookAheadRepositioned) idx += vRes.consumed;

    const collectedRanges = [];
    if (idx < words.length && ['to','through','-'].includes(words[idx])) {
      idx++;
      if (idx < words.length && ['verse','verses'].includes(words[idx])) idx++;
      const vEndRes = consumeNumber(words, idx);
      if (vEndRes) { collectedRanges.push({ verseStart, verseEnd: vEndRes.value }); idx += vEndRes.consumed; }
      else collectedRanges.push({ verseStart, verseEnd: verseStart });
    } else {
      collectedRanges.push({ verseStart, verseEnd: verseStart });
    }

    let scanIdx = idx;
    while (scanIdx < words.length) {
      while (scanIdx < words.length && ['and',',','verse','verses'].includes(words[scanIdx])) scanIdx++;
      const nextStartRes = consumeNumber(words, scanIdx);
      if (!nextStartRes) break;
      scanIdx += nextStartRes.consumed;
      let nextEnd = nextStartRes.value;
      if (scanIdx < words.length && ['to','through'].includes(words[scanIdx])) {
        scanIdx++;
        if (scanIdx < words.length && ['verse','verses'].includes(words[scanIdx])) scanIdx++;
        const nextEndRes = consumeNumber(words, scanIdx);
        if (nextEndRes) { nextEnd = nextEndRes.value; scanIdx += nextEndRes.consumed; }
      }
      collectedRanges.push({ verseStart: nextStartRes.value, verseEnd: nextEnd });
    }

    // Merge duplicate: {A,A} immediately followed by {A,B} means the first was
    // just the verse-start spoken alone before the range — keep the wider range.
    if (collectedRanges.length === 2) {
      const [first, second] = collectedRanges;
      if (first.verseStart === first.verseEnd &&
          second.verseStart === first.verseStart &&
          second.verseEnd > second.verseStart) {
        collectedRanges.splice(0, 2, second);
      }
    }

    if (collectedRanges.length > 1) return { book: bookName, chapter, ranges: collectedRanges };
    const only = collectedRanges[0];
    if (only.verseEnd !== only.verseStart) return { book: bookName, chapter, verseStart: only.verseStart, verseEnd: only.verseEnd };
    return { book: bookName, chapter, verse: verseStart };
  }
  return null;
}

function parseAllSpokenReferences(text, inBibleMode = false) {
  let cleanText = cleanReferenceText(text);

  // Remove STT-artifact "zero" sandwiched between two single-digit number words.
  // e.g. "one one one one zero one to three" → "one one one one one to three"
  // This handles Deepgram inserting a spurious "zero" inside digit-by-digit numbers.
  DIGIT_WORDS_RE.lastIndex = 0;
  cleanText = cleanText.replace(DIGIT_WORDS_RE, '$1 $2');

  for (const { find, replace, regex } of HEALING_COMPILED) {
    if (!cleanText.includes(find)) continue;
    regex.lastIndex = 0;
    cleanText = cleanText.replace(regex, replace);
  }
  const words = cleanText.split(/\s+/);
  const refs = [];
  let i = 0;
  while (i < words.length) {
    let bookName = null, consumed = 0;
    if (i+1 < words.length) {
      const num = getNumberedPrefix(words[i]);
      if (num) {
        const key = `${num} ${words[i+1]}`;
        if (BOOK_ALIASES[key]) { bookName = BOOK_ALIASES[key]; consumed = 2; }
      }
    }
    if (!bookName && SINGLE_WORD_BOOKS.has(words[i])) { bookName = BOOK_ALIASES[words[i]]; consumed = 1; }
    if (!bookName) { i++; continue; }

    let nextBookIdx = words.length;
    for (let j = i+consumed; j < words.length; j++) {
      if (SINGLE_WORD_BOOKS.has(words[j]) && j > i+consumed) { nextBookIdx = j; break; }
      const jNum = getNumberedPrefix(words[j]);
      if (jNum && j+1 < words.length && BOOK_ALIASES[`${jNum} ${words[j+1]}`]) { nextBookIdx = j; break; }
    }

    const subText = words.slice(i, nextBookIdx).join(' ');
    const ref = parseSpokenReference(subText, inBibleMode);
    if (ref) {
      const bareWord = words[i];
      const hadPrefix = consumed > 1;
      const variants = NUMBERED_BOOK_VARIANTS[bareWord];
      if (variants && !hadPrefix) {
        for (const v of variants) refs.push({ ...ref, book: v });
      } else {
        refs.push(ref);
      }
      i = nextBookIdx;
    } else {
      i++;
    }
  }
  return refs;
}

// ── Bare book detection ───────────────────────────────────────────────────
// Scans text for bare book mentions (e.g. "Exodus" on its own, or "1 John"
// with no chapter/verse). Used to hold book context across a monologue
// between the book callout and the actual "chapter X verse Y".
//
// Rules for accepting a bare book:
//   1. Numbered books ("1 John", "first corinthians") → always accept.
//   2. Unambiguous single-word books (Leviticus, Deuteronomy, …) → accept.
//   3. Ambiguous books (exodus, genesis, john, mark, …) → only when a
//      "bible trigger phrase" precedes them (book of, turn to, read from, …)
//      OR when we're already in bible mode.
//
// The trigger-phrase pass runs against the RAW (pre-healing) text because
// the healing collapses "book of exodus" → "exodus" and would erase the
// trigger. We scan triggers first, then run the healed pass for the rest.
const BIBLE_TRIGGER_PHRASES = [
  'book of', 'turn to', 'turn with me to', 'open to', 'open your bible to',
  'read from', 'read in', 'read out of', 'scripture in', 'found in',
  'writings of', 'gospel of', 'gospel according to', 'epistle of',
  'letter of', 'letter to', 'prophet',
];

function detectBookMentions(text, inBibleMode = false) {
  const lowered = text.toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
  const books = [];
  const seen  = new Set();

  // Pass 1 — trigger-phrase pass on RAW text. Accepts AMBIGUOUS books too.
  for (const trigger of BIBLE_TRIGGER_PHRASES) {
    let idx = 0;
    while ((idx = lowered.indexOf(trigger, idx)) !== -1) {
      const after = lowered.slice(idx + trigger.length).trimStart();
      const afterWords = after.split(/\s+/, 3); // peek up to 3 tokens
      // Numbered: "first john", "1 peter"
      const num = getNumberedPrefix(afterWords[0]);
      if (num && afterWords[1]) {
        const key = `${num} ${afterWords[1]}`;
        if (BOOK_ALIASES[key] && !seen.has(BOOK_ALIASES[key])) {
          books.push(BOOK_ALIASES[key]);
          seen.add(BOOK_ALIASES[key]);
        }
      } else if (afterWords[0] && SINGLE_WORD_BOOKS.has(afterWords[0])) {
        const resolved = BOOK_ALIASES[afterWords[0]];
        if (resolved && !seen.has(resolved)) { books.push(resolved); seen.add(resolved); }
      }
      idx += trigger.length;
    }
  }

  // Pass 2 — healed pass. Accepts unambiguous books, or ambiguous when in bible mode.
  let cleanText = cleanReferenceText(text);
  for (const { find, replace, regex } of HEALING_COMPILED) {
    if (!cleanText.includes(find)) continue;
    regex.lastIndex = 0;
    cleanText = cleanText.replace(regex, replace);
  }
  const words = cleanText.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    if (i + 1 < words.length) {
      const num = getNumberedPrefix(words[i]);
      if (num) {
        const key = `${num} ${words[i + 1]}`;
        if (BOOK_ALIASES[key] && !seen.has(BOOK_ALIASES[key])) {
          books.push(BOOK_ALIASES[key]);
          seen.add(BOOK_ALIASES[key]);
          i++;
          continue;
        }
      }
    }
    const w = words[i];
    if (SINGLE_WORD_BOOKS.has(w)) {
      if (!inBibleMode && AMBIGUOUS_BOOKS.has(w)) continue;
      const resolved = BOOK_ALIASES[w];
      if (resolved && !seen.has(resolved)) { books.push(resolved); seen.add(resolved); }
    }
  }
  return books;
}

// ── Reference Context ─────────────────────────────────────────────────────
// Tracks the last cited book/chapter so bare verse references like
// "verse 17" or "and verse 18 says" can be resolved in context.
// Context expires after 180 seconds of no explicit citation — long enough
// to bridge a monologue between a bare book mention ("Exodus") and the
// eventual chapter/verse call ("chapter 3 verse 13").

const CONTEXT_EXPIRE_MS = 180000;

class ReferenceContext {
  constructor() {
    this._book      = null;
    this._chapter   = null;
    this._updatedAt = 0;
  }

  // Update with a fully resolved reference.
  // - If `chapter` is provided, store it.
  // - If `chapter` is null/undefined: preserve the current chapter ONLY when
  //   the book hasn't changed. Switching books without a chapter clears the
  //   stale chapter so a later bare "verse 13" can't resolve against the
  //   previous book's chapter number.
  update(book, chapter) {
    if (!book) return;
    const bookChanged = this._book !== book;
    this._book      = book;
    if (chapter) this._chapter = chapter;
    else if (bookChanged) this._chapter = null;
    this._updatedAt = Date.now();
  }

  // Check if context is still valid.
  get isValid() {
    return !!this._book && (Date.now() - this._updatedAt) < CONTEXT_EXPIRE_MS;
  }

  get book()    { return this.isValid ? this._book    : null; }
  get chapter() { return this.isValid ? this._chapter : null; }

  reset() {
    this._book = null; this._chapter = null; this._updatedAt = 0;
  }
}

// Singleton shared across the process (imported by server.js).
const referenceContext = new ReferenceContext();

// ── Bare verse resolver ───────────────────────────────────────────────────
// Detects spoken patterns like "verse 17", "verses 3 through 5",
// "and verse eighteen" and resolves them against the current context.
// Returns null if no context or no bare verse pattern found.

const BARE_VERSE_PATTERNS = [
  // "verse 17" / "verses 3 to 5" / "verse three"
  /\b(?:and\s+)?(?:verse|verses|vers)\s+(\w+)(?:\s+(?:to|through|-)\s+(\w+))?/i,
  // "chapter 3 verse 17" with no book — only if we have a book in context
  /\bchapter\s+(\w+)\s+(?:verse|verses|vers)\s+(\w+)/i,
];

function resolvePartialReference(text) {
  if (!referenceContext.isValid) return null;

  const clean = text.toLowerCase().replace(/[.,!?;]/g, ' ').replace(/\s+/g, ' ').trim();

  // Pattern 1 (MORE SPECIFIC, try first): "chapter N verse M" with no book.
  // Resolves when the preacher said a bare book ("Exodus") earlier, then
  // followed up later with "chapter 3 verse 13".
  const chapVerseMatch = clean.match(/\bchapter\s+(\w+)\s+(?:verse|verses|vers)\s+(\w+)/i);
  if (chapVerseMatch) {
    const chapter = spokenToNumber(chapVerseMatch[1]);
    const verse   = spokenToNumber(chapVerseMatch[2]);
    if (chapter && verse && referenceContext.book) {
      const maxCh = MAX_CHAPTERS[referenceContext.book];
      if (!maxCh || chapter <= maxCh) {
        return { book: referenceContext.book, chapter, verse, partial: true };
      }
    }
  }

  // Pattern 2: bare "verse N" or "verses N to M" — needs a chapter in context.
  const bareMatch = clean.match(/\b(?:and\s+)?(?:verse|verses|vers)\s+(\w[\w\s]*?)(?:\s+(?:to|through)\s+(\w+))?(?:\s|$)/i);
  if (bareMatch) {
    const verseStart = spokenToNumber(bareMatch[1].trim());
    if (verseStart && verseStart >= 1 && verseStart <= 176) {
      const book    = referenceContext.book;
      const chapter = referenceContext.chapter;
      if (!chapter) return null;
      if (bareMatch[2]) {
        const verseEnd = spokenToNumber(bareMatch[2].trim());
        if (verseEnd && verseEnd >= verseStart) {
          return { book, chapter, verseStart, verseEnd, partial: true };
        }
      }
      return { book, chapter, verse: verseStart, partial: true };
    }
  }

  return null;
}

module.exports = {
  parseSpokenReference,
  parseAllSpokenReferences,
  resolvePartialReference,
  detectBookMentions,
  referenceContext,
  BOOK_ALIASES,
  SINGLE_WORD_BOOKS,
  AMBIGUOUS_BOOKS,
  NUMBERED_BOOK_VARIANTS,
  WORD_TO_NUM,
};
