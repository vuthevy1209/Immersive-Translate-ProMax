importScripts('translator.js')

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'translate') {
    reply(IPMTranslator.translate(msg.items, { to: msg.to }), sendResponse)
    return true
  }
  if (msg.type === 'lookup') {
    reply(IPMTranslator.lookup(msg.text, { to: msg.to }), sendResponse)
    return true
  }
  if (msg.type === 'clip') {
    reply(clipToObsidian(msg.payload), sendResponse)
    return true
  }
  if (msg.type === 'relay') {
    reply(sendToTab(msg.tabId, msg.message), sendResponse)
    return true
  }
})

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-translate' && tab?.id) sendToTab(tab.id, { type: 'toggle' }).catch(() => {})
})

// Tabs that were open before an install or reload still run the old copy of the content script (or none), and
// Chrome does not refresh them. Give each one the current copy; it replaces the old one on the page.
chrome.runtime.onInstalled.addListener(async () => {
  for (const tab of await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })) {
    inject(tab.id).catch(() => {}) // e.g. the Web Store or a discarded tab
  }
  const subtitles = chrome.runtime.getManifest().content_scripts.find(s => s.js.includes('src/subtitles.js'))
  for (const tab of await chrome.tabs.query({ url: subtitles.matches })) {
    injectSubtitles(tab.id).catch(() => {})
  }
})

// The Vocab Flashcard plugin in Obsidian listens here and inserts the card into the note that is open.
const CLIP_URL = 'http://127.0.0.1:27190/clip'

async function clipToObsidian(payload) {
  let res
  try {
    res = await fetch(CLIP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(4000),
    })
  } catch {
    throw new Error('Chưa kết nối được Obsidian: hãy mở Obsidian và bật plugin Vocab Flashcard.')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Obsidian trả về lỗi ${res.status}`)
  return data // { status: 'inserted' | 'duplicate' | 'no-note', file }
}

function reply(promise, sendResponse) {
  promise.then(result => sendResponse({ ok: true, result }), err => sendResponse({ ok: false, error: err.message }))
}

async function inject(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/content.css'] })
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/segment.js', 'src/content.js'] })
}

// Bilingual captions on YouTube and Udemy. The hook only catches caption files the player downloads from now on;
// for the video already open, subtitles.js translates the captions shown on screen instead.
async function injectSubtitles(tabId) {
  const target = { tabId, allFrames: true }
  await chrome.scripting.executeScript({ target, files: ['src/subtitle-hook.js'], world: 'MAIN' })
  await chrome.scripting.insertCSS({ target, files: ['src/subtitles.css'] })
  await chrome.scripting.executeScript({ target, files: ['src/segment.js', 'src/subtitle-parse.js', 'src/subtitles.js'] })
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message)
  } catch {
    await inject(tabId) // nothing answered: the tab has no live content script yet
    return chrome.tabs.sendMessage(tabId, message)
  }
}
