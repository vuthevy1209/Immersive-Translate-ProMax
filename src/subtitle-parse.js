// Caption files -> timed lines -> sentences, and a sentence's translation -> one part per line.
// Pure functions with no DOM access, so test/subtitles.test.mjs can run them in Node.
//
// A cue is { start, end, text } in milliseconds. Lines that belong to one sentence are translated together, each line
// sent as one chunk (see translator.js), so Google sees the whole sentence but tells us which part of its translation
// goes under which line.
var IPMSubs = (() => {
  const TERMINAL = /[.?!…♪。？！]["'”’)\]]*$/
  const PAUSE_MS = 1200 // a longer gap between two lines or two spoken words ends the sentence
  const MAX_LINES = 4 // lines per sentence, for captions that never use punctuation
  const MAX_CHARS = 300
  const ASR_LINE_WORDS = 12 // auto-generated captions come word by word; we cut them into lines of about this size
  const ASR_SENTENCE_WORDS = 36
  const ASR_LINGER_MS = 1500 // how long a line stays after its last word when nobody speaks next

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

  function decodeEntities(s) {
    return s.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, code) => {
      if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? match
      const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return point <= 0x10ffff ? String.fromCodePoint(point) : match
    })
  }

  // Drops markup such as <i>, <c.yellow> or <00:01.000>, then decodes entities and folds lines into one.
  const clean = s => decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()

  // The same caption read from the page and from the file differs in line breaks and spacing only.
  const keyOf = s => s.replace(/\s+/g, '').toLowerCase()

  // "01:02:03.456", "02:03.456" or "02:03,4" -> milliseconds.
  function vttTime(s) {
    const m = s.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/)
    if (!m) return NaN
    return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4].padEnd(3, '0'))
  }

  function parseVtt(text) {
    const cues = []
    for (const block of text.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
      const lines = block.split('\n')
      const at = lines.findIndex(line => line.includes('-->'))
      if (at < 0) continue // header, NOTE or STYLE block
      const [from, to] = lines[at].split('-->')
      const cue = { start: vttTime(from), end: vttTime(to), text: clean(lines.slice(at + 1).join('\n')) }
      if (Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.text) cues.push(cue)
    }
    return cues
  }

  // YouTube's json3. Captions written by people come as one event per line. Auto-generated ones (kind=asr) come as
  // events holding a word each, with its own time, so we build lines and sentences from the words ourselves.
  function parseJson3(data, asrHint) {
    const events = (data.events ?? []).filter(e => e.segs?.length && Number.isFinite(e.tStartMs))
    const asr = asrHint || events.some(e => e.segs.some(s => 'acAsrConf' in s))
    if (!asr) {
      return events
        .map(e => ({ start: e.tStartMs, end: e.tStartMs + (e.dDurationMs ?? 0), text: clean(e.segs.map(s => s.utf8 ?? '').join('')) }))
        .filter(c => c.text)
    }
    const words = []
    for (const e of events) {
      if (e.aAppend) continue // the line breaks of the rolling display
      e.segs.forEach((s, i) => {
        if (!s.utf8?.trim()) return
        // Later words carry their own leading space; the first word of an event does not, but still starts a word.
        const text = (i === 0 ? ' ' : '') + s.utf8.replace(/\s+/g, ' ')
        words.push({ t: e.tStartMs + (s.tOffsetMs ?? 0), text })
      })
    }
    words.sort((a, b) => a.t - b.t)
    return asrLines(words)
  }

  // Words -> sentences (punctuation, a pause, or a length cap) -> lines of even size. Each line shows from its first
  // word until the next line starts.
  function asrLines(words) {
    const cues = []
    let sentence = []
    const close = () => {
      const count = Math.ceil(sentence.length / ASR_LINE_WORDS)
      const size = Math.ceil(sentence.length / count)
      for (let i = 0; i < sentence.length; i += size) {
        const part = sentence.slice(i, i + size)
        cues.push({
          start: part[0].t,
          end: part[part.length - 1].t,
          text: part.map(w => w.text).join('').replace(/\s+/g, ' ').trim(),
          sentenceEnd: i + size >= sentence.length,
        })
      }
      sentence = []
    }
    words.forEach((word, i) => {
      sentence.push(word)
      const next = words[i + 1]
      if (!next || TERMINAL.test(word.text.trim()) || next.t - word.t > PAUSE_MS || sentence.length >= ASR_SENTENCE_WORDS) close()
    })
    cues.forEach((cue, i) => {
      const next = cues[i + 1]?.start ?? Infinity
      cue.end = Math.min(next, Math.max(cue.end + ASR_LINGER_MS, cue.start + 1000))
    })
    return cues.filter(c => c.text)
  }

  const attr = (attrs, name) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]

  // YouTube's older XML formats: srv3 (<p t="ms" d="ms">) and srv1 (<text start="s" dur="s">, escaped twice).
  function parseXml(xml) {
    const cues = []
    for (const [, attrs, body] of xml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
      const start = Number(attr(attrs, 't'))
      cues.push({ start, end: start + Number(attr(attrs, 'd') ?? 0), text: clean(body) })
    }
    if (!cues.length) {
      for (const [, attrs, body] of xml.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
        const start = Number(attr(attrs, 'start')) * 1000
        cues.push({ start, end: start + Number(attr(attrs, 'dur') ?? 0) * 1000, text: clean(decodeEntities(body)) })
      }
    }
    return cues.filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.text)
  }

  // Returns the cues sorted by start time, or null for anything that is not a caption track (Udemy's player also
  // fetches a .vtt of thumbnail sprites for the seek bar).
  function parseTrack(url, body) {
    const text = body.trimStart()
    let cues
    if (text.startsWith('WEBVTT')) cues = parseVtt(text)
    else if (text.startsWith('{')) cues = parseJson3(JSON.parse(text), /[?&]kind=asr\b/.test(url))
    else if (text.startsWith('<')) cues = parseXml(text)
    else return null
    const images = cues.filter(c => /#xywh=|\.(?:jpe?g|png|webp|gif)\b/i.test(c.text)).length
    if (!cues.length || images > cues.length / 2) return null
    return cues.sort((a, b) => a.start - b.start)
  }

  // Groups consecutive cues into sentences; returns arrays of cue indexes.
  function groupSentences(cues) {
    const groups = []
    let group = []
    let chars = 0
    cues.forEach((cue, i) => {
      group.push(i)
      chars += cue.text.length
      const next = cues[i + 1]
      const ends = 'sentenceEnd' in cue ? cue.sentenceEnd : TERMINAL.test(cue.text)
      if (!next || ends || next.start - cue.end > PAUSE_MS || group.length >= MAX_LINES || chars >= MAX_CHARS) {
        groups.push(group)
        group = []
        chars = 0
      }
    })
    return groups
  }

  // Splits a sentence's translation ({ text, pieces } from translator.js) into one part per line. Text that Google
  // left outside every tag goes with the piece before it. Returns null when some line got nothing, in which case the
  // caller shows the whole sentence under each line instead.
  function distribute({ text, pieces }, lineCount) {
    if (lineCount === 1) return [text]
    const sorted = pieces.filter(p => p.chunk < lineCount).sort((a, b) => a.start - b.start)
    if (!sorted.length) return null
    const parts = Array(lineCount).fill('')
    sorted.forEach((piece, i) => {
      const from = i === 0 ? 0 : piece.start
      const to = i + 1 < sorted.length ? sorted[i + 1].start : text.length
      parts[piece.chunk] += ` ${text.slice(from, to)}`
    })
    const out = parts.map(p => p.replace(/\s+/g, ' ').trim())
    return out.every(Boolean) ? out : null
  }

  return { parseTrack, parseVtt, parseJson3, parseXml, groupSentences, distribute, keyOf }
})()
