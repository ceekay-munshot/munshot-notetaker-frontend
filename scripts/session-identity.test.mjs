#!/usr/bin/env node
// Regression test for host-token identity: `npm run test:session`.
//
// Guards the bug this was written for — a user who had genuinely been in
// meetings signing in and seeing NOTHING: no meetings, no search results, no
// error. Two independent causes produce that same blank screen, and both live
// here:
//
//   1. The Worker and the browser disagreed about which JWT claim carries the
//      email. The Worker's exchange 400s, the SPA proceeds anyway, so there is
//      no session cookie and every /api/* call 401s — while the UI still shows
//      the user as signed in. src/lib/hostClaims.js is now the single reader
//      both sides use.
//   2. Visibility is exact string equality against owner_email, so the session
//      has to be keyed on precisely the address the meeting is filed under.
//      createSession/getSession must round-trip that address unchanged through
//      both stored shapes, and must never let a user session read as admin.
//
// Runs offline in a second — no bindings, no network; KV is a Map.

import assert from 'node:assert/strict'
import {
  EMAIL_CLAIMS,
  ORG_ID_CLAIMS,
  claimNames,
  decodeJwtPayload,
  looksLikeEmail,
  readEmailClaim,
  readOrgIdClaim,
} from '../src/lib/hostClaims.js'

const { createSession, getSession, emailLocalKey, maskEmail } = await import('../worker/index.js')

let passed = 0
let failed = 0
let group = ''

function describe(name) {
  group = name
  console.log(`\n${name}`)
}
async function it(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL ${name}\n       ${err && err.message}`)
  }
}

/** A JWT with the given payload. The signature is never checked, so "x"/"y" do. */
function token(payload) {
  return `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`
}

const claimsOf = (payload) => decodeJwtPayload(token(payload))

// ── The claim reader ─────────────────────────────────────────────────────────

describe('email claim')

await it('reads the standard `email` claim', () => {
  assert.equal(readEmailClaim(claimsOf({ email: 'nvaz51000@gmail.com' })), 'nvaz51000@gmail.com')
})

await it('reads every accepted spelling, not just `email`', () => {
  for (const key of EMAIL_CLAIMS) {
    assert.equal(readEmailClaim(claimsOf({ [key]: 'a@b.com' })), 'a@b.com', `claim ${key}`)
  }
})

await it('falls back to `sub` when it is an address', () => {
  assert.equal(readEmailClaim(claimsOf({ sub: 'a@b.com' })), 'a@b.com')
})

await it('does NOT adopt an opaque `sub` as an identity', () => {
  // Keying a session to "usr_8f21" would mint a session no meeting is ever
  // filed under — an empty dashboard with no error, which is the whole bug.
  assert.equal(readEmailClaim(claimsOf({ sub: 'usr_8f21' })), null)
})

await it('prefers `email` over a lower-priority spelling', () => {
  const c = claimsOf({ upn: 'work@corp.com', email: 'personal@gmail.com' })
  assert.equal(readEmailClaim(c), 'personal@gmail.com')
})

await it('ignores a present-but-malformed email claim', () => {
  assert.equal(readEmailClaim(claimsOf({ email: 'not-an-address' })), null)
})

await it('preserves case and does not normalize (callers do)', () => {
  // The Worker lower-cases via normalizeEmail before querying; the UI shows the
  // address as the host spelled it. Folding case here would hide a mismatch.
  assert.equal(readEmailClaim(claimsOf({ email: 'Naval@Munshot.com' })), 'Naval@Munshot.com')
})

await it('trims surrounding whitespace', () => {
  assert.equal(readEmailClaim(claimsOf({ email: '  a@b.com  ' })), 'a@b.com')
})

describe('org id claim')

await it('reads every accepted spelling', () => {
  for (const key of ORG_ID_CLAIMS) {
    assert.equal(readOrgIdClaim(claimsOf({ [key]: 'org_9' })), 'org_9', `claim ${key}`)
  }
})

await it('accepts a NUMERIC org id', () => {
  // The old reader tested `typeof payload.orgId === 'string'`, so a numeric org
  // id read as absent — the org was silently unknowable.
  assert.equal(readOrgIdClaim(claimsOf({ orgId: 42 })), '42')
})

await it('is null when the token carries no org', () => {
  assert.equal(readOrgIdClaim(claimsOf({ email: 'a@b.com' })), null)
})

describe('decoding')

await it('returns null for malformed input instead of throwing', () => {
  for (const bad of [null, undefined, '', 'nope', 'a.b', 'a.!!!.c', 'a.b.c.d']) {
    assert.equal(decodeJwtPayload(bad), null, `input ${JSON.stringify(bad)}`)
  }
})

await it('rejects a payload that is not an object', () => {
  assert.equal(decodeJwtPayload(token(['a'])), null)
  assert.equal(decodeJwtPayload(token('str')), null)
})

await it('decodes non-ASCII payloads as UTF-8', () => {
  assert.equal(readEmailClaim(claimsOf({ email: 'josé@exämple.com' })), 'josé@exämple.com')
})

await it('reports claim NAMES only, never values', () => {
  const names = claimNames(claimsOf({ email: 'a@b.com', orgId: 'org_9', secret: 'shh' }))
  assert.deepEqual(names, ['email', 'orgId', 'secret'])
  assert.ok(!JSON.stringify(names).includes('shh'))
})

await it('looksLikeEmail matches the Worker\'s own isValidEmail shape', () => {
  assert.ok(looksLikeEmail('a@b.co'))
  assert.ok(!looksLikeEmail('a@b'))
  assert.ok(!looksLikeEmail('a b@c.com'))
  assert.ok(!looksLikeEmail(42))
})

// ── Session round-trip ───────────────────────────────────────────────────────

/** Fake KV + a request carrying the cookie createSession just handed back. */
function fakeEnv() {
  const store = new Map()
  return {
    store,
    KV: {
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => void store.set(k, v),
    },
  }
}
function requestWith(cookie) {
  const token = /session=([^;]+)/.exec(cookie)[1]
  return { headers: new Headers({ Cookie: `session=${token}` }), token }
}
async function roundTrip(env, email, orgId) {
  const req = requestWith(await createSession(env, email, orgId))
  return { session: await getSession(req, env), stored: env.store.get(`session:${req.token}`) }
}

describe('session round-trip')

await it('a password login stores the bare email, unchanged', async () => {
  const env = fakeEnv()
  const { session, stored } = await roundTrip(env, 'nvaz51000@gmail.com')
  assert.equal(stored, 'nvaz51000@gmail.com') // still human-debuggable in KV
  assert.equal(session.identity, 'nvaz51000@gmail.com')
  assert.equal(session.isAdmin, false)
  assert.equal(session.orgId, null)
})

await it('a host login carries the org id without disturbing the email', async () => {
  const env = fakeEnv()
  const { session } = await roundTrip(env, 'nvaz51000@gmail.com', 'org_42')
  assert.equal(session.identity, 'nvaz51000@gmail.com') // what visibility keys on
  assert.equal(session.orgId, 'org_42')
  assert.equal(session.isAdmin, false)
})

await it('reads a legacy bare-string session written before orgId existed', async () => {
  // Sessions already live in KV with a 7-day TTL; the new read path must not
  // sign everyone out on deploy.
  const env = fakeEnv()
  env.store.set('session:legacy', 'old@user.com')
  const session = await getSession({ headers: new Headers({ Cookie: 'session=legacy' }) }, env)
  assert.equal(session.identity, 'old@user.com')
  assert.equal(session.isAdmin, false)
  assert.equal(session.orgId, null)
})

await it('still reads an admin session as admin', async () => {
  const env = fakeEnv()
  env.store.set('session:adm', JSON.stringify({ admin: true, name: 'ADMIN' }))
  const session = await getSession({ headers: new Headers({ Cookie: 'session=adm' }) }, env)
  assert.equal(session.isAdmin, true)
  assert.equal(session.identity, 'ADMIN')
})

await it('a user session never reads as admin, whatever the email says', async () => {
  const env = fakeEnv()
  for (const email of ['{"admin":true}@x.com', 'admin@munshot.com', '{}']) {
    const { session } = await roundTrip(env, email, 'org_1')
    assert.equal(session.isAdmin, false, `email ${email}`)
    assert.equal(session.identity, email)
  }
})

await it('no cookie, unknown token, and empty value all resolve to no session', async () => {
  const env = fakeEnv()
  assert.equal(await getSession({ headers: new Headers() }, env), null)
  assert.equal(await getSession({ headers: new Headers({ Cookie: 'session=ghost' }) }, env), null)
  env.store.set('session:blank', '')
  assert.equal(await getSession({ headers: new Headers({ Cookie: 'session=blank' }) }, env), null)
})

// ── Near-miss diagnostics ────────────────────────────────────────────────────

describe('near-miss address matching')

await it('folds Gmail dots and +tags so an alias is spotted as the same person', () => {
  // These are three DIFFERENT owners to the visibility check (normalizeEmail
  // only trims and lower-cases) — which is exactly why they must be surfaced.
  const key = emailLocalKey('nvaz51000@gmail.com')
  assert.equal(emailLocalKey('n.vaz51000@gmail.com'), key)
  assert.equal(emailLocalKey('nvaz51000+work@gmail.com'), key)
  assert.notEqual(emailLocalKey('naval@gmail.com'), key)
})

await it('masks a local part but keeps the domain readable', () => {
  assert.equal(maskEmail('naval@munshot.com'), 'n***l@munshot.com')
  assert.equal(maskEmail('ab@x.com'), 'a*@x.com')
  assert.equal(maskEmail('a@x.com'), 'a@x.com')
  assert.equal(maskEmail('bogus'), '***')
})

await it('never leaks a full local part', () => {
  for (const email of ['naval@munshot.com', 'aashita@munshot.com', 'nvaz51000@gmail.com']) {
    const masked = maskEmail(email)
    assert.ok(!masked.includes(email.split('@')[0]), `${masked} leaked ${email}`)
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
