// Stand-in for the extension APIs so the content script can run on test/demo.html, opened as a plain page.
// Add ?fake to the URL to get "[vi] ..." translations without calling Google.
window.chrome = {
  runtime: {
    id: 'demo', // a live extension context has an id; without it content.js thinks it was orphaned and tears down
    onMessage: {
      addListener(fn) {
        window.ipmMessage = msg => new Promise(resolve => fn(msg, {}, resolve))
      },
    },
    async sendMessage(msg) {
      const fake = new URLSearchParams(location.search).has('fake')
      try {
        if (msg.type === 'translate') {
          const { buildMarked, parseMarked } = IPMTranslator
          if (fake) return { ok: true, result: msg.items.map(chunks => parseMarked(buildMarked(chunks.map(c => `[vi] ${c}`)))) }
          return { ok: true, result: await IPMTranslator.translate(msg.items, { to: msg.to }) }
        }
        if (msg.type === 'lookup') {
          if (fake) {
            return { ok: true, result: { translation: `[vi] ${msg.text}`, phonetic: 'fāk', source: 'en', meanings: [{ pos: 'danh từ', terms: ['nghĩa một', 'nghĩa hai'] }], definitions: [{ pos: 'danh từ', gloss: 'a fake definition.', example: 'a fake example' }] } }
          }
          return { ok: true, result: await IPMTranslator.lookup(msg.text, { to: msg.to }) }
        }
        if (msg.type === 'clip') {
          // No Obsidian here: remember the payloads so a test can read them, and answer like the plugin would.
          ;(window.ipmClips ??= []).push(msg.payload)
          return { ok: true, result: { status: window.ipmClipStatus ?? 'inserted', file: 'Demo note' } } // a test may set ipmClipStatus
        }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },
  },
  storage: {
    sync: { get: async defaults => ({ ...defaults, autoSites: [location.hostname] }) },
    local: { get: async defaults => defaults, set: async () => {} },
    onChanged: { addListener() {} },
  },
}
