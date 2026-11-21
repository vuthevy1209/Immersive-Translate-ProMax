// Run with: node --test test/*.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const context = {}
vm.runInNewContext(readFileSync(new URL('../src/subtitle-parse.js', import.meta.url), 'utf8'), context)
const { parseTrack, groupSentences, distribute, keyOf } = context.IPMSubs

const plain = value => JSON.parse(JSON.stringify(value)) // copy out of the vm realm for deepEqual

test('reads WebVTT with short and long timestamps, settings, tags and entities', () => {
  const vtt = `WEBVTT

NOTE made by hand

1
00:00.360 --> 00:02.280
Hey, guys, welcome to Python.

00:00:02.310 --> 00:00:07.140 line:90% align:center
It's a <i>complete</i> course
for beginners &amp; pros.
`
  assert.deepEqual(plain(parseTrack('https://x.udemycdn.com/a.vtt', vtt)), [
    { start: 360, end: 2280, text: 'Hey, guys, welcome to Python.' },
    { start: 2310, end: 7140, text: "It's a complete course for beginners & pros." },
  ])
})

test('ignores the thumbnail sprite track', () => {
  const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nthumb-sprites.jpg#xywh=0,0,160,90\n\n00:00:05.000 --> 00:00:10.000\nthumb-sprites.jpg#xywh=160,0,160,90\n'
  assert.equal(parseTrack('https://x/thumb-sprites.vtt', vtt), null)
})

test('reads YouTube json3 captions written by people', () => {
  const json = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 999999, id: 1, wpWinPosId: 1 }, // a window definition, no text
      { tStartMs: 18640, dDurationMs: 3240, segs: [{ utf8: "♪ We're no strangers to love ♪" }] },
      { tStartMs: 22640, dDurationMs: 4320, segs: [{ utf8: '♪ You know the rules\nand so do I ♪' }] },
    ],
  })
  assert.deepEqual(plain(parseTrack('https://www.youtube.com/api/timedtext?v=x&fmt=json3', json)), [
    { start: 18640, end: 21880, text: "♪ We're no strangers to love ♪" },
    { start: 22640, end: 26960, text: '♪ You know the rules and so do I ♪' },
  ])
})

test('turns auto-generated word-by-word captions into lines and sentences', () => {
  const words = 'so today we are going to talk about how neural networks learn from data and why that matters for everyone'.split(' ')
  // As YouTube sends them: every word but the first of each event starts with a space.
  const segs = words.map((w, i) => ({ utf8: i === 0 || i === 10 ? w : ` ${w}`, tOffsetMs: i * 300, acAsrConf: 0 }))
  const json = JSON.stringify({
    events: [
      { tStartMs: 1000, dDurationMs: 8000, wWinId: 1, segs: segs.slice(0, 10) },
      { tStartMs: 4000, dDurationMs: 30, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] },
      { tStartMs: 4000, dDurationMs: 8000, wWinId: 1, segs: segs.slice(10).map(s => ({ ...s, tOffsetMs: s.tOffsetMs - 3000 })) },
      // a pause of more than a second, then a new sentence with punctuation
      { tStartMs: 12000, dDurationMs: 3000, wWinId: 1, segs: [{ utf8: 'Okay.' }, { utf8: ' Let us', tOffsetMs: 400 }, { utf8: ' begin.', tOffsetMs: 700 }] },
    ],
  })
  const cues = parseTrack('https://www.youtube.com/api/timedtext?v=x&kind=asr&fmt=json3', json)
  assert.deepEqual(plain(cues.map(c => c.text)), [
    'so today we are going to talk about how neural',
    'networks learn from data and why that matters for everyone',
    'Okay.',
    'Let us begin.',
  ])
  assert.equal(cues[0].start, 1000)
  assert.equal(cues[0].end, cues[1].start) // a line stays until the next one starts
  assert.ok(cues[1].end < 12000 && cues[1].end > cues[1].start)
  assert.deepEqual(plain(groupSentences(cues)), [[0, 1], [2], [3]])
})

test('reads YouTube srv3 and srv1 XML', () => {
  const srv3 = '<?xml version="1.0"?><timedtext format="3"><body><p t="1000" d="2000">Hello <s>there</s></p><p t="3000" d="1500">it&#39;s me</p></body></timedtext>'
  assert.deepEqual(plain(parseTrack('u', srv3)), [{ start: 1000, end: 3000, text: 'Hello there' }, { start: 3000, end: 4500, text: "it's me" }])
  const srv1 = '<transcript><text start="1.5" dur="2">it&amp;#39;s fine</text></transcript>'
  assert.deepEqual(plain(parseTrack('u', srv1)), [{ start: 1500, end: 3500, text: "it's fine" }])
})

test('groups lines into sentences at punctuation, pauses and a length cap', () => {
  const cue = (start, end, text) => ({ start, end, text })
  const cues = [
    cue(0, 1000, 'When you write code,'),
    cue(1000, 2000, 'you should test it.'),
    cue(2000, 3000, 'no punctuation here'),
    cue(5000, 6000, 'after a long pause'),
    cue(6000, 7000, 'one'), cue(7000, 8000, 'two'), cue(8000, 9000, 'three'), cue(9000, 10000, 'four'), cue(10000, 11000, 'five'),
  ]
  assert.deepEqual(plain(groupSentences(cues)), [[0, 1], [2], [3, 4, 5, 6], [7, 8]])
})

test('splits a sentence translation into one part per line', () => {
  // "<a i=0>When you write code,</a> <a i=1>you should test it.</a>"
  const text = 'Khi bạn viết mã, bạn nên kiểm tra nó.'
  const pieces = [{ start: 0, end: 16, chunk: 0 }, { start: 17, end: 37, chunk: 1 }]
  assert.deepEqual(plain(distribute({ text, pieces }, 2)), ['Khi bạn viết mã,', 'bạn nên kiểm tra nó.'])
  // Words Google left outside the tags stay with the piece before them; reordered pieces still land on their line.
  const reordered = { text: 'Nó, cái mà tôi thấy, rất đẹp', pieces: [{ start: 0, end: 3, chunk: 1 }, { start: 4, end: 19, chunk: 0 }] }
  assert.deepEqual(plain(distribute(reordered, 2)), ['cái mà tôi thấy, rất đẹp', 'Nó,'])
  // A line with no part of the translation: the caller shows the whole sentence instead.
  assert.equal(distribute({ text, pieces: [{ start: 0, end: 37, chunk: 0 }] }, 2), null)
  assert.deepEqual(plain(distribute({ text: 'Xin chào', pieces: [] }, 1)), ['Xin chào'])
})

test('matches on-screen caption text to the file regardless of line breaks', () => {
  assert.equal(keyOf('You know the rules\nand so  do I'), keyOf('You know the rules and so do I'))
})
