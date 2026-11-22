// Run with: node --test test/*.test.mjs
// Runs src/subtitles.js against a stand-in page and extension API to check how it schedules translation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = name => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function setup({ currentTime, playing = true }) {
  const document = new EventTarget()
  document.documentElement = { append() {} }
  // A video element: it records pause() and play(), and fires 'play' like a real one.
  const video = Object.assign(new EventTarget(), {
    currentTime, paused: !playing, isConnected: true, log: [],
    pause() { this.paused = true; this.log.push('pause') },
    play() { this.paused = false; this.log.push('play'); this.dispatchEvent(new Event('play')); return Promise.resolve() },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }),
  })
  document.querySelector = selector => (selector.includes('video') ? video : null)
  document.querySelectorAll = () => []
  document.body = {}
  document.createTreeWalker = () => ({ nextNode: () => false }) // a page with no caption text on it
  const requests = []
  let inFlight = 0
  let maxInFlight = 0
  const chrome = {
    runtime: {
      id: 'test',
      async sendMessage(msg) {
        requests.push(msg.items.map(chunks => chunks.join(' ')))
        maxInFlight = Math.max(maxInFlight, ++inFlight)
        await sleep(15)
        inFlight--
        return { ok: true, result: msg.items.map(chunks => ({ text: `[vi] ${chunks.join(' ')}`, pieces: [] })) }
      },
    },
    storage: { sync: { get: async defaults => defaults }, onChanged: { addListener() {} } },
  }
  const context = vm.createContext({
    document, chrome, location: { hostname: 'www.udemy.com', search: '', pathname: '/course/x' },
    CustomEvent, Event, URL, URLSearchParams, setInterval, clearInterval, setTimeout, console, NodeFilter: { SHOW_TEXT: 4 },
  })
  // The progress note over the video is a real element in the browser; here a stand-in with the same surface.
  document.createElement = () => ({
    style: { setProperty() {} }, firstChild: { textContent: '' }, parentNode: null,
    setAttribute() {}, append(...kids) { this.firstChild = kids[0] ?? this.firstChild }, addEventListener() {}, remove() {},
  })
  context.window = context
  for (const name of ['segment.js', 'subtitle-parse.js', 'subtitles.js']) vm.runInContext(source(name), context)
  const sendFile = (url, text) => document.dispatchEvent(new CustomEvent('ipm:subs-data', { detail: JSON.stringify({ url, text }) }))
  const stop = () => { chrome.runtime.id = undefined } // the next tick sees a dead extension and tears down
  return { requests, sendFile, stop, video, maxInFlight: () => maxInFlight }
}

// 200 one-second cues, each its own sentence.
const vtt = 'WEBVTT\n\n' + Array.from({ length: 200 }, (_, i) => {
  const t = s => `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000`
  return `${t(i)} --> ${t(i + 1)}\nThis is line number ${i}.`
}).join('\n\n')

test('translates the whole caption file as soon as it arrives, starting where the video is', async () => {
  const page = setup({ currentTime: 100.5 })
  await sleep(10) // settings load
  page.sendFile('https://cdn.example/captions-en.vtt', vtt)
  for (let i = 0; i < 100 && page.requests.flat().length < 200; i++) await sleep(20)
  page.stop()

  const sent = page.requests.flat()
  assert.equal(sent.length, 200, 'every line is sent once')
  assert.equal(new Set(sent).size, 200)
  assert.equal(sent[0], 'This is line number 100.', 'the line on screen goes first')
  assert.equal(sent[99], 'This is line number 199.')
  assert.equal(sent[100], 'This is line number 0.', 'then back to the start')
  assert.ok(page.maxInFlight() <= 3, 'no more than three requests at a time')
})

test('holds the video until the caption file is translated, then plays it again', async () => {
  const page = setup({ currentTime: 0, playing: true })
  await sleep(10)
  page.sendFile('https://cdn.example/captions-en.vtt', vtt)
  assert.equal(page.video.paused, true, 'paused as soon as the file arrives')
  page.video.play() // autoplay or a click while we wait
  assert.equal(page.video.paused, true, 'kept paused')
  for (let i = 0; i < 100 && page.video.paused; i++) await sleep(20)
  page.stop()
  assert.equal(page.video.paused, false, 'playing again')
  assert.equal(page.requests.flat().length, 200, 'after every line was translated')
})

test('does not start a video the viewer had paused', async () => {
  const page = setup({ currentTime: 0, playing: false })
  await sleep(10)
  page.sendFile('https://cdn.example/captions-en.vtt', vtt)
  for (let i = 0; i < 100 && page.requests.flat().length < 200; i++) await sleep(20)
  await sleep(250)
  page.stop()
  assert.equal(page.video.paused, true)
  assert.ok(!page.video.log.includes('play'))
})

test('ignores the thumbnail sprite file', async () => {
  const page = setup({ currentTime: 0 })
  await sleep(10)
  page.sendFile('https://cdn.example/thumb-sprites.vtt', 'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nthumb-sprites.jpg#xywh=0,0,160,90\n')
  await sleep(50)
  page.stop()
  assert.equal(page.requests.length, 0)
})
