// Runs in the page's own JavaScript world ("world": "MAIN") from document_start on YouTube and Udemy.
// The players download their captions with XHR (YouTube: /api/timedtext, json3) or fetch (Udemy: .vtt). We copy each
// response and hand it to src/subtitles.js, which lives in the extension's isolated world, as a DOM event. The text is
// sent as a string because objects do not cross between the two worlds.
(() => {
  if (window.__ipmSubsHook) return
  Object.defineProperty(window, '__ipmSubsHook', { value: true })

  const WANTED = /\/api\/timedtext|\.vtt(?:[?#]|$)/i
  const VTT_TYPE = /\btext\/vtt\b/i // a caption file served from a URL that does not end in .vtt
  const DATA_EVENT = 'ipm:subs-data'
  const REPLAY_EVENT = 'ipm:subs-replay'
  const recent = [] // the reader loads after the player may have fetched; it asks for these again on start

  function emit(detail) {
    document.dispatchEvent(new CustomEvent(DATA_EVENT, { detail }))
  }

  function post(url, text) {
    if (typeof text !== 'string' || !text.trim()) return
    const detail = JSON.stringify({ url, text })
    recent.push(detail)
    if (recent.length > 6) recent.shift()
    emit(detail)
  }

  document.addEventListener(REPLAY_EVENT, () => recent.forEach(emit))

  function resolve(url) {
    try {
      return new URL(String(url), location.href).href
    } catch {
      return ''
    }
  }

  const urls = new WeakMap() // xhr -> url
  const { open, send } = XMLHttpRequest.prototype

  XMLHttpRequest.prototype.open = function (_method, url) {
    urls.set(this, resolve(url))
    return open.apply(this, arguments)
  }

  XMLHttpRequest.prototype.send = function () {
    const url = urls.get(this)
    if (url) {
      this.addEventListener('load', () => {
        if (this.status !== 200) return
        if (!WANTED.test(url) && !VTT_TYPE.test(this.getResponseHeader('content-type') ?? '')) return
        try {
          const type = this.responseType
          if (type === '' || type === 'text') post(url, this.responseText)
          else if (type === 'json') post(url, JSON.stringify(this.response))
          else if (type === 'arraybuffer') post(url, new TextDecoder().decode(this.response))
        } catch {}
      })
    }
    return send.apply(this, arguments)
  }

  const originalFetch = window.fetch
  window.fetch = function (input) {
    const promise = originalFetch.apply(this, arguments)
    const url = resolve(input instanceof Request ? input.url : input)
    promise.then(res => {
      if (!res.ok || (!WANTED.test(url) && !VTT_TYPE.test(res.headers.get('content-type') ?? ''))) return
      res.clone().text().then(text => post(res.url || url, text), () => {})
    }, () => {})
    return promise
  }
})()
