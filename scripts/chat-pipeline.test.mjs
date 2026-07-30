#!/usr/bin/env node
// Regression test for the meeting chat pipeline: `npm run test:chat`.
//
// Guards the bug this pipeline was built for — asking about "nadam" when the
// transcript writes "Nadam", 350 lines into a meeting, and being told it was
// never mentioned. OpenAI is stubbed, so this runs offline, in CI, and in a
// second; what it checks is the plumbing (are all three passes wired, does the
// planner's output actually reach retrieval, does a slice that found nothing
// get dropped) and the guarantee that matters most: when OpenAI is unreachable,
// the phonetic layer still puts the buried line in front of the model.
const calls = []
const stubFetch = async (url, init) => {
  const body = JSON.parse(init.body)
  calls.push(body)
  const isPlan = body.response_format?.type === 'json_object'
  const isMap = body.messages[0].content.startsWith('You are reading ONE slice')
  let content
  if (isPlan) {
    content = JSON.stringify({
      resolved: [{ asked: 'nadam', transcript: ['Nadam'], confidence: 'high' }],
      terms: ['Nadam', 'HR tool', 'research bot'],
      scope: 'narrow',
      restated: 'What did Noel say about Nadam?',
    })
  } else if (isMap) {
    const slice = body.messages[1].content
    content = slice.includes('Nadam') ? '- [28:11] Noel Vaz: Asks why Nadam looks incomplete.' : 'NONE'
  } else {
    content = 'final answer'
  }
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }
}

globalThis.fetch = stubFetch
const { buildChatRequest, buildWeeklyChatRequest, chunkTranscript, transcriptVocabulary, videoRowsFromText } = await import('../worker/index.js')

const rows = []
// Realistic filler: 'Routine' opens a sentence, and the same word appears
// lowercase mid-sentence elsewhere — exactly how an ordinary word behaves.
for (let i = 0; i < 400; i++) rows.push({ start_time: i * 5, speaker: 'Aashita Chandel', text: i % 3 ? 'Routine weekly status about the dashboard and the numbers for this sprint.' : 'It was a routine sprint update with nothing much to flag this week.' })
rows[350] = { start_time: 1691, speaker: 'Noel Vaz', text: 'Why is Nadam looking so incomplete?' }
rows[351] = { start_time: 1695, speaker: 'Aashita Chandel', text: 'Nadam majorly works on the HR tool, the research bot, all of that.' }

let pass = 0, fail = 0
const check = (name, cond, extra = '') => { cond ? (pass++, console.log('  ok   ' + name)) : (fail++, console.log('  FAIL ' + name + ' ' + extra)) }

console.log('chunking + vocabulary')
const chunks = chunkTranscript(rows)
check('splits a long meeting into slices', chunks.length > 1, `got ${chunks.length}`)
check('slices cover every line, no gaps', chunks[0][0] === 0 && chunks.at(-1)[1] === rows.length && chunks.every((c, i) => i === 0 || c[0] === chunks[i-1][1]))
const vocab = transcriptVocabulary(rows)
check('vocabulary finds the rare proper noun', vocab.some(v => v.raw === 'Nadam'))
check('drops words the transcript also writes lowercase', !vocab.some(v => v.raw === 'Routine'), JSON.stringify(vocab.map(v=>v.raw)))

console.log('\nfull pipeline')
const built = await buildChatRequest({
  rows,
  history: [{ role: 'user', content: 'discussion about nadam?' }],
  apiKey: 'test', model: 'gpt-4o', planModel: 'gpt-4o-mini',
})
const g = built.messages[1].content
check('pass 1 ran (json mode)', calls.some(c => c.response_format?.type === 'json_object'))
check('pass 1 was shown the vocabulary', calls[0].messages[1].content.includes('Nadam'))
check('pass 2 ran once per slice', calls.filter(c => c.messages[0].content.startsWith('You are reading ONE slice')).length === chunks.length, `chunks=${chunks.length}`)
check('planner terms folded into retrieval', built.trace.terms.includes('hr') && built.trace.terms.includes('bot'), JSON.stringify(built.trace.terms))
check('NAME RESOLUTION in grounding', g.includes('the user’s "nadam"') || g.includes('"nadam" is this transcript\'s "Nadam"'))
check('READING NOTES in grounding', g.includes('READING NOTES') && g.includes('[28:11]'))
check('NONE slices dropped from notes', !built.trace.mapNotes.includes('NONE'))
check('notes label their time range', /From \d+:\d+/.test(built.trace.mapNotes))
check('EVIDENCE has the buried line', g.includes('Why is Nadam looking so incomplete?'))
check('history is last', built.messages.at(-1).content === 'discussion about nadam?')

console.log('\ndegradation when OpenAI is down')
globalThis.fetch = async () => { throw new Error('network down') }
const degraded = await buildChatRequest({ rows, history: [{ role: 'user', content: 'discussion about nadam?' }], apiKey: 'x', model: 'gpt-4o' })
check('still returns messages', degraded.messages.length >= 3)
check('phonetic retrieval still finds Nadam', degraded.messages[1].content.includes('Why is Nadam looking so incomplete?'))
check('no reading notes claimed', !degraded.messages[1].content.includes('READING NOTES'))


// ── Weekly chat — the same three passes, fanned out over meetings ────────────
// Its old design could only see cached summaries, so any detail the summary
// dropped was unanswerable. These assert it now reads the transcripts too.
console.log('\nweekly chat')
globalThis.fetch = stubFetch
calls.length = 0
const otherRows = []
for (let i = 0; i < 120; i++) otherRows.push({ start_time: i * 5, speaker: 'Noel Vaz', text: 'Pricing discussion for the enterprise tier and the renewal timeline.' })
const weekly = await buildWeeklyChatRequest({
  transcripts: [
    { meetingId: 'm1', title: 'Dashboard Review', rows },
    { meetingId: 'm2', title: 'Pricing Sync', rows: otherRows },
  ],
  sources: [{ index: 1, meetingId: 'm1', title: 'Dashboard Review', summary: 'Reviewed the dashboard.' }],
  master: 'A week of dashboard and pricing work.',
  history: [{ role: 'user', content: 'discussion about nadam?' }],
  apiKey: 'test', model: 'gpt-4o', planModel: 'gpt-4o-mini',
})
const wg = weekly.messages[1].content
check('reads transcripts, not just summaries', wg.includes('Why is Nadam looking so incomplete?'))
check('attributes evidence to its meeting', wg.includes('=== Dashboard Review ==='))
check('keeps the summaries as well', wg.includes('A week of dashboard and pricing work'))
check('spends readers on the matching meeting', weekly.trace.meetingsRead >= 1 && weekly.trace.meetingsRead <= 6, String(weekly.trace.meetingsRead))
check('resolves the name across the week', wg.includes('NAME RESOLUTION'))

console.log('\nweekly degradation when OpenAI is down')
globalThis.fetch = async () => { throw new Error('network down') }
const wDegraded = await buildWeeklyChatRequest({
  transcripts: [{ meetingId: 'm1', title: 'Dashboard Review', rows }],
  sources: [], master: 'A week of dashboard work.',
  history: [{ role: 'user', content: 'discussion about nadam?' }],
  apiKey: 'x', model: 'gpt-4o',
})
check('still grounds on the transcript', wDegraded.messages[1].content.includes('Why is Nadam looking so incomplete?'))


// ── Video chat — the same pipeline over a transcript that has no speakers ────
// A video transcript is one unattributed stream, the hardest case for a
// single-call design: no speaker turns to anchor on, nothing to make the
// relevant stretch stand out. These also pin down that teaching the pipeline
// about videos did not change what it does for meetings.
console.log('\nvideo chat')
globalThis.fetch = stubFetch
const timed = ['[00:05] Welcome back to the channel.', '[21:52] Nadam is the one who built the HR tool.', '[22:14] It handles onboarding.'].join('\n')
let vr = videoRowsFromText(timed)
check('parses [MM:SS] lines', vr.length === 3 && vr[1].start_time === 21 * 60 + 52, JSON.stringify(vr[1]))
check('leaves videos speakerless', vr.every((x) => x.speaker === ''))

vr = videoRowsFromText('[01:00] first line\ncontinued with no stamp')
check('untimed line inherits the last offset', vr[1].start_time === 60)

const blob = 'Sentence about things. '.repeat(200)
check('splits an unbroken blob', videoRowsFromText(blob).length > 5, String(videoRowsFromText(blob).length))

const vBuilt = await buildChatRequest({
  rows: videoRowsFromText(timed), history: [{ role: 'user', content: 'what about nadam?' }],
  apiKey: 't', model: 'gpt-4o', kind: 'video', title: 'How we built it', channel: 'Munshot',
  seedPrompt: 'brief me',
})
const vg = vBuilt.messages[1].content
check('uses the video system prompt', vBuilt.messages[0].content.startsWith('You are the analyst for ONE video'))
check('labels it VIDEO with its channel', vg.includes('VIDEO: How we built it') && vg.includes('CHANNEL: Munshot'))
check('no "Unknown:" noise on video lines', !vg.includes('Unknown:'))
check('finds the name in the video', vg.includes('Nadam is the one who built the HR tool'))

const seeded = await buildChatRequest({ rows: videoRowsFromText(timed), history: [], apiKey: 't', model: 'gpt-4o', kind: 'video', seedPrompt: 'brief me' })
check('video seed replaces the per-person one', seeded.messages.at(-1).content === 'brief me')

// Meetings must be untouched by the video parameterisation.
const meetingRows = [{ start_time: 10, speaker: null, text: 'Something said by nobody labelled.' }]
const mBuilt = await buildChatRequest({ rows: meetingRows, history: [{ role: 'user', content: 'what?' }], apiKey: 't', model: 'gpt-4o' })
check('meeting keeps Unknown for unlabelled rows', mBuilt.messages[1].content.includes('Unknown:'))
check('meeting keeps its own system prompt', mBuilt.messages[0].content.startsWith('You are the analyst for ONE recorded meeting'))


console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
