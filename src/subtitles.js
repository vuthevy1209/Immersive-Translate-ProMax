// Bilingual captions on YouTube and Udemy: the translation shows right under each caption line.
//
// src/subtitle-hook.js copies every caption file the player downloads. As soon as one arrives we translate the whole
// file, a whole sentence at a time (see subtitle-parse.js), starting from where the video is, so the translation is
// ready before each line is spoken.
//   YouTube: we draw the captions ourselves (<ipm-subs> over the video, timed by video.currentTime) and hide the
//            player's own. That also turns the word-by-word auto-generated captions into whole lines.
//   Udemy:   the player keeps drawing its captions; we put the translation inside each caption box it shows.
// If no caption file was caught (the extension was installed or reloaded after the page opened), both sites fall back
// to translating whatever caption text is on screen.
(() => {
  if (window.__ipmSubsLoaded) return
  window.__ipmSubsLoaded = true

  const TAKEOVER = 'ipm:subs-takeover'
  const DATA_EVENT = 'ipm:subs-data'
  const REPLAY_EVENT = 'ipm:subs-replay'
  const alive = () => Boolean(chrome.runtime?.id)

  const { looksTranslatable } = IPMSegment
  const { parseTrack, groupSentences, distribute, keyOf } = IPMSubs

  const SITE = /(^|\.)youtube(-nocookie)?\.com$/.test(location.hostname) ? 'youtube' : 'udemy'
  const UDEMY_CUE = '[data-purpose="captions-cue-text"], [class*="caption"] > [class*="cue-text"]'
  const TICK_MS = 100
  const IN_FLIGHT = 2 // translation requests at a time; the next batch is picked from where the video is now
  const BATCH_CHARS = 3000
  const BATCH_ITEMS = 40
  const RETRY_MS = 15000
  // On-screen text must stay this long before we translate it: YouTube's auto-generated captions grow word by word.
  const SETTLE_MS = SITE === 'youtube' ? 400 : 0

  let settings = { targetLang: 'vi', subtitles: true }
  let timer = null
  let tracks = [] // newest last: { videoId, cues, sentences, byKey, total, done }
  let ready = false // settings loaded
  let focus = null // { track, at }: the track on screen and the index of the sentence showing
  let inFlight = 0
  const onScreen = new Map() // fallback: key of a caption on screen -> { text, since, status, translation, error }

  // ---------- caption files from the hook ----------

  function buildTrack(url, body) {
    const cues = parseTrack(url, body)
    if (!cues) return null
    const sentences = groupSentences(cues).map((indexes, index) => {
      const sentence = { index, cues: indexes.map(i => cues[i]), status: null, retryAt: 0 }
      const text = sentence.cues.map(c => c.text).join(' ')
      if (!looksTranslatable(text, settings.targetLang)) sentence.status = 'skip'
      return sentence
    })
    const byKey = new Map()
    cues.forEach((cue, index) => {
      cue.index = index
      cue.translation = null
      cue.error = null
      const key = keyOf(cue.text)
      if (!byKey.has(key)) byKey.set(key, cue)
    })
    sentences.forEach(s => s.cues.forEach(cue => { cue.sentence = s }))
    let videoId = null
    try {
      videoId = new URL(url).searchParams.get('v')
    } catch {}
    const total = sentences.filter(s => s.status !== 'skip').length
    return { videoId, cues, sentences, byKey, total, done: 0 }
  }

  function mainVideo() {
    return document.querySelector('#movie_player video') ?? document.querySelector('video')
  }

  // Index of the last cue starting at or before `t` (ms), or -1.
  function cueIndexAt(cues, t) {
    let lo = 0
    let hi = cues.length - 1
    let last = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (cues[mid].start <= t) {
        last = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    return last
  }

  function onCaptionFile(e) {
    if (typeof e.detail !== 'string') return
    let track = null
    try {
      const { url, text } = JSON.parse(e.detail)
      track = buildTrack(url, text)
    } catch {}
    if (!track) return
    // A newer file for the same YouTube video means the viewer picked another caption language.
    if (track.videoId) tracks = tracks.filter(t => t.videoId !== track.videoId)
    tracks.push(track)
    if (tracks.length > 8) tracks.shift()
    // Start the whole file right away, from where the video is (a resumed video does not start at 0).
    const video = mainVideo()
    const cue = track.cues[Math.max(0, cueIndexAt(track.cues, (video?.currentTime ?? 0) * 1000))]
    focus = { track, at: cue.sentence.index }
    pump()
  }

  // ---------- translating ----------

  function resetTranslations() {
    for (const track of tracks) {
      for (const s of track.sentences) {
        s.status = looksTranslatable(s.cues.map(c => c.text).join(' '), settings.targetLang) ? null : 'skip'
        s.cues.forEach(c => { c.translation = c.error = null })
      }
      track.total = track.sentences.filter(s => s.status !== 'skip').length
      track.done = 0
    }
    onScreen.clear()
  }

  // The sentence showing is what to translate first; the rest of the file follows from there.
  function ensureAround(track, cue) {
    if (focus?.track !== track || focus.at !== cue.sentence.index) focus = { track, at: cue.sentence.index }
    pump()
  }

  const sizeOf = s => s.cues.reduce((n, c) => n + c.text.length + 12, 0)
  const due = (s, now) => !s.status || (s.status === 'error' && now >= s.retryAt)

  // The next sentences to send: from the one showing to the end of its file, then back to the start; then other files.
  // Picking each batch only when a request slot frees up means a seek moves the translation to the new spot at once.
  function nextBatch() {
    const now = Date.now()
    const order = focus ? [focus, ...tracks.filter(t => t !== focus.track).reverse().map(track => ({ track, at: 0 }))]
      : [...tracks].reverse().map(track => ({ track, at: 0 }))
    for (const { track, at } of order) {
      if (track.done >= track.total) continue
      const { sentences } = track
      const batch = []
      let size = 0
      for (let k = 0; k < sentences.length && batch.length < BATCH_ITEMS; k++) {
        const s = sentences[(at + k) % sentences.length]
        if (!due(s, now)) continue
        if (batch.length && size + sizeOf(s) > BATCH_CHARS) break
        size += sizeOf(s)
        batch.push(s)
      }
      if (batch.length) return { track, batch }
    }
    return null
  }

  function pump() {
    if (!ready || !timer) return
    while (inFlight < IN_FLIGHT) {
      const next = nextBatch()
      if (!next) return
      next.batch.forEach(s => { s.status = 'loading' })
      inFlight++
      translateSentences(next.track, next.batch).finally(() => {
        inFlight--
        pump()
      })
    }
  }

  const sameText = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase()

  async function request(items) {
    const res = await chrome.runtime.sendMessage({ type: 'translate', items, to: settings.targetLang })
    if (!res?.ok) throw new Error(res?.error || 'Không nhận được phản hồi từ extension')
    return res.result
  }

  function errorMessage(err) {
    if (/context invalidated/i.test(err.message)) return 'ProMax vừa được cập nhật, hãy tải lại trang.'
    return `Không dịch được: ${err.message}`
  }

  async function translateSentences(track, batch) {
    const lang = settings.targetLang
    try {
      const results = await request(batch.map(s => s.cues.map(c => c.text)))
      if (lang !== settings.targetLang) return
      batch.forEach((s, i) => {
        const result = results[i]
        const parts = result?.text ? distribute(result, s.cues.length) : null
        s.cues.forEach((cue, k) => {
          const translation = parts?.[k] ?? result?.text ?? ''
          cue.translation = sameText(translation, cue.text) ? '' : translation
          cue.error = null
        })
        s.status = 'done'
        track.done++
      })
    } catch (err) {
      if (lang !== settings.targetLang) return
      const message = errorMessage(err)
      batch.forEach(s => {
        s.status = 'error'
        s.retryAt = Date.now() + RETRY_MS
        s.cues.forEach(c => { c.error = message })
      })
    }
  }

  // Fallback for a caption that is on screen but in no caption file we caught.
  function translateOnScreen(text) {
    const key = keyOf(text)
    let entry = onScreen.get(key)
    if (!entry) {
      if (onScreen.size > 1000) onScreen.clear()
      onScreen.set(key, (entry = { text, since: Date.now(), status: null, translation: null, error: null, retryAt: 0 }))
    }
    const now = Date.now()
    const due = !entry.status ? now - entry.since >= SETTLE_MS : entry.status === 'error' && now >= entry.retryAt
    if (due) {
      entry.status = 'loading'
      const lang = settings.targetLang
      request([[text]]).then(([result]) => {
        if (lang !== settings.targetLang) return
        entry.translation = result?.text && !sameText(result.text, text) ? result.text : ''
        entry.error = null
        entry.status = 'done'
      }, err => {
        if (lang !== settings.targetLang) return
        entry.error = errorMessage(err)
        entry.status = 'error'
        entry.retryAt = Date.now() + RETRY_MS
      })
    }
    return entry
  }

  // What to show under a caption the player drew: { translation } or { error }, or null while waiting.
  function translationOf(raw) {
    const text = raw.replace(/\s+/g, ' ').trim()
    if (!text || !looksTranslatable(text, settings.targetLang)) return null
    const key = keyOf(text)
    for (let i = tracks.length - 1; i >= 0; i--) {
      const cue = tracks[i].byKey.get(key)
      if (!cue) continue
      ensureAround(tracks[i], cue)
      return shown(cue)
    }
    return shown(translateOnScreen(text))
  }

  const shown = ({ translation, error }) => (translation ? { translation } : error ? { error } : null)

  // ---------- YouTube: our own caption overlay ----------

  let overlay = null
  let overlaySig = ''

  function currentVideoId() {
    return new URLSearchParams(location.search).get('v') ??
      location.pathname.match(/\/(?:embed|shorts|live)\/([\w-]{11})/)?.[1] ?? null
  }

  // Clicks and double-clicks on the captions would pause the video or toggle full screen; selecting text in them (for
  // the dictionary popup) should do neither.
  function shieldFromPlayer(el) {
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
      el.addEventListener(type, e => e.stopPropagation())
    }
  }

  function makeTranslationEl(state) {
    const el = document.createElement('ipm-sub-tr')
    el.setAttribute('translate', 'no')
    el.className = 'notranslate'
    el.lang = settings.targetLang
    if (state.error) el.setAttribute('data-error', '')
    el.textContent = state.translation ?? state.error
    return el
  }

  function overlayLine(cue) {
    const line = document.createElement('ipm-sub-line')
    const original = document.createElement('ipm-sub-orig')
    original.textContent = cue.text
    line.append(original)
    const state = shown(cue)
    if (state) line.append(makeTranslationEl(state))
    shieldFromPlayer(line)
    return line
  }

  // Cues are sorted by start and may overlap; returns the ones on screen at `t`, in order.
  function activeCues(cues, t) {
    const last = cueIndexAt(cues, t)
    const active = []
    for (let i = last; i >= 0 && i > last - 20; i--) if (cues[i].end > t) active.unshift(cues[i])
    return { active, near: cues[Math.max(0, last)] }
  }

  function removeOverlay() {
    overlay?.remove()
    overlay = null
    overlaySig = ''
    document.querySelectorAll('[data-ipm-subs]').forEach(el => el.removeAttribute('data-ipm-subs'))
  }

  function tickYouTube() {
    const player = document.querySelector('#movie_player') ?? document.querySelector('.html5-video-player')
    const video = player?.querySelector('video')
    const button = player?.querySelector('.ytp-subtitles-button')
    const captionsOn = button ? button.getAttribute('aria-pressed') === 'true' : true
    if (!video || !captionsOn || player.classList.contains('ad-showing')) {
      removeOverlay()
      return syncInline([])
    }
    const id = currentVideoId()
    const track = [...tracks].reverse().find(t => t.videoId && (!id || t.videoId === id))
    if (!track) {
      removeOverlay()
      return syncInline(youtubeOnScreen(player))
    }
    syncInline([])

    if (overlay?.parentElement !== player) {
      overlay?.remove()
      overlay = document.createElement('ipm-subs')
      overlay.setAttribute('translate', 'no')
      overlay.className = 'notranslate'
      player.append(overlay)
      overlaySig = ''
    }
    player.setAttribute('data-ipm-subs', '') // hides the player's own captions (subtitles.css)

    const { active, near } = activeCues(track.cues, video.currentTime * 1000)
    if (near) ensureAround(track, active[0] ?? near)

    // Above the control bar while it shows, near the bottom edge otherwise; text scales with the player like YouTube's.
    const box = player.getBoundingClientRect()
    const bar = player.querySelector('.ytp-chrome-bottom')
    const controlsShown = !player.classList.contains('ytp-autohide') && bar?.offsetHeight
    const bottom = Math.round(controlsShown ? box.bottom - bar.getBoundingClientRect().top + 8 : box.height * 0.04)
    const size = Math.round(Math.min(40, Math.max(14, box.height * 0.045)))

    // While the file is still being translated, a small note above the captions says how far along it is.
    const progress = track.done < track.total ? Math.floor((track.done * 100) / track.total) : null

    const lines = active.map(c => `${c.index}:${c.translation ?? ''}:${c.error ?? ''}`).join('|')
    const sig = `${bottom}|${size}|${progress}|${lines}`
    if (sig === overlaySig) return
    overlaySig = sig
    overlay.style.setProperty('bottom', `${bottom}px`, 'important')
    overlay.style.setProperty('font-size', `${size}px`, 'important')
    const children = active.map(overlayLine)
    if (progress !== null) {
      const status = document.createElement('ipm-subs-status')
      status.textContent = `Đang dịch phụ đề… ${progress}%`
      children.unshift(status)
    }
    overlay.replaceChildren(...children)
  }

  function youtubeOnScreen(player) {
    return [...player.querySelectorAll('.caption-window')].map(host => {
      const segments = [...host.querySelectorAll('.ytp-caption-segment')]
      return { host, text: segments.map(s => s.textContent).join(' '), fontSize: segments[0] && getComputedStyle(segments[0]).fontSize }
    })
  }

  // ---------- Udemy, and the fallback: translation inside the caption box the player drew ----------

  let inline = new Set() // our <ipm-sub-tr> elements placed in the player's caption boxes

  // The caption's own text, without our translation inside it.
  function ownText(el) {
    let text = ''
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.data
      else if (node.nodeType === Node.ELEMENT_NODE && node.localName !== 'ipm-sub-tr') text += ` ${node.textContent} `
    }
    return text
  }

  function udemyOnScreen() {
    if (!document.querySelector('video')) return []
    return [...document.querySelectorAll(UDEMY_CUE)].map(host => ({ host, text: ownText(host) }))
  }

  // The player re-renders its caption boxes all the time and may wipe our element; every tick puts it back.
  function syncInline(items) {
    const keep = new Set()
    for (const { host, text, fontSize } of items) {
      let el = [...host.children].find(c => c.localName === 'ipm-sub-tr')
      const state = translationOf(text)
      if (!state) {
        el?.remove()
        continue
      }
      const value = state.translation ?? state.error
      if (!el || el.textContent !== value || el.hasAttribute('data-error') !== Boolean(state.error)) {
        el?.remove()
        el = makeTranslationEl(state)
        el.setAttribute('data-inline', SITE)
        shieldFromPlayer(el)
      }
      if (fontSize && el.style.fontSize !== fontSize) el.style.setProperty('font-size', fontSize, 'important')
      if (host.lastElementChild !== el) host.append(el)
      keep.add(el)
    }
    for (const el of inline) if (!keep.has(el)) el.remove()
    inline = keep
  }

  // ---------- on / off ----------

  function tick() {
    if (!alive()) return teardown()
    if (SITE === 'youtube') tickYouTube()
    else syncInline(udemyOnScreen())
  }

  function start() {
    timer ??= setInterval(tick, TICK_MS)
    pump()
  }

  function stop() {
    clearInterval(timer)
    timer = null
    removeOverlay()
    syncInline([])
  }

  function teardown() {
    stop()
    document.removeEventListener(DATA_EVENT, onCaptionFile)
    document.removeEventListener(TAKEOVER, teardown)
  }

  // A newer copy of this script (after the extension reloads) takes over from this one.
  document.dispatchEvent(new CustomEvent(TAKEOVER))
  document.querySelectorAll('ipm-subs, ipm-sub-tr').forEach(el => el.remove())
  document.addEventListener(TAKEOVER, teardown)
  document.addEventListener(DATA_EVENT, onCaptionFile)
  document.dispatchEvent(new CustomEvent(REPLAY_EVENT)) // caption files fetched before we loaded

  chrome.storage.sync.get(settings).then(saved => {
    settings = { ...settings, ...saved }
    ready = true
    resetTranslations()
    if (settings.subtitles) start()
  })

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !alive()) return
    if (changes.targetLang) {
      settings.targetLang = changes.targetLang.newValue
      resetTranslations()
      overlaySig = ''
      pump()
    }
    if (changes.subtitles) {
      settings.subtitles = changes.subtitles.newValue
      settings.subtitles ? start() : stop()
    }
  })
})()
