#!/usr/bin/env node
// Run the meeting chat against a transcript file, outside Cloudflare.
//
// The point is to be able to answer "did that actually change anything?" without
// a deploy: this imports the real pipeline from worker/index.js, so what you see
// here is what the Worker does.
//
//   # what the model will be given — no API key needed, no calls made, free
//   node scripts/chat-eval.mjs transcript.txt "what did noel say about nadam?"
//
//   # the same, plus the passes that need OpenAI and the final answer
//   OPENAI_API_KEY=sk-... node scripts/chat-eval.mjs transcript.txt "…" --answer
//
//   --grounding   print the full text handed to the answering call
//   --model=NAME  override the model (default gpt-4o)
//
// The transcript file is either:
//   - lines of "[MM:SS] Speaker: text" — copy them straight out of the
//     Transcript tab, which is the fastest way to reproduce a bad answer; or
//   - JSON: [{"start_time": 1691, "speaker": "Noel Vaz", "text": "…"}, …]

import { readFileSync } from "node:fs";
import { buildChatRequest, openaiChat } from "../worker/index.js";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const modelFlag = args.find((a) => a.startsWith("--model="));
const [file, ...rest] = args.filter((a) => !a.startsWith("--"));
const question = rest.join(" ");

if (!file) {
  console.error("usage: node scripts/chat-eval.mjs <transcript-file> \"<question>\" [--answer] [--grounding]");
  process.exit(2);
}

const model = modelFlag ? modelFlag.slice("--model=".length) : "gpt-4o";
const apiKey = process.env.OPENAI_API_KEY || process.env.OPEN_AI_API_KEY || "";
const wantsCalls = flags.has("--answer");

/** "[MM:SS] Speaker: text" or "MM:SS<tab>Speaker<tab>text" → transcript rows. */
function parseTranscript(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.includes('"text"')) return JSON.parse(trimmed);
  const rows = [];
  for (const line of trimmed.split("\n")) {
    const m = /^\s*\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?[\s\t]+([^:\t]{1,60}?)[:\t]\s*(.*)$/.exec(line);
    if (!m) {
      // A continuation of the previous speaker's turn.
      if (rows.length && line.trim()) rows[rows.length - 1].text += ` ${line.trim()}`;
      continue;
    }
    const secs = m[1].split(":").map(Number).reduce((acc, n) => acc * 60 + n, 0);
    rows.push({ start_time: secs, speaker: m[2].trim(), text: m[3].trim() });
  }
  return rows;
}

const rows = parseTranscript(readFileSync(file, "utf8"));
if (!rows.length) {
  console.error(`No transcript lines parsed from ${file}. Expected "[MM:SS] Speaker: text" lines or JSON rows.`);
  process.exit(1);
}

const history = question ? [{ role: "user", content: question }] : [];
// Without a key (or without --answer) the two model-assisted passes are skipped
// by the pipeline's own error handling, and you still see the phonetic
// retrieval, the vocabulary, and the evidence — which is where the "not
// mentioned" bug lived.
const built = await buildChatRequest({
  rows,
  history,
  apiKey: wantsCalls ? apiKey : "",
  model,
  planModel: process.env.OPENAI_FAST_MODEL || model,
});
const t = built.trace;

const rule = (s) => console.log(`\n${"─".repeat(78)}\n${s}\n`);

console.log(`transcript : ${file} — ${t.lines} lines, ${t.chunksTotal} slice(s)`);
console.log(`question   : ${question || "(none — would seed a per-person recap)"}`);
console.log(`search     : ${t.terms.join(", ") || "(none)"}`);
console.log(`vocabulary : ${t.vocabularySample.slice(0, 25).join(", ")}`);

if (t.plan.resolved.length) {
  rule("PASS 1 — the question resolved against the transcript's own spellings");
  for (const r of t.plan.resolved) {
    console.log(`  "${r.asked}" → ${(r.transcript || []).map((x) => `"${x}"`).join(" / ")} (${r.confidence})`);
  }
  if (t.plan.restated) console.log(`  restated: ${t.plan.restated}`);
  console.log(`  scope: ${t.plan.scope}`);
} else if (wantsCalls) {
  rule("PASS 1 — resolved nothing (no vocabulary entry plausibly matched)");
}

if (t.mapNotes) {
  rule(`PASS 2 — read ${t.chunksRead}/${t.chunksTotal} slices end to end`);
  console.log(t.mapNotes);
} else if (t.chunksTotal > 1 && wantsCalls) {
  rule(`PASS 2 — read ${t.chunksRead}/${t.chunksTotal} slices, found nothing relevant`);
}

// The deterministic layer: this runs with or without an API key, and is what
// makes a wrong "not mentioned" hard to reach.
const evidence = /EVIDENCE[^\n]*\n([\s\S]*?)(?:\n\n[A-Z]{2,}|$)/.exec(t.grounding);
rule("PHONETIC RETRIEVAL — matched lines (no model involved)");
console.log(evidence ? evidence[1] : "  (nothing matched)");

const matches = /TERM MATCHES[^\n]*\n(?:[^\n]*\n)*?((?:- [^\n]*\n?)+)/.exec(t.grounding);
if (matches) {
  rule("SPELLINGS FOUND");
  console.log(matches[1].trimEnd());
}

if (flags.has("--grounding")) {
  rule("FULL GROUNDING — everything the answering call receives");
  console.log(t.grounding);
}

if (wantsCalls) {
  if (!apiKey) {
    console.error("\n--answer needs OPENAI_API_KEY in the environment.");
    process.exit(1);
  }
  rule("PASS 3 — the answer");
  console.log(await openaiChat(apiKey, model, built.messages, 1600, 0.2));
} else {
  console.log("\nRe-run with --answer (and OPENAI_API_KEY set) to run passes 1–3 and print the reply.");
}
