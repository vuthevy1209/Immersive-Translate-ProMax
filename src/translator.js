// Translation engines. Each takes a list of sentences, every sentence given as its chunks, and resolves to
// [{ text, pieces }] in the same order: the translated sentence plus where each chunk landed in it.
// Loaded with importScripts() by the service worker, and directly by test/demo.html.
var IPMTranslator = (() => {
  const MAX_CONCURRENT = 3
  let active = 0
  const waiting = []

  async function limited(fn) {
    if (active >= MAX_CONCURRENT) await new Promise(resolve => waiting.push(resolve))
    active++
    try {
      return await fn()
    } finally {
      active--
      waiting.shift()?.()
    }
  }

  const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // "<a i=0>Faced with X,</a> <a i=1>Ngo Dinh Diem,</a> ...": translating this as HTML, Google keeps each tag
  // around the part of its (whole-sentence) translation that matches the chunk.
  function buildMarked(chunks) {
    return chunks.map((chunk, i) => `<a i=${i}>${escapeHtml(chunk)}</a>`).join(' ')
  }

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

  function decodeEntities(s) {
    return s.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, code) => {
      if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? match
      const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return point <= 0x10ffff ? String.fromCodePoint(point) : match
    })
  }

  // Turns the tagged translation back into plain text and the [start, end) span of each chunk.
  // Tolerates reordered, nested, repeated or missing tags; anything else that looks like a tag is dropped.
  function parseMarked(html) {
    let text = ''
    const raw = []
    const open = []
    const emit = part => {
      const s = decodeEntities(part).replace(/​/g, '')
      if (!s) return
      const chunk = open[open.length - 1]
      if (chunk !== undefined) raw.push({ start: text.length, end: text.length + s.length, chunk })
      text += s
    }
    let last = 0
    for (const m of html.matchAll(/<a\s+i\s*=\s*"?(\d+)"?\s*>|<\/a\s*>|<[^<>]*>/gi)) {
      emit(html.slice(last, m.index))
      last = m.index + m[0].length
      if (m[1] !== undefined) open.push(Number(m[1]))
      else if (/^<\/a/i.test(m[0])) open.pop()
    }
    emit(html.slice(last))

    const lead = text.length - text.trimStart().length
    text = text.trim()
    const pieces = []
    for (const p of raw) {
      let start = Math.max(0, p.start - lead)
      let end = Math.min(text.length, p.end - lead)
      while (start < end && /\s/.test(text[start])) start++
      while (end > start && /\s/.test(text[end - 1])) end--
      if (end <= start) continue
      const prev = pieces[pieces.length - 1]
      if (prev && prev.chunk === p.chunk && /^\s*$/.test(text.slice(prev.end, start))) prev.end = end
      else pieces.push({ start, end, chunk: p.chunk })
    }
    return { text, pieces }
  }

  // The free endpoint Google's own widgets use. One POST carries many sentences and returns them aligned.
  async function google(items, { from = 'auto', to }) {
    const url = `https://translate.googleapis.com/translate_a/t?client=gtx&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&format=html`
    const body = new URLSearchParams()
    for (const chunks of items) body.append('q', buildMarked(chunks))
    let res = await fetch(url, { method: 'POST', body })
    if (res.status === 429) {
      await new Promise(resolve => setTimeout(resolve, 1500))
      res = await fetch(url, { method: 'POST', body })
    }
    if (!res.ok) throw new Error(`Google Translate trả về HTTP ${res.status}`)
    const data = await res.json()
    // sl=auto answers [[translation, detectedLang], ...]; a fixed sl answers [translation, ...].
    const out = data.map(item => parseMarked(Array.isArray(item) ? item[0] : item))
    if (out.length !== items.length) throw new Error(`Google Translate trả về ${out.length}/${items.length} câu`)
    return out
  }

  const engines = { google }

  function translate(items, { engine = 'google', from, to }) {
    return limited(() => engines[engine](items, { from, to }))
  }

  // Shapes Google's dictionary answer (dj=1) for the selection popup. Single words also get meanings by part of
  // speech and an English definition; longer text only has the translation.
  function parseLookup(data) {
    const sentences = data.sentences ?? []
    return {
      translation: sentences.map(s => s.trans ?? '').join('').trim(),
      phonetic: sentences.find(s => s.src_translit)?.src_translit ?? '',
      source: data.src ?? '',
      meanings: (data.dict ?? []).map(d => ({ pos: d.pos, terms: (d.terms ?? []).slice(0, 6) })).filter(m => m.terms.length),
      definitions: (data.definitions ?? [])
        .map(d => ({ pos: d.pos, gloss: d.entry?.[0]?.gloss ?? '', example: d.entry?.[0]?.example ?? '' }))
        .filter(d => d.gloss)
        .slice(0, 3),
    }
  }

  function lookup(text, { to }) {
    return limited(async () => {
      const params = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: to, hl: to, dj: '1' })
      for (const dt of ['t', 'bd', 'rm', 'md', 'ex']) params.append('dt', dt)
      const res = await fetch(`https://translate.googleapis.com/translate_a/single?${params}`, {
        method: 'POST',
        body: new URLSearchParams({ q: text }),
      })
      if (!res.ok) throw new Error(`Google Translate trả về HTTP ${res.status}`)
      return parseLookup(await res.json())
    })
  }

  return { translate, lookup, buildMarked, parseMarked, parseLookup }
})()
