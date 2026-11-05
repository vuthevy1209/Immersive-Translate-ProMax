// Run with: node --test test/*.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const context = {}
vm.runInNewContext(readFileSync(new URL('../src/segment.js', import.meta.url), 'utf8'), context)
const { splitSentences, splitChunks, looksTranslatable } = context.IPMSegment

const split = text => Array.from(splitSentences(text), s => s.text) // copy out of the vm realm for deepEqual
const chunks = text => Array.from(splitChunks(text), c => c.text)

test('cuts a sentence into chunks at commas', () => {
  assert.deepEqual(
    chunks('Faced with a structure that could no longer be salvaged, Ngo Dinh Diem, then President of the Republic of Vietnam, ordered the building demolished.'),
    ['Faced with a structure that could no longer be salvaged,', 'Ngo Dinh Diem,', 'then President of the Republic of Vietnam,', 'ordered the building demolished.'])
  assert.deepEqual(chunks('Pieces by Chloe Delgado, Omar Berg, and Marcus Petrov.'), ['Pieces by Chloe Delgado,', 'Omar Berg,', 'and Marcus Petrov.'])
  assert.deepEqual(chunks('Bring your catalogue; registration is free.'), ['Bring your catalogue;', 'registration is free.'])
})

test('keeps numbers, quotes and parentheses together', () => {
  assert.deepEqual(chunks('It sold for $2,500,000 in total.'), ['It sold for $2,500,000 in total.'])
  assert.deepEqual(chunks('"Yes," he said quietly.'), ['"Yes,"', 'he said quietly.'])
  assert.deepEqual(chunks('Bring fruit (e.g., apples, pears) to the picnic.'), ['Bring fruit (e.g., apples, pears) to the picnic.'])
})

test('a sentence without commas is one chunk, and offsets point into it', () => {
  assert.deepEqual(chunks('Doors close at noon.'), ['Doors close at noon.'])
  const sentence = 'However, in 2020, the firm moved.'
  for (const c of splitChunks(sentence)) assert.equal(sentence.slice(c.start, c.end), c.text)
})

test('keeps a plain paragraph as separate sentences', () => {
  assert.deepEqual(split('It costs $2.5 million. That is a lot!  Is it?'), ['It costs $2.5 million.', 'That is a lot!', 'Is it?'])
})

test('does not split after titles', () => {
  assert.deepEqual(split('Mr. Petrov lived in Madrid. Dr. Smith did not.'), ['Mr. Petrov lived in Madrid.', 'Dr. Smith did not.'])
  assert.deepEqual(split('Call ext. 204 for info. No. 5 is ready.'), ['Call ext. 204 for info.', 'No. 5 is ready.'])
})

test('handles initials and initialisms', () => {
  assert.deepEqual(split('J. K. Rowling wrote it. St. Louis is big.'), ['J. K. Rowling wrote it.', 'St. Louis is big.'])
  assert.deepEqual(split('He joined the U.S. Army last year. Then he left.'), ['He joined the U.S. Army last year.', 'Then he left.'])
  assert.deepEqual(split('She moved to the U.S. The weather was cold.'), ['She moved to the U.S.', 'The weather was cold.'])
})

test('keeps abbreviations that end a sentence', () => {
  assert.deepEqual(split('The office opens at 8 a.m. Please be early.'), ['The office opens at 8 a.m.', 'Please be early.'])
  assert.deepEqual(split('He lives on Main St. The house is old.'), ['He lives on Main St.', 'The house is old.'])
})

test('joins a quote with the lowercase words after it', () => {
  assert.deepEqual(split('"Is it done?" she asked. "Yes." He nodded!'), ['"Is it done?" she asked.', '"Yes."', 'He nodded!'])
})

test('attaches a bare number label to its sentence', () => {
  assert.deepEqual(split('154. What is NOT indicated about Marcus Petrov?'), ['154. What is NOT indicated about Marcus Petrov?'])
})

test('offsets point back into the source text', () => {
  const text = '  First one.   Second one.  '
  for (const s of splitSentences(text)) assert.equal(text.slice(s.start, s.end), s.text)
})

test('skips text that is not worth translating', () => {
  assert.equal(looksTranslatable('Regional collectors are eager.', 'vi'), true)
  assert.equal(looksTranslatable('$2,500,000', 'vi'), false)
  assert.equal(looksTranslatable('12:30', 'vi'), false)
  assert.equal(looksTranslatable('https://example.com/a/b', 'vi'), false)
  assert.equal(looksTranslatable('Ông ấy đã sáng tác vô số bức tranh trong đời.', 'vi'), false)
  assert.equal(looksTranslatable('Ông ấy đã sáng tác vô số bức tranh trong đời.', 'en'), true)
  assert.equal(looksTranslatable('She ordered a café latte at the hotel.', 'vi'), true)
})
