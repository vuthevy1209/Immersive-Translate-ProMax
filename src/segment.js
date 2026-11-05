// Sentence splitting and "worth translating?" checks.
// Pure functions with no DOM access, so test/segment.test.mjs can run them in Node.
var IPMSegment = (() => {
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' })

  // Titles and labels that are always followed by more of the same sentence ("Mr. Petrov", "No. 5").
  const ALWAYS_JOIN = /(?:^|[\s("'[])(?:Mr|Mrs|Ms|Mx|Dr|Prof|Messrs|Mme|Capt|Lt|Col|Sgt|Rev|Hon|Gen|Gov|Sen|Rep|No|Nos|Vol|Fig|Figs|ext|approx|pp|vs|cf|e\.g|i\.e)\.$/
  // Abbreviations that can also end a sentence ("Main St." / "St. Louis"): join unless the next piece
  // opens like a new sentence.
  const MAYBE_JOIN = /(?:^|[\s("'[])(?:St|Mt|Ft|Ave|Blvd|Rd|Ste|Dept|Univ|Inc|Ltd|Co|Corp|Jr|Sr|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.$/
  // Initials and initialisms: "J. K. Rowling", "the U.S. Army".
  const INITIAL = /(?:^|[\s.("'])\p{Lu}\.$/u
  const SENTENCE_STARTERS = new Set(('The A An This That These Those It Its He She They We I You Our Their His Her My Your ' +
    'In On At For But And Or However Also If When As After Before There Here Please Then So Each All Some Many Most ' +
    'What Why How Who Where Which To With By From Since While Although Because Thus Therefore Moreover Furthermore ' +
    'Meanwhile Finally First Second Next Last One Yes Thank Thanks Dear Note According During Despite Once Now Today').split(' '))

  const VIETNAMESE_ONLY = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉĩịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i

  function firstWord(text) {
    return text.match(/^["'“‘(]*([\p{L}']+)/u)?.[1] ?? ''
  }

  function shouldJoin(prev, next) {
    if (!/\p{L}/u.test(prev)) return true // a bare label such as "154."
    if (/^\p{Ll}/u.test(next)) return true // `"Is it done?" she asked.`
    if (ALWAYS_JOIN.test(prev)) return true
    if (MAYBE_JOIN.test(prev) || INITIAL.test(prev)) return !SENTENCE_STARTERS.has(firstWord(next))
    return false
  }

  // Returns [{ start, end, text }] with `end` exclusive and surrounding whitespace trimmed.
  function splitSentences(text) {
    const sentences = []
    for (const { segment, index } of segmenter.segment(text)) {
      let start = index
      let end = index + segment.length
      while (start < end && /\s/.test(text[start])) start++
      while (end > start && /\s/.test(text[end - 1])) end--
      if (end === start) continue
      const prev = sentences[sentences.length - 1]
      if (prev && shouldJoin(text.slice(prev.start, prev.end), text.slice(start, end))) prev.end = end
      else sentences.push({ start, end })
    }
    return sentences.map(({ start, end }) => ({ start, end, text: text.slice(start, end) }))
  }

  // Cuts a sentence after each comma or semicolon followed by a space; the punctuation stays with the left part.
  // Commas inside numbers ("$2,500", no space) and inside parentheses are left alone.
  function splitChunks(sentence) {
    const cuts = [0]
    let depth = 0
    for (let i = 0; i < sentence.length; i++) {
      const ch = sentence[i]
      if (ch === '(' || ch === '[') depth++
      else if ((ch === ')' || ch === ']') && depth > 0) depth--
      else if ((ch === ',' || ch === ';') && depth === 0) {
        let end = i + 1
        while (/["'”’]/.test(sentence[end] ?? '')) end++ // `"Yes," he said`
        if (/\s/.test(sentence[end] ?? '')) cuts.push(end)
      }
    }
    cuts.push(sentence.length)
    const chunks = []
    for (let k = 0; k < cuts.length - 1; k++) {
      let start = cuts[k]
      let end = cuts[k + 1]
      while (start < end && /\s/.test(sentence[start])) start++
      while (end > start && /\s/.test(sentence[end - 1])) end--
      if (end > start) chunks.push({ start, end, text: sentence.slice(start, end) })
    }
    return chunks
  }

  function looksTranslatable(text, targetLang) {
    const letters = text.match(/\p{L}/gu)
    if (!letters || letters.length < 2) return false
    if (letters.length / text.replace(/\s/g, '').length < 0.35) return false // mostly numbers or symbols
    if (/^(https?:\/\/\S+|[\w.+-]+@[\w-]+\.[\w.]+)$/.test(text.trim())) return false
    if (targetLang === 'vi') {
      const viLetters = letters.filter(ch => VIETNAMESE_ONLY.test(ch)).length
      if (viLetters / letters.length > 0.04) return false // already Vietnamese
    }
    return true
  }

  return { splitSentences, splitChunks, looksTranslatable }
})()
