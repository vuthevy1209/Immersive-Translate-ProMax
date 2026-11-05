// Run with: node --test test/*.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const context = {}
vm.runInNewContext(readFileSync(new URL('../src/translator.js', import.meta.url), 'utf8'), context)
const { buildMarked, parseMarked, parseLookup } = context.IPMTranslator

// Each chunk id with the text it covers, copied out of the vm realm for deepEqual.
const spans = ({ text, pieces }) => Array.from(pieces, p => [p.chunk, text.slice(p.start, p.end)])

test('wraps chunks in numbered tags and escapes HTML', () => {
  assert.equal(buildMarked(['Hi <you>,', 'Tom & Jerry.']), '<a i=0>Hi &lt;you&gt;,</a> <a i=1>Tom &amp; Jerry.</a>')
})

test('reads back the text and the span of each chunk', () => {
  const result = parseMarked('<a i=0>Tuy nhiên,</a> <a i=1>vào năm 2020,</a> <a i=2>công ty đã chuyển trụ sở.</a>')
  assert.equal(result.text, 'Tuy nhiên, vào năm 2020, công ty đã chuyển trụ sở.')
  assert.deepEqual(spans(result), [[0, 'Tuy nhiên,'], [1, 'vào năm 2020,'], [2, 'công ty đã chuyển trụ sở.']])
})

test('handles reordered, missing and repeated chunks', () => {
  assert.deepEqual(spans(parseMarked('<a i=1>B</a> và <a i=0>A</a>')), [[1, 'B'], [0, 'A']])
  assert.deepEqual(spans(parseMarked('<a i=0>A</a> B không có thẻ')), [[0, 'A']])
  assert.deepEqual(spans(parseMarked('<a i=0>A</a> <a i=1>B</a> <a i=0>C</a>')), [[0, 'A'], [1, 'B'], [0, 'C']])
})

test('nested tags belong to the innermost chunk', () => {
  const result = parseMarked('<a i=0>đầu <a i=1>giữa</a> cuối</a>')
  assert.equal(result.text, 'đầu giữa cuối')
  assert.deepEqual(spans(result), [[0, 'đầu'], [1, 'giữa'], [0, 'cuối']])
})

test('decodes entities, drops zero-width spaces and unknown tags', () => {
  const result = parseMarked('<a i=0>“Họ sẽ bán chứ?” &lt;lặng lẽ&gt; &amp; it&#39;s kiến ​​trúc <b>sư</b></a>')
  assert.equal(result.text, '“Họ sẽ bán chứ?” <lặng lẽ> & it\'s kiến trúc sư')
  assert.deepEqual(spans(result), [[0, result.text]])
})

test('plain text without tags still parses', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(parseMarked('  Xin chào.  '))), { text: 'Xin chào.', pieces: [] })
})

test('shapes a dictionary lookup for a single word', () => {
  const result = parseLookup({
    sentences: [{ trans: 'cứu hộ', orig: 'salvage' }, { src_translit: 'ˈsalvij' }],
    dict: [
      { pos: 'danh từ', terms: ['tài sản cứu được', 'vật lấy ra được'] },
      { pos: 'động từ', terms: ['cứu vớt', 'cứu tàu khỏi chìm', 'a', 'b', 'c', 'd', 'e'] },
    ],
    definitions: [{ pos: 'động từ', entry: [{ gloss: 'rescue (a wrecked ship) from loss at sea.', example: 'a cross was salvaged from the wreck' }] }],
    src: 'en',
  })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    translation: 'cứu hộ',
    phonetic: 'ˈsalvij',
    source: 'en',
    meanings: [
      { pos: 'danh từ', terms: ['tài sản cứu được', 'vật lấy ra được'] },
      { pos: 'động từ', terms: ['cứu vớt', 'cứu tàu khỏi chìm', 'a', 'b', 'c', 'd'] },
    ],
    definitions: [{ pos: 'động từ', gloss: 'rescue (a wrecked ship) from loss at sea.', example: 'a cross was salvaged from the wreck' }],
  })
})

test('a phrase lookup joins the translated pieces and has no dictionary part', () => {
  const result = parseLookup({ sentences: [{ trans: 'Xin chào. ' }, { trans: 'Tạm biệt.' }], src: 'en' })
  assert.equal(result.translation, 'Xin chào. Tạm biệt.')
  assert.equal(result.meanings.length + result.definitions.length, 0)
})
