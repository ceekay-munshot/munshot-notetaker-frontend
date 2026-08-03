#!/usr/bin/env node
// Regression test for the summary/chat Markdown parser: `npm run test:format`.
//
// Guards the bug this was written for — a chat answer rendering
// "## Dashboard Features Demonstrated" on screen, hashes and all. The parser
// only ever recognised a header written as a lone **Bold** line, so an ATX
// heading fell through to the paragraph path and no later stage stripped a
// character the parser had never claimed.
//
// The same parse also decides ORDER. `paras` and `bullets` are two filtered
// passes over one block, so reading them puts every bullet after every
// paragraph however the author interleaved them; `nodes` is the ordered view.
//
// The parser is TypeScript, so this runs it through esbuild (already present as
// a Vite dependency) rather than importing the .ts directly.

import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { transformSync } from 'esbuild'

const SRC = new URL('../src/lib/summaryFormat.ts', import.meta.url)
const OUT = new URL('../node_modules/.cache/summary-format.test.mjs', import.meta.url)
mkdirSync(new URL('./', OUT), { recursive: true })
writeFileSync(
  OUT,
  transformSync(readFileSync(SRC, 'utf8'), { loader: 'ts', format: 'esm' }).code,
)
const { parseSummaryBlock, groupSummaryNodes, splitBulletLabel } = await import(OUT.href)

let passed = 0
let failed = 0
function describe(name) {
  console.log(`\n${name}`)
}
function it(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL ${name}\n       ${err && err.message}`)
  }
}

// ── Headings ─────────────────────────────────────────────────────────────────

describe('ATX headings')

it('reads "## Heading" as a header, not as prose', () => {
  // The exact line from the reported screenshot.
  const b = parseSummaryBlock('## Dashboard Features Demonstrated')
  assert.equal(b.header, 'Dashboard Features Demonstrated')
  assert.equal(b.headerLevel, 2)
  assert.deepEqual(b.nodes, [])
})

it('never leaves a hash anywhere a renderer would print it', () => {
  const block = '### Section\n\nSome prose.\n- A bullet'
  const b = parseSummaryBlock(block)
  const printed = [b.header, ...b.paras, ...b.bullets].join(' ')
  assert.ok(!printed.includes('#'), `hash survived in: ${printed}`)
})

it('accepts every heading level', () => {
  for (let n = 1; n <= 6; n++) {
    const b = parseSummaryBlock(`${'#'.repeat(n)} Title`)
    assert.equal(b.header, 'Title', `level ${n}`)
    assert.equal(b.headerLevel, n)
  }
})

it('still reads the **Bold** header form', () => {
  const b = parseSummaryBlock('**Meeting Summary**\n\nProse.')
  assert.equal(b.header, 'Meeting Summary')
  assert.equal(b.headerLevel, null)
  assert.equal(b.isSection, true) // known section title → renders with a rule
})

it('strips bold inside a heading so asterisks never print', () => {
  // Headers are rendered as raw text, so "## **Title**" would show its stars.
  assert.equal(parseSummaryBlock('## **Key Topics**').header, 'Key Topics')
})

it('honours the closing hashes ATX allows', () => {
  assert.equal(parseSummaryBlock('## Title ##').header, 'Title')
})

it('leaves a hash that is not a heading alone', () => {
  // No space after the hashes → not a heading. "#1 priority" is prose.
  const b = parseSummaryBlock('#1 priority is the calendar')
  assert.equal(b.header, null)
  assert.deepEqual(b.paras, ['#1 priority is the calendar'])
})

it('treats a mid-block heading as a heading, not a paragraph', () => {
  const b = parseSummaryBlock('Intro line.\n## Later Heading\nMore prose.')
  assert.equal(b.header, null)
  assert.deepEqual(b.nodes.map((n) => n.kind), ['para', 'heading', 'para'])
  assert.equal(b.nodes[1].text, 'Later Heading')
})

it('does not mistake a bullet for a heading', () => {
  const b = parseSummaryBlock('- ## not a heading')
  assert.equal(b.header, null)
  assert.deepEqual(b.bullets, ['## not a heading'])
})

// ── Order ────────────────────────────────────────────────────────────────────

describe('document order')

it('keeps interleaved paragraphs and bullets in the order written', () => {
  const b = parseSummaryBlock('First para.\n- bullet A\nSecond para.\n- bullet B')
  assert.deepEqual(
    b.nodes.map((n) => n.text),
    ['First para.', 'bullet A', 'Second para.', 'bullet B'],
  )
  // The legacy filtered views re-order — which is exactly why nodes exists.
  assert.deepEqual(b.paras, ['First para.', 'Second para.'])
  assert.deepEqual(b.bullets, ['bullet A', 'bullet B'])
})

it('groups consecutive bullets into one list, splitting on prose', () => {
  const groups = groupSummaryNodes(parseSummaryBlock('- a\n- b\nprose\n- c').nodes)
  assert.deepEqual(
    groups.map((g) => g.kind),
    ['list', 'para', 'list'],
  )
  assert.deepEqual(groups[0].items, ['a', 'b'])
  assert.deepEqual(groups[2].items, ['c'])
})

// ── Lists ────────────────────────────────────────────────────────────────────

describe('lists')

it('marks a numbered list as ordered so its sequence survives', () => {
  const b = parseSummaryBlock('1. first\n2. second')
  assert.deepEqual(b.bullets, ['first', 'second'])
  assert.ok(b.nodes.every((n) => n.ordered))
})

it('keeps unordered markers unordered', () => {
  for (const marker of ['-', '*', '•']) {
    const b = parseSummaryBlock(`${marker} item`)
    assert.deepEqual(b.bullets, ['item'], `marker ${marker}`)
    assert.equal(b.nodes[0].ordered, false, `marker ${marker}`)
  }
})

it('does not split an ordered and an unordered run into one list', () => {
  const groups = groupSummaryNodes(parseSummaryBlock('1. a\n- b').nodes)
  assert.deepEqual(groups.map((g) => g.ordered), [true, false])
})

it('leaves a bold bullet label intact for splitBulletLabel', () => {
  const b = parseSummaryBlock('- **Data Correction:** fix the feed')
  assert.deepEqual(splitBulletLabel(b.bullets[0]), { label: 'Data Correction', text: 'fix the feed' })
})

// ── Shape the export renderers rely on ───────────────────────────────────────

describe('back-compat')

it('a plain prose block is unchanged', () => {
  const b = parseSummaryBlock('Just a sentence.')
  assert.equal(b.header, null)
  assert.deepEqual(b.paras, ['Just a sentence.'])
  assert.deepEqual(b.bullets, [])
})

it('an empty block yields empty everything, not a crash', () => {
  for (const input of ['', '   ', '\n\n']) {
    const b = parseSummaryBlock(input)
    assert.equal(b.header, null)
    assert.deepEqual(b.nodes, [])
  }
})

it('paras + bullets still cover every line after the header', () => {
  const block = '**Header**\nprose one\n- b1\n## mid\nprose two\n- b2'
  const b = parseSummaryBlock(block)
  assert.equal(b.paras.length + b.bullets.length, b.nodes.length)
})

// ── The reported answer, end to end ──────────────────────────────────────────

describe('the reported answer')

it('renders the screenshot\'s answer with no literal markdown left', () => {
  const answer = [
    'Aashita presented updates on an **events calendar dashboard** she had been developing.',
    '## Dashboard Features Demonstrated',
    '**Events Calendar Interface** [1:06:25]\n- Showed extensive UI changes\n- Demonstrated the earnings density feature',
  ].join('\n\n')

  const groups = answer
    .split(/\n{2,}/)
    .map((block) => parseSummaryBlock(block.trim()))

  assert.equal(groups[1].header, 'Dashboard Features Demonstrated')
  // Nothing a renderer prints as-is may still carry a hash.
  for (const b of groups) {
    if (b.header) assert.ok(!b.header.includes('#'), `header kept a hash: ${b.header}`)
  }
  // The bullets stay attached to the block they were written under.
  assert.deepEqual(groups[2].bullets, [
    'Showed extensive UI changes',
    'Demonstrated the earnings density feature',
  ])
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
