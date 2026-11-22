// Puts a translation directly under every sentence on the page.
//
// A "container" is a block-level element that owns some inline text (a <p>, <li>, <td>, a <div> holding text...).
// Its inline content is split into "runs" at <br> and block children, each run into sentences, and after the
// last character of each sentence we insert an <ipm-translation> element styled as a block.
// Sentences are also cut into comma chunks; hovering a chunk lights it up together with its part of the translation.
(() => {
  if (window.__ipmLoaded) return
  window.__ipmLoaded = true

  // After the extension is reloaded, tabs that were already open keep running the old copy of this script, cut off
  // from the extension. The new copy announces itself with this DOM event and the old one steps aside.
  const TAKEOVER = 'ipm:takeover'
  const alive = () => Boolean(chrome.runtime?.id)

  const { splitSentences, splitChunks, looksTranslatable } = IPMSegment
  const TAG = 'ipm-translation'
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'pre', 'textarea', 'input', 'select', 'option',
    'button', 'svg', 'math', 'canvas', 'iframe', 'video', 'audio', 'object', 'embed', 'rt', 'rp', 'head'])
  const BATCH_CHARS = 3000
  const BATCH_ITEMS = 40

  let enabled = false
  let settings = { targetLang: 'vi', autoSites: [], clickHighlight: true, selectLookup: true }
  let state = new WeakMap() // container -> { status: queued | loading | done | error, sig, count, splits, chunks }
  const touched = new Set() // containers we inserted into, so we can undo
  let io = null
  const mo = new MutationObserver(onMutations)
  const dirtyRoots = new Set()
  const dirtyTargets = new Set()
  let dirtyTimer = null

  // ---------- reading the DOM ----------

  // Video captions on YouTube and Udemy belong to src/subtitles.js.
  const CAPTIONS = '.ytp-caption-window-container, [data-purpose="captions-cue-text"], [class*="captions-display"], ' +
    '[data-purpose="media-player-container"] [class*="caption"]'

  function isSkipped(el) {
    return SKIP_TAGS.has(el.localName) || el.localName.startsWith('ipm-') || el.isContentEditable ||
      el.hasAttribute('data-immersive-translate-translation-element-mark') || el.matches(CAPTIONS)
  }

  function isInsideSkipped(el) {
    for (let a = el; a; a = a.parentElement) if (isSkipped(a)) return true
    return false
  }

  function displayKind(el) {
    const display = getComputedStyle(el).display
    if (display === 'none') return 'none'
    return display.startsWith('inline') || display.startsWith('ruby') || display === 'contents' ? 'inline' : 'block'
  }

  // Visits the inline content that belongs to `container` itself; block children are containers of their own.
  function walkOwn(container, onText, onBreak, onOurs) {
    const visit = node => {
      if (node.nodeType === Node.TEXT_NODE) return onText(node)
      if (node.nodeType !== Node.ELEMENT_NODE) return
      if (node.localName === TAG) return onOurs?.(node)
      if (node.localName === 'br') return onBreak()
      if (isSkipped(node)) return
      const kind = displayKind(node)
      if (kind === 'none') return
      if (kind === 'block') return onBreak()
      for (let c = node.firstChild; c; c = c.nextSibling) visit(c)
    }
    for (let c = container.firstChild; c; c = c.nextSibling) visit(c)
  }

  function ownRuns(container) {
    const runs = [[]]
    walkOwn(container, t => runs[runs.length - 1].push(t), () => runs[runs.length - 1].length && runs.push([]))
    return runs.filter(r => r.length)
  }

  function hasOwnText(container) {
    let found = false
    walkOwn(container, t => { found ||= /\S/.test(t.data) }, () => {})
    return found
  }

  function countOurs(container) {
    let count = 0
    walkOwn(container, () => {}, () => {}, () => count++)
    return count
  }

  // Collapses whitespace the way the browser renders it, remembering which DOM position each character came from.
  function buildIndex(nodes) {
    let text = ''
    const map = []
    let space = true
    for (const node of nodes) {
      const data = node.data
      for (let i = 0; i < data.length; i++) {
        const isSpace = /\s/.test(data[i])
        if (isSpace && space) continue
        text += isSpace ? ' ' : data[i]
        map.push([node, i])
        space = isSpace
      }
    }
    if (space && text) {
      text = text.slice(0, -1)
      map.pop()
    }
    return { text, map }
  }

  function analyze(container) {
    const units = []
    for (const nodes of ownRuns(container)) {
      const { text, map } = buildIndex(nodes)
      if (!looksTranslatable(text, settings.targetLang)) continue
      const sentences = splitSentences(text)
        .filter(s => looksTranslatable(s.text, settings.targetLang))
        .map(s => ({ ...s, chunks: splitChunks(s.text) }))
      if (sentences.length) units.push({ map, sentences })
    }
    const sentences = units.flatMap(u => u.sentences)
    return { units, sentences, sig: sentences.map(s => s.text).join('\u0001') }
  }

  // A live Range over text[from, to) of a run; it keeps following the text when we split text nodes later.
  function rangeOf(map, from, to) {
    const range = document.createRange()
    const [startNode, startOffset] = map[from]
    const [endNode, endOffset] = map[to - 1]
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset + 1)
    return range
  }

  function onDarkBackground(el) {
    const [r, g, b] = (getComputedStyle(el).color.match(/[\d.]+/g) ?? []).map(Number)
    return 0.299 * r + 0.587 * g + 0.114 * b > 160 // light text means a dark page
  }

  // ---------- writing to the DOM ----------

  // Runs our own DOM changes without our MutationObserver reacting to them.
  function mutate(fn) {
    fn()
    mo.takeRecords()
  }

  function isLastMeaningful(node) {
    for (let n = node.nextSibling; n; n = n.nextSibling) {
      if (n.nodeType === Node.TEXT_NODE ? /\S/.test(n.data) : n.nodeType === Node.ELEMENT_NODE && n.localName !== TAG) return false
    }
    return true
  }

  // Inserts `el` right after the character at [node, offset], stepping out of inline wrappers (<a>, <b>...) when
  // the sentence ends at their end, so the translation is not part of the link or the bold text.
  function insertAfterChar([node, offset], el, container, splits) {
    if (offset + 1 < node.data.length) splits.push([node, node.splitText(offset + 1)])
    let ref = node
    while (ref.parentNode !== container && isLastMeaningful(ref)) ref = ref.parentNode
    ref.parentNode.insertBefore(el, ref.nextSibling)
  }

  // Builds the translation with each chunk's part wrapped in <ipm-chunk data-i="k">.
  function createTranslation({ text, pieces }, dark) {
    const el = document.createElement(TAG)
    el.setAttribute('translate', 'no')
    el.className = 'notranslate'
    el.lang = settings.targetLang
    if (dark) el.setAttribute('data-dark', '')
    let pos = 0
    for (const piece of pieces) {
      if (piece.start > pos) el.append(text.slice(pos, piece.start))
      const span = document.createElement('ipm-chunk')
      span.dataset.i = piece.chunk
      span.textContent = text.slice(piece.start, piece.end)
      el.append(span)
      pos = piece.end
    }
    if (pos < text.length) el.append(text.slice(pos))
    return el
  }

  // Pairs each chunk's range in the page with its <ipm-chunk> parts in the translation.
  function linkChunks(ranges, translationEl) {
    const dark = translationEl.hasAttribute('data-dark')
    const chunks = ranges.map(range => ({ range, els: [], dark }))
    for (const span of translationEl.querySelectorAll('ipm-chunk')) {
      const chunk = chunks[span.dataset.i]
      if (!chunk) continue
      chunk.els.push(span)
      chunkOfEl.set(span, chunk)
    }
    return chunks
  }

  // Removes our translations from a container and glues back the text nodes we split.
  function removeOwn(container) {
    const st = state.get(container)
    if (st?.chunks.includes(lit)) light(null)
    const ours = []
    walkOwn(container, () => {}, () => {}, n => ours.push(n))
    mutate(() => {
      ours.forEach(n => n.remove())
      for (const [node, rest] of (st?.splits ?? []).reverse()) {
        if (rest.parentNode && node.nextSibling === rest) {
          node.appendData(rest.data)
          rest.remove()
        }
      }
    })
    if (st) {
      st.splits = []
      st.chunks = []
    }
    touched.delete(container)
  }

  const sameText = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase()

  async function translateContainer(el) {
    const st = state.get(el)
    if (!st || st.status !== 'queued') return
    const before = analyze(el)
    if (!before.sentences.length) return Object.assign(st, { status: 'done', sig: before.sig, count: 0 })

    st.status = 'loading'
    let translations
    try {
      translations = await translateSentences(before.sentences)
    } catch (err) {
      st.status = 'error'
      return toast(errorMessage(err))
    }
    if (!enabled || state.get(el) !== st) return

    // The page may have changed while we waited; if so, start over when it is visible again.
    const now = analyze(el)
    if (now.sig !== before.sig) {
      st.status = 'queued'
      return io.observe(el)
    }
    const dark = onDarkBackground(el)
    const splits = []
    const chunks = []
    let count = 0
    let k = 0
    mutate(() => {
      for (const { map, sentences } of now.units) {
        const start = k
        k += sentences.length
        const ranges = sentences.map(s => s.chunks.map(c => rangeOf(map, s.start + c.start, s.start + c.end)))
        // Last sentence first: splitting a text node keeps earlier offsets valid.
        for (let i = sentences.length - 1; i >= 0; i--) {
          const translation = translations[start + i]
          if (!translation?.text || sameText(translation.text, sentences[i].text)) continue
          const translationEl = createTranslation(translation, dark)
          insertAfterChar(map[sentences[i].end - 1], translationEl, el, splits)
          chunks.push(...linkChunks(ranges[i], translationEl))
          count++
        }
      }
    })
    Object.assign(st, { status: 'done', sig: now.sig, count, splits, chunks })
    if (count) touched.add(el)
  }

  // ---------- click a chunk: light it up together with its part of the translation ----------

  const chunkOfEl = new WeakMap() // <ipm-chunk> -> chunk
  let lit = null // { range, els, dark }

  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y)
      return pos && { node: pos.offsetNode, offset: pos.offset }
    }
    const range = document.caretRangeFromPoint?.(x, y)
    return range && { node: range.startContainer, offset: range.startOffset }
  }

  function containsPoint(range, x, y) {
    for (const r of range.getClientRects()) if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true
    return false
  }

  function chunkAt({ target, clientX: x, clientY: y }) {
    const span = target.closest?.('ipm-chunk')
    if (span) return chunkOfEl.get(span) ?? null
    const caret = caretAt(x, y)
    if (caret?.node.nodeType !== Node.TEXT_NODE) return null
    for (let el = caret.node.parentElement; el; el = el.parentElement) {
      const chunks = state.get(el)?.chunks
      if (!chunks?.length) continue
      // The caret snaps to the nearest letter even past the end of a line, so also check the point itself.
      return chunks.find(c => c.range.isPointInRange(caret.node, caret.offset) && containsPoint(c.range, x, y)) ?? null
    }
    return null
  }

  function light(chunk) {
    if (chunk === lit) return
    lit?.els.forEach(e => e.removeAttribute('data-active'))
    lit = chunk
    chunk?.els.forEach(e => e.setAttribute('data-active', ''))
    // The page side uses the CSS Custom Highlight API, so the page's own DOM is never touched.
    if (typeof Highlight !== 'function') return
    CSS.highlights.delete('ipm-hover')
    CSS.highlights.delete('ipm-hover-dark')
    if (chunk) CSS.highlights.set(chunk.dark ? 'ipm-hover-dark' : 'ipm-hover', new Highlight(chunk.range))
  }

  // A click on a chunk lights it (and its translation); a click anywhere else turns the highlight off.
  function onChunkClick(e) {
    if (!settings.clickHighlight || e.button !== 0 || insidePopup(e) || insideBot(e)) return
    if (!getSelection().isCollapsed) return // the click ended a drag that selected text, which is for the lookup
    light(chunkAt(e))
  }

  // ---------- select text: dictionary popup (works whether or not the page is translated) ----------

  // Claude-style palette shared by the popup and the floating bot.
  const THEME_CSS = `
    :host {
      all: initial;
      --bg: #faf9f5; --surface: #ffffff; --text: #141413; --muted: #73726c; --border: #e8e6dc;
      --accent: #d97757; --accent-strong: #c6613f; --accent-soft: rgb(217 119 87 / 0.12); --error: #b53a2a;
      --serif: ui-serif, "Tiempos Text", Georgia, "Times New Roman", serif;
      --sans: system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --bg: #262624; --surface: #30302e; --text: #faf9f5; --muted: #a6a39a; --border: #3e3e38;
        --accent-strong: #e8957a; --accent-soft: rgb(217 119 87 / 0.18); --error: #f0937c;
      }
    }`

  const POPUP_CSS = `${THEME_CSS}
    .card {
      box-sizing: border-box; width: max-content; min-width: 240px; max-width: min(380px, calc(100vw - 16px));
      max-height: 60vh; overflow: auto; padding: 14px 16px; border-radius: 14px;
      background: var(--bg); color: var(--text); border: 1px solid var(--border);
      box-shadow: 0 12px 32px rgb(20 20 19 / 0.14), 0 2px 6px rgb(20 20 19 / 0.06);
      font: 14px/1.5 var(--sans); text-align: left;
    }
    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; cursor: grab; user-select: none; }
    .card.dragging .head { cursor: grabbing; }
    .word { font: 600 18px/1.25 var(--serif); letter-spacing: -0.01em; }
    .phonetic { color: var(--muted); }
    .src { flex: 1; color: var(--muted); font-family: var(--serif); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .actions { flex: none; display: flex; gap: 6px; margin-left: auto; }
    .icon-button {
      width: 28px; height: 28px; padding: 0; border: 1px solid var(--border); border-radius: 50%;
      display: grid; place-items: center; background: var(--surface); color: var(--muted); cursor: pointer;
      transition: color 0.15s, border-color 0.15s, opacity 0.15s;
    }
    .icon-button:hover { color: var(--accent); border-color: var(--accent); }
    .icon-button .obsidian { width: 16px; height: 16px; }
    .icon-button[data-state="sending"] { animation: pulse 1s ease-in-out infinite; cursor: progress; }
    .icon-button[data-state="done"] { color: var(--accent); border-color: var(--accent); }
    .icon-button[data-state="failed"] { color: var(--error); border-color: var(--error); }
    @keyframes pulse { 50% { opacity: 0.35; } }
    .clip-note { margin-top: 10px; font-size: 12px; color: var(--muted); }
    .clip-note.error { color: var(--error); }
    .translation { font: 500 16px/1.45 var(--serif); }
    .section { display: grid; gap: 6px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
    .pos { display: inline-block; margin-right: 6px; padding: 0 7px; border-radius: 6px; background: var(--accent-soft); color: var(--accent-strong); font-size: 12px; font-weight: 600; }
    .example { margin-top: 2px; color: var(--muted); font-family: var(--serif); font-style: italic; }
    .muted { color: var(--muted); }`

  let popupHost = null
  let popupCard = null
  let popupMoved = false // dragged by the user: stay where they put it
  let lookupSeq = 0
  const lookups = new Map() // selected text -> Promise<lookup result>

  function h(tag, className, ...children) {
    const el = document.createElement(tag)
    if (className) el.className = className
    el.append(...children.filter(c => c != null && c !== false && c !== ''))
    return el
  }

  function sheetOf(css) {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(css)
    return sheet
  }

  function setHostStyle(host, styles) {
    for (const [k, v] of Object.entries(styles)) host.style.setProperty(k, v, 'important')
  }

  function speakerIcon() {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    const attrs = { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v)
    for (const d of ['M11 5 6 9H2v6h4l5 4V5z', 'M15.5 8.5a5 5 0 0 1 0 7', 'M19 5a10 10 0 0 1 0 14']) {
      const path = document.createElementNS(ns, 'path')
      path.setAttribute('d', d)
      svg.append(path)
    }
    return svg
  }

  function svgIcon(viewBox, paths, attrs) {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', viewBox)
    svg.setAttribute('aria-hidden', 'true')
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v)
    for (const d of paths) {
      const path = document.createElementNS(ns, 'path')
      path.setAttribute('d', d)
      svg.append(path)
    }
    return svg
  }

  // The Obsidian logo traced from the artwork: one polygon per facet, in a 0..100 box.
  const OBSIDIAN_PATH = 'M46.7 0.0 57.1 0.0 57.8 5.5 47.2 33.0 47.0 45.3 49.8 56.3 38.6 58.6 32.3 46.3 23.1 35.3 23.2 31.3 25.9 19.3ZM63.0 5.6 77.5 24.4 80.3 45.7 90.5 62.8 90.2 66.1 82.7 78.2 76.4 68.0 70.5 62.1 63.4 58.1 55.6 56.4 52.8 48.4 52.8 31.8ZM21.7 41.5 30.7 53.9 35.6 68.4 34.9 81.2 29.3 94.1 9.5 73.1 9.6 68.5ZM51.8 61.6 59.6 62.3 65.7 65.1 74.7 74.7 78.9 84.6 74.1 100.0 54.6 100.0 47.3 97.9 33.9 96.6 38.4 87.9 40.5 80.2 41.1 71.5 40.0 63.7Z'
  const obsidianIcon = () => svgIcon('0 0 100 100', [OBSIDIAN_PATH], { class: 'obsidian', fill: '#a88bfa' })
  const STROKE = { width: 15, height: 15, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }
  const checkIcon = () => svgIcon('0 0 24 24', ['M5 12.5l4.5 4.5L19 7.5'], STROKE)
  const crossIcon = () => svgIcon('0 0 24 24', ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'], STROKE)

  function speak(text, lang) {
    speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = lang === 'en' ? 'en-US' : lang
    utterance.rate = 0.95
    speechSynthesis.speak(utterance)
  }

  // In full screen the browser draws only the full-screen element (a video player), so the popup has to live inside
  // it. That element is position: fixed at the viewport's corner, so coordinates in it are viewport coordinates.
  function popupParent() {
    const fs = document.fullscreenElement
    return fs && !['video', 'iframe', 'img', 'canvas'].includes(fs.localName) ? fs : document.documentElement
  }

  // Where (0, 0) of the popup's coordinates is, relative to the viewport.
  const popupOrigin = () => (popupParent() === document.documentElement ? { x: scrollX, y: scrollY } : { x: 0, y: 0 })

  // A shadow root keeps the page's CSS away from the popup and ours away from the page.
  function ensurePopup() {
    if (popupHost && popupCard) {
      if (popupHost.parentNode !== popupParent()) popupParent().append(popupHost)
      return
    }
    popupHost = document.createElement('ipm-popup')
    popupHost.setAttribute('translate', 'no')
    setHostStyle(popupHost, { position: 'absolute', 'z-index': '2147483647', display: 'block', margin: '0', padding: '0', border: '0' })
    const root = popupHost.attachShadow({ mode: 'open' })
    root.adoptedStyleSheets = [sheetOf(POPUP_CSS)]
    popupCard = h('div', 'card')
    popupCard.setAttribute('role', 'dialog')
    root.append(popupCard)
    popupParent().append(popupHost)

    // Drag by the top row (the word or the selected text); the buttons there stay clickable.
    let drag = null
    popupCard.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !e.target.closest('.head') || e.target.closest('button')) return
      e.preventDefault() // no text selection on the page while dragging
      const rect = popupHost.getBoundingClientRect()
      const o = popupOrigin()
      drag = { x: e.clientX, y: e.clientY, left: rect.left + o.x, top: rect.top + o.y, o }
      popupCard.setPointerCapture(e.pointerId)
      popupCard.classList.add('dragging')
    })
    popupCard.addEventListener('pointermove', e => {
      if (!drag) return
      popupMoved = true
      setHostStyle(popupHost, {
        left: `${clamp(drag.left + e.clientX - drag.x, drag.o.x + 8, drag.o.x + innerWidth - popupCard.offsetWidth - 8)}px`,
        top: `${clamp(drag.top + e.clientY - drag.y, drag.o.y + 8, drag.o.y + innerHeight - popupCard.offsetHeight - 8)}px`,
      })
    })
    const endDrag = () => {
      drag = null
      popupCard.classList.remove('dragging')
    }
    popupCard.addEventListener('pointerup', endDrag)
    popupCard.addEventListener('pointercancel', endDrag)
  }

  function hidePopup() {
    lookupSeq++
    popupHost?.remove()
  }

  function renderLookup(text, { result, error } = {}) {
    const lang = result?.source || 'en'
    let speakButton = null
    if (text.length <= 200) {
      speakButton = h('button', 'icon-button', speakerIcon())
      speakButton.title = 'Nghe phát âm'
      speakButton.addEventListener('click', () => speak(text, lang))
    }
    const actions = h('div', 'actions', speakButton, result && clipButton(text, result))
    const isWord = !/\s/.test(text) && text.length <= 40
    const head = isWord
      ? h('div', 'head', h('span', 'word', text), result?.phonetic && h('span', 'phonetic', `/${result.phonetic}/`), actions)
      : h('div', 'head', h('div', 'src', text), actions)

    const body = []
    if (error) body.push(h('div', 'muted', error))
    else if (!result) body.push(h('div', 'muted', 'Đang dịch…'))
    else {
      body.push(h('div', 'translation', result.translation))
      if (result.meanings.length) {
        body.push(h('div', 'section', ...result.meanings.map(m => h('div', null, h('span', 'pos', m.pos), m.terms.join(', ')))))
      }
      if (result.definitions.length) {
        body.push(h('div', 'section', ...result.definitions.map(d =>
          h('div', null, h('span', 'pos', d.pos), d.gloss, d.example && h('div', 'example', `“${d.example}”`)))))
      }
    }
    popupCard.replaceChildren(head, ...body)
  }

  // `anchor` is the selection's box in page coordinates; prefer below it, flip above when there is no room.
  function placePopup(anchor) {
    const width = popupCard.offsetWidth
    const height = popupCard.offsetHeight
    const { x: ox, y: oy } = popupOrigin()
    const left = Math.max(ox + 8, Math.min(anchor.left, ox + innerWidth - width - 8))
    let top = anchor.bottom + 8
    if (top + height > oy + innerHeight - 8 && anchor.top - 8 - height > oy + 8) top = anchor.top - 8 - height
    popupHost.style.setProperty('left', `${left}px`, 'important')
    popupHost.style.setProperty('top', `${top}px`, 'important')
  }

  // ---------- send to Obsidian: the vocab-flashcard plugin listens on this machine ----------

  function setClipNote(message, isError = false) {
    let note = popupCard.querySelector('.clip-note')
    if (!message) return note?.remove()
    if (!note) popupCard.append((note = h('div', 'clip-note')))
    note.classList.toggle('error', isError)
    note.textContent = message
  }

  // The plugin appends `- **word**: meaning` to the end of the note open in Obsidian.
  async function clipToObsidian(text, result) {
    const { translation, phonetic, source, meanings, definitions } = result
    const payload = { text, translation, phonetic, source, meanings, definitions, title: document.title, url: location.href }
    const res = await chrome.runtime.sendMessage({ type: 'clip', payload })
    if (!res?.ok) throw new Error(res?.error || 'Không nhận được phản hồi từ extension')
    if (res.result.status === 'no-note') throw new Error('Chưa mở note nào trong Obsidian. Hãy mở một note rồi bấm lại.')
    if (res.result.status === 'reading-view') {
      throw new Error(`“${res.result.file}” đang ở chế độ đọc. Chuyển sang chế độ viết trong Obsidian rồi bấm lại.`)
    }
    return res.result
  }

  const CLIP_IDLE_TITLE = 'Thêm vào cuối note đang mở trong Obsidian'
  const CLIP_FLASH_MS = 1000
  const CLIP_ICONS = { done: checkIcon, failed: crossIcon }

  // After each try the button shows a tick (added) or a red cross (not added) for a second, then goes back so it
  // can be clicked again.
  function clipButton(text, result) {
    const button = h('button', 'icon-button')
    const show = (state, title) => {
      button.dataset.state = state
      button.title = title
      button.replaceChildren((CLIP_ICONS[state] ?? obsidianIcon)())
    }
    const flash = (state, title) => {
      show(state, title)
      setTimeout(() => show('idle', CLIP_IDLE_TITLE), CLIP_FLASH_MS)
    }
    show('idle', CLIP_IDLE_TITLE)
    button.addEventListener('click', async () => {
      if (button.dataset.state !== 'idle') return
      show('sending', 'Đang gửi sang Obsidian…')
      setClipNote('')
      try {
        const { file } = await clipToObsidian(text, result)
        flash('done', `Đã thêm vào “${file}”`)
      } catch (err) {
        const message = errorMessage(err).replace(/^Không dịch được: /, '')
        flash('failed', message)
        setClipNote(message, true)
      }
    })
    return button
  }

  async function showLookup(text, anchor) {
    const seq = ++lookupSeq
    popupMoved = false
    ensurePopup()
    renderLookup(text)
    placePopup(anchor)
    if (!lookups.has(text)) {
      const promise = chrome.runtime.sendMessage({ type: 'lookup', text, to: settings.targetLang }).then(res => {
        if (!res?.ok) throw new Error(res?.error || 'Không nhận được phản hồi từ extension')
        return res.result
      })
      promise.catch(() => lookups.delete(text))
      lookups.set(text, promise)
    }
    let outcome
    try {
      outcome = { result: await lookups.get(text) }
    } catch (err) {
      outcome = { error: errorMessage(err) }
    }
    if (seq !== lookupSeq || !popupHost.isConnected) return
    renderLookup(text, outcome)
    if (!popupMoved) placePopup(anchor)
  }

  // The selected text without our translations or ruby readings that may sit inside the selection.
  function selectedText(selection, range) {
    const fragment = range.cloneContents()
    const extras = fragment.querySelectorAll(`${TAG}, rt, rp`)
    if (!extras.length) return selection.toString().replace(/\s+/g, ' ').trim()
    extras.forEach(e => e.remove())
    return fragment.textContent.replace(/\s+/g, ' ').trim()
  }

  function lookupSelection() {
    const selection = getSelection()
    if (!selection || selection.isCollapsed || !selection.rangeCount) return
    const active = document.activeElement
    if (active && (active.localName === 'input' || active.localName === 'textarea' || active.isContentEditable)) return
    const range = selection.getRangeAt(0)
    const node = range.commonAncestorContainer
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
    if (!el || el.closest(TAG) || el.isContentEditable) return
    const text = selectedText(selection, range)
    if (text.length > 1000 || !looksTranslatable(text, settings.targetLang)) return
    const rect = range.getBoundingClientRect()
    if (!rect.width && !rect.height) return
    const o = popupOrigin()
    showLookup(text, { left: rect.left + o.x, top: rect.top + o.y, bottom: rect.bottom + o.y })
  }

  const insidePopup = e => popupHost != null && e.composedPath().includes(popupHost)
  const insideBot = e => botHost != null && e.composedPath().includes(botHost)

  function onSelectMouseUp(e) {
    if (!alive()) return teardown()
    if (!settings.selectLookup || e.button !== 0 || insidePopup(e) || insideBot(e)) return
    setTimeout(lookupSelection) // let a double-click or shift-click finish updating the selection
  }

  function onSelectMouseDown(e) {
    if (popupHost && !insidePopup(e)) hidePopup()
  }

  function onSelectKeyDown(e) {
    if (e.key === 'Escape') hidePopup()
  }

  // ---------- floating bot: drag it anywhere, click it to translate the page ----------

  // The spark logo traced from the artwork into a 0..100 polygon, so CSS can color it (black off, orange on).
  const SPARK_PATH = 'M27.7 0.1 32.0 0.6 33.8 2.3 39.8 16.0 48.8 33.5 50.3 38.2 51.2 38.0 51.5 30.6 53.9 7.3 55.3 3.7 58.2 1.7 58.9 1.7 61.1 3.0 62.7 5.3 62.7 6.4 57.7 35.3 58.6 35.3 59.8 34.0 71.0 19.6 77.0 13.1 79.3 11.3 83.5 11.3 86.6 15.6 85.3 20.8 71.8 38.4 68.7 44.1 69.0 44.5 70.5 44.3 82.6 41.6 96.1 39.4 99.2 40.9 99.5 42.7 98.3 45.8 67.1 52.8 66.0 53.5 72.7 54.4 82.6 54.4 94.7 55.3 97.9 57.5 99.9 60.2 99.5 62.2 94.5 64.7 68.1 58.2 65.4 58.0 69.2 62.2 88.9 80.2 89.3 82.8 88.2 84.2 86.7 84.2 77.0 76.8 66.2 67.4 65.4 67.4 65.6 68.7 77.0 85.6 77.3 90.3 76.8 91.4 74.3 92.3 71.4 91.6 64.5 81.9 55.9 67.6 55.0 66.7 54.4 67.1 54.2 68.7 51.7 97.2 50.3 98.8 47.6 99.9 44.9 97.9 43.6 94.9 47.9 74.8 49.0 66.9 49.7 64.5 49.5 63.6 48.6 64.2 34.0 84.2 29.2 89.4 26.6 92.0 25.2 92.5 22.3 91.1 22.5 88.4 23.9 86.2 39.6 66.0 43.4 61.6 44.0 60.9 43.8 60.0 17.4 77.2 12.5 77.9 10.6 75.9 10.9 72.8 12.0 71.8 19.9 66.3 38.5 56.0 39.8 54.6 39.3 53.9 37.3 53.7 4.2 52.4 2.3 51.9 0.1 49.0 0.5 47.6 2.1 46.5 28.2 48.1 36.9 49.2 39.8 49.0 40.0 48.5 38.5 47.2 18.9 34.2 10.0 27.9 8.4 25.9 7.9 21.6 9.5 19.8 10.4 18.9 14.9 19.2 38.5 37.3 39.3 36.7 33.5 25.7 24.1 9.8 23.2 4.8 25.9 1.0Z'
  const BOT_SIZE = 44
  const BOT_MARGIN = 12
  const BOT_CSS = `${THEME_CSS}
    .bot {
      box-sizing: border-box; width: ${BOT_SIZE}px; height: ${BOT_SIZE}px; padding: 0; border-radius: 50%;
      display: grid; place-items: center; cursor: grab; touch-action: none; user-select: none;
      background: #faf9f5; border: 1px solid rgb(20 20 19 / 0.12); color: #141413;
      box-shadow: 0 6px 18px rgb(20 20 19 / 0.18), 0 1px 3px rgb(20 20 19 / 0.1);
      transition: transform 0.15s, color 0.2s;
    }
    .bot:hover { transform: scale(1.06); }
    .bot:active { cursor: grabbing; }
    .bot:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .bot.on { color: var(--accent); }
    .bot svg { width: 26px; height: 26px; fill: currentColor; }
    .bot.busy svg { animation: spin 1.6s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }`

  let botHost = null
  let botButton = null
  let botPos = { fx: 1, fy: 0.8 } // share of the free space: right edge, low on the screen
  let inflight = 0 // translation batches waiting for an answer

  function sparkSvg() {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 100 100')
    svg.setAttribute('aria-hidden', 'true')
    const path = document.createElementNS(ns, 'path')
    path.setAttribute('d', SPARK_PATH)
    svg.append(path)
    return svg
  }

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

  // The free space the bot can sit in; the position is stored as fractions of it, so it survives window resizes.
  function botRoom() {
    const { clientWidth, clientHeight } = document.documentElement
    return {
      width: Math.max(1, (clientWidth || innerWidth) - BOT_SIZE - 2 * BOT_MARGIN),
      height: Math.max(1, (clientHeight || innerHeight) - BOT_SIZE - 2 * BOT_MARGIN),
    }
  }

  function placeBot() {
    if (!botHost) return
    const room = botRoom()
    setHostStyle(botHost, {
      left: `${BOT_MARGIN + clamp(botPos.fx, 0, 1) * room.width}px`,
      top: `${BOT_MARGIN + clamp(botPos.fy, 0, 1) * room.height}px`,
    })
  }

  function updateBot() {
    if (!botButton) return
    botButton.classList.toggle('on', enabled)
    botButton.classList.toggle('busy', enabled && inflight > 0)
    botButton.setAttribute('aria-pressed', String(enabled))
    botButton.title = enabled ? 'Tắt dịch, hiện bản gốc (kéo để di chuyển)' : 'Dịch trang này (kéo để di chuyển)'
  }

  function toggleTranslation() {
    if (!alive()) {
      teardown()
      return toast('ProMax vừa được cập nhật. Hãy tải lại trang để dùng tiếp.')
    }
    enabled ? disable() : enable()
  }

  function createBot() {
    botHost = document.createElement('ipm-bot')
    botHost.setAttribute('translate', 'no')
    setHostStyle(botHost, { position: 'fixed', 'z-index': '2147483646', display: 'block', margin: '0', padding: '0', border: '0' })
    const root = botHost.attachShadow({ mode: 'open' })
    root.adoptedStyleSheets = [sheetOf(BOT_CSS)]
    botButton = h('button', 'bot', sparkSvg())
    botButton.setAttribute('aria-label', 'ProMax Translate')
    root.append(botButton)
    document.documentElement.append(botHost)

    // A press that barely moves is a click; anything more drags the bot.
    let drag = null
    botButton.addEventListener('pointerdown', e => {
      if (e.button !== 0) return
      const rect = botHost.getBoundingClientRect()
      drag = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, moved: false }
      botButton.setPointerCapture(e.pointerId)
    })
    botButton.addEventListener('pointermove', e => {
      if (!drag) return
      const dx = e.clientX - drag.x
      const dy = e.clientY - drag.y
      if (!drag.moved && Math.hypot(dx, dy) < 4) return
      drag.moved = true
      const room = botRoom()
      botPos = {
        fx: clamp((drag.left + dx - BOT_MARGIN) / room.width, 0, 1),
        fy: clamp((drag.top + dy - BOT_MARGIN) / room.height, 0, 1),
      }
      placeBot()
    })
    botButton.addEventListener('pointerup', () => {
      if (!drag) return
      const { moved } = drag
      drag = null
      if (moved) chrome.storage.local.set({ botPos })
      else toggleTranslation()
    })
    botButton.addEventListener('pointercancel', () => { drag = null })
    botButton.addEventListener('click', e => e.detail === 0 && toggleTranslation()) // Enter / Space

    placeBot()
    updateBot()
    addEventListener('resize', placeBot)
    chrome.storage.local.get({ botPos }).then(saved => {
      botPos = saved.botPos
      placeBot()
    })
  }

  // ---------- translation requests (batched, cached per page) ----------

  const cache = new Map() // sentence -> Promise<{ text, pieces }>
  let pending = []
  let flushTimer = null

  function translateSentences(sentences) {
    return Promise.all(sentences.map(({ text, chunks }) => {
      if (!cache.has(text)) {
        const promise = new Promise((resolve, reject) => pending.push({ text, chunks: chunks.map(c => c.text), resolve, reject }))
        promise.catch(() => cache.delete(text))
        cache.set(text, promise)
        flushTimer ??= setTimeout(flush, 30)
      }
      return cache.get(text)
    }))
  }

  function flush() {
    flushTimer = null
    const items = pending
    pending = []
    const sizeOf = item => item.text.length + item.chunks.length * 12 // each chunk adds an <a i=N></a> tag
    for (let i = 0; i < items.length;) {
      const batch = []
      let size = 0
      while (i < items.length && batch.length < BATCH_ITEMS && (!batch.length || size + sizeOf(items[i]) <= BATCH_CHARS)) {
        size += sizeOf(items[i])
        batch.push(items[i++])
      }
      sendBatch(batch)
    }
  }

  async function sendBatch(batch) {
    inflight++
    updateBot()
    try {
      const res = await chrome.runtime.sendMessage({ type: 'translate', items: batch.map(b => b.chunks), to: settings.targetLang })
      if (!res?.ok) throw new Error(res?.error || 'Không nhận được phản hồi từ extension')
      batch.forEach((b, i) => b.resolve(res.result[i]))
    } catch (err) {
      batch.forEach(b => b.reject(err))
    } finally {
      inflight--
      updateBot()
    }
  }

  function errorMessage(err) {
    if (/context invalidated/i.test(err.message)) return 'ProMax vừa được cập nhật. Hãy tải lại trang để dịch tiếp.'
    return `Không dịch được: ${err.message}`
  }

  let toastTimer = null
  function toast(message) {
    let el = document.querySelector('ipm-toast')
    if (!el) {
      el = document.createElement('ipm-toast')
      document.documentElement.append(el)
    }
    el.textContent = message
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => el.remove(), 5000)
  }

  // ---------- finding containers and keeping up with page changes ----------

  function consider(el) {
    if (state.has(el) || displayKind(el) !== 'block' || !hasOwnText(el)) return
    state.set(el, { status: 'queued', sig: '', count: 0, splits: [], chunks: [] })
    io.observe(el)
  }

  function scan(root) {
    if (root.nodeType !== Node.ELEMENT_NODE || !root.isConnected || isInsideSkipped(root)) return
    consider(root)
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: el => (isSkipped(el) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    })
    while (walker.nextNode()) consider(walker.currentNode)
  }

  function containerOf(node) {
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
    while (el && el !== document.body && displayKind(el) === 'inline') el = el.parentElement
    return el
  }

  // A container we already translated changed: redo it if its text changed or our translations were wiped.
  function recheck(el) {
    const st = state.get(el)
    if (st.status !== 'done') return
    if (countOurs(el) === st.count && analyze(el).sig === st.sig) return
    removeOwn(el)
    st.status = 'queued'
    io.observe(el)
  }

  function onMutations(records) {
    for (const r of records) {
      if (r.type === 'childList') r.addedNodes.forEach(n => n.nodeType === Node.ELEMENT_NODE && dirtyRoots.add(n))
      dirtyTargets.add(r.target)
    }
    dirtyTimer ??= setTimeout(processDirty, 250)
  }

  function processDirty() {
    dirtyTimer = null
    if (!enabled) return
    const targets = [...dirtyTargets]
    const roots = [...dirtyRoots]
    dirtyTargets.clear()
    dirtyRoots.clear()
    for (const target of targets) {
      const el = target.isConnected && containerOf(target)
      if (!el || isInsideSkipped(el)) continue
      if (state.has(el)) recheck(el)
      else consider(el)
    }
    roots.forEach(scan)
  }

  function onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      io.unobserve(entry.target)
      translateContainer(entry.target)
    }
  }

  // ---------- on / off ----------

  function enable() {
    if (enabled || !document.body) return
    enabled = true
    io = new IntersectionObserver(onIntersect, { rootMargin: '400px 0px' })
    scan(document.body)
    mo.observe(document.body, { childList: true, characterData: true, subtree: true })
    document.addEventListener('click', onChunkClick, true)
    updateBot()
  }

  function disable() {
    if (!enabled) return
    enabled = false
    io.disconnect()
    mo.disconnect()
    document.removeEventListener('click', onChunkClick, true)
    light(null)
    clearTimeout(dirtyTimer)
    dirtyTimer = null
    dirtyTargets.clear()
    dirtyRoots.clear()
    for (const el of [...touched]) removeOwn(el)
    state = new WeakMap()
    updateBot()
  }

  chrome.storage.sync.get(settings).then(saved => {
    settings = saved
    if (saved.autoSites.includes(location.hostname)) enable()
  })

  // Leave the page to a newer copy of this script: undo our translations, remove our UI, stop listening.
  function teardown() {
    disable()
    hidePopup()
    botHost?.remove()
    botHost = null
    botButton = null
    removeEventListener('resize', placeBot)
    document.removeEventListener('mouseup', onSelectMouseUp, true)
    document.removeEventListener('mousedown', onSelectMouseDown, true)
    document.removeEventListener('keydown', onSelectKeyDown, true)
    document.removeEventListener('fullscreenchange', hidePopup)
    document.removeEventListener(TAKEOVER, teardown)
    strays.disconnect()
  }

  document.dispatchEvent(new CustomEvent(TAKEOVER))
  // Copies from before the takeover event existed cannot step aside: clear what they left on the page, and remove
  // any popup or bot they open later (they still listen for mouse-ups until the tab is reloaded).
  document.querySelectorAll(`ipm-bot, ipm-popup, ${TAG}`).forEach(el => el.remove())
  const strays = new MutationObserver(records => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if ((n.localName === 'ipm-popup' && n !== popupHost) || (n.localName === 'ipm-bot' && n !== botHost)) n.remove()
      }
    }
  })
  strays.observe(document.documentElement, { childList: true })
  document.addEventListener(TAKEOVER, teardown)

  if (document.body) createBot()
  document.addEventListener('mouseup', onSelectMouseUp, true)
  document.addEventListener('mousedown', onSelectMouseDown, true)
  document.addEventListener('keydown', onSelectKeyDown, true)
  document.addEventListener('fullscreenchange', hidePopup) // its coordinates no longer apply

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return
    if (changes.clickHighlight) {
      settings.clickHighlight = changes.clickHighlight.newValue
      if (!settings.clickHighlight) light(null)
    }
    if (changes.selectLookup) {
      settings.selectLookup = changes.selectLookup.newValue
      if (!settings.selectLookup) hidePopup()
    }
    if (!changes.targetLang) return
    settings.targetLang = changes.targetLang.newValue
    cache.clear()
    lookups.clear()
    if (enabled) {
      disable()
      enable()
    }
  })

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'toggle') enabled ? disable() : enable()
    else if (msg.type === 'set') msg.enabled ? enable() : disable()
    else if (msg.type !== 'status') return
    sendResponse({ enabled, host: location.hostname })
  })
})()
