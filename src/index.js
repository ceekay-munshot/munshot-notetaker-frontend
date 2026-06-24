// Munshot Notetaker — Cloudflare Worker
// - KV-backed logins (one user = one `user:<email>` key)
// - KV-backed sessions via HttpOnly cookie
// - A meeting form that proxies to the munshot /public/join endpoint,
//   injecting the API key server-side so it never reaches the browser.

const COOKIE_NAME = "session";
const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days
const DEFAULT_JOIN_ENDPOINT =
  "https://save-robert-monitors-plugin.trycloudflare.com/public/join";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    try {
      if (method === "GET" && pathname === "/") return handleHome(request, env);
      if (method === "GET" && pathname === "/dashboard") return handleDashboard(request, env);
      if (method === "POST" && pathname === "/api/register") return handleRegister(request, env);
      if (method === "POST" && pathname === "/api/login") return handleLogin(request, env);
      if (method === "POST" && pathname === "/api/logout") return handleLogout(request, env);
      if (method === "POST" && pathname === "/api/join") return handleJoin(request, env);
      return new Response("Not found", { status: 404 });
    } catch (err) {
      return json({ error: "Server error", detail: String(err && err.message || err) }, 500);
    }
  },
};

/* ------------------------------ routes ------------------------------ */

async function handleHome(request, env) {
  if (await getSessionEmail(request, env)) {
    return Response.redirect(new URL("/dashboard", request.url).toString(), 302);
  }
  return html(loginPage({ codeRequired: !!env.SIGNUP_CODE }));
}

async function handleDashboard(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) return Response.redirect(new URL("/", request.url).toString(), 302);
  return html(dashboardPage(email));
}

async function handleRegister(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");

  if (!email || !password) return json({ error: "Email and password are required" }, 400);
  if (!isValidEmail(email)) return json({ error: "Enter a valid email address" }, 400);
  if (password.length < 6) return json({ error: "Password must be at least 6 characters" }, 400);
  if (env.SIGNUP_CODE && body.code !== env.SIGNUP_CODE) {
    return json({ error: "Invalid signup code" }, 403);
  }

  if (await env.KV.get(`user:${email}`)) {
    return json({ error: "An account with that email already exists" }, 409);
  }

  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const user = {
    email,
    salt: toHex(saltBytes),
    hash: await deriveHash(password, saltBytes),
    createdAt: Date.now(),
  };
  await env.KV.put(`user:${email}`, JSON.stringify(user));

  const cookie = await createSession(env, email);
  return json({ ok: true, email }, 200, { "Set-Cookie": cookie });
}

async function handleLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");
  if (!email || !password) return json({ error: "Email and password are required" }, 400);

  const raw = await env.KV.get(`user:${email}`);
  if (!raw) return json({ error: "Invalid email or password" }, 401);

  const user = JSON.parse(raw);
  const hash = await deriveHash(password, fromHex(user.salt));
  if (!timingSafeEqual(hash, user.hash)) {
    return json({ error: "Invalid email or password" }, 401);
  }

  const cookie = await createSession(env, email);
  return json({ ok: true, email }, 200, { "Set-Cookie": cookie });
}

async function handleLogout(request, env) {
  const token = parseCookies(request)[COOKIE_NAME];
  if (token) await env.KV.delete(`session:${token}`);
  return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
}

async function handleJoin(request, env) {
  const email = await getSessionEmail(request, env);
  if (!email) return json({ error: "Not authenticated" }, 401);

  const body = await request.json().catch(() => ({}));
  const meetingUrl = String(body.meeting_url || "").trim();
  const sendEmail = normalizeEmail(body.email) || email;

  if (!meetingUrl) return json({ error: "Meeting URL is required" }, 400);
  try {
    new URL(meetingUrl);
  } catch {
    return json({ error: "Enter a valid meeting URL" }, 400);
  }
  if (!env.API_KEY) {
    return json({ error: "Server is missing the API_KEY secret" }, 500);
  }

  const endpoint = env.JOIN_ENDPOINT || DEFAULT_JOIN_ENDPOINT;
  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "X-API-Key": env.API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: sendEmail, meeting_url: meetingUrl }),
    });
  } catch (err) {
    return json({ error: "Failed to reach the notetaker service", detail: String(err && err.message || err) }, 502);
  }

  const text = await upstream.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return json({ ok: upstream.ok, status: upstream.status, response: data }, upstream.ok ? 200 : 502);
}

/* ------------------------------ auth helpers ------------------------------ */

async function createSession(env, email) {
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  await env.KV.put(`session:${token}`, email, { expirationTtl: SESSION_TTL });
  return sessionCookie(token);
}

async function getSessionEmail(request, env) {
  const token = parseCookies(request)[COOKIE_NAME];
  if (!token) return null;
  return env.KV.get(`session:${token}`);
}

function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL}`;
}

function clearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

async function deriveHash(password, saltBytes) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return toHex(bits);
}

/* ------------------------------ utils ------------------------------ */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
  });
}

function parseCookies(request) {
  const out = {};
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > -1) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function isValidEmail(v) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

/* ------------------------------ pages ------------------------------ */

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: linear-gradient(135deg, #1e293b, #0f172a); color: #e2e8f0; padding: 24px;
  }
  .card {
    width: 100%; max-width: 420px; background: #1e293b; border: 1px solid #334155;
    border-radius: 14px; padding: 28px; box-shadow: 0 12px 40px rgba(0,0,0,.35);
  }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .sub { margin: 0 0 22px; color: #94a3b8; font-size: 14px; }
  label { display: block; font-size: 13px; margin: 14px 0 6px; color: #cbd5e1; }
  input {
    width: 100%; padding: 11px 12px; border-radius: 9px; border: 1px solid #475569;
    background: #0f172a; color: #e2e8f0; font-size: 14px;
  }
  input:focus { outline: none; border-color: #38bdf8; }
  button {
    width: 100%; margin-top: 20px; padding: 12px; border: 0; border-radius: 9px;
    background: #38bdf8; color: #04263a; font-weight: 600; font-size: 15px; cursor: pointer;
  }
  button:hover { background: #7dd3fc; }
  button:disabled { opacity: .6; cursor: not-allowed; }
  .toggle { margin-top: 18px; text-align: center; font-size: 13px; color: #94a3b8; }
  .toggle a { color: #38bdf8; cursor: pointer; text-decoration: none; }
  .msg { margin-top: 16px; padding: 11px 12px; border-radius: 9px; font-size: 13px; display: none; white-space: pre-wrap; word-break: break-word; }
  .msg.err { display: block; background: #450a0a; border: 1px solid #7f1d1d; color: #fecaca; }
  .msg.ok { display: block; background: #052e16; border: 1px solid #166534; color: #bbf7d0; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .linkbtn { background: transparent; color: #94a3b8; width: auto; margin: 0; padding: 6px 8px; font-weight: 500; }
  .linkbtn:hover { background: #334155; color: #e2e8f0; }
  .hint { font-size: 12px; color: #64748b; margin-top: 6px; }
`;

function loginPage({ codeRequired }) {
  const codeField = codeRequired
    ? '<div id="code-wrap"><label for="r-code">Signup code</label><input id="r-code" type="text" autocomplete="off" /></div>'
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Munshot Notetaker — Sign in</title>
<style>${STYLE}</style>
</head>
<body>
  <div class="card">
    <h1>Munshot Notetaker</h1>
    <p class="sub" id="subtitle">Sign in to send a meeting to the notetaker.</p>

    <form id="login-form">
      <label for="l-email">Email</label>
      <input id="l-email" type="email" autocomplete="username" required />
      <label for="l-pass">Password</label>
      <input id="l-pass" type="password" autocomplete="current-password" required />
      <button type="submit">Sign in</button>
    </form>

    <form id="register-form" style="display:none">
      <label for="r-email">Email</label>
      <input id="r-email" type="email" autocomplete="username" required />
      <label for="r-pass">Password</label>
      <input id="r-pass" type="password" autocomplete="new-password" required />
      <p class="hint">At least 6 characters.</p>
      ${codeField}
      <button type="submit">Create account</button>
    </form>

    <div class="msg" id="msg"></div>
    <div class="toggle" id="toggle">
      No account? <a id="toggle-link">Create one</a>
    </div>
  </div>

<script>
  var loginForm = document.getElementById('login-form');
  var registerForm = document.getElementById('register-form');
  var toggle = document.getElementById('toggle');
  var toggleLink = document.getElementById('toggle-link');
  var msg = document.getElementById('msg');
  var subtitle = document.getElementById('subtitle');
  var mode = 'login';

  toggleLink.onclick = function () {
    mode = mode === 'login' ? 'register' : 'login';
    var login = mode === 'login';
    loginForm.style.display = login ? 'block' : 'none';
    registerForm.style.display = login ? 'none' : 'block';
    subtitle.textContent = login ? 'Sign in to send a meeting to the notetaker.' : 'Create an account to get started.';
    toggle.innerHTML = login ? 'No account? <a id="toggle-link">Create one</a>' : 'Have an account? <a id="toggle-link">Sign in</a>';
    document.getElementById('toggle-link').onclick = toggleLink.onclick;
    showMsg('', '');
  };

  function showMsg(text, kind) {
    msg.textContent = text;
    msg.className = 'msg' + (kind ? ' ' + kind : '');
  }

  async function submit(path, payload, btn) {
    btn.disabled = true;
    showMsg('', '');
    try {
      var res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var data = await res.json().catch(function () { return {}; });
      if (res.ok && data.ok) {
        window.location.href = '/dashboard';
        return;
      }
      showMsg(data.error || 'Something went wrong.', 'err');
    } catch (e) {
      showMsg('Network error. Please try again.', 'err');
    } finally {
      btn.disabled = false;
    }
  }

  loginForm.onsubmit = function (e) {
    e.preventDefault();
    submit('/api/login', {
      email: document.getElementById('l-email').value,
      password: document.getElementById('l-pass').value,
    }, loginForm.querySelector('button'));
  };

  registerForm.onsubmit = function (e) {
    e.preventDefault();
    var codeEl = document.getElementById('r-code');
    submit('/api/register', {
      email: document.getElementById('r-email').value,
      password: document.getElementById('r-pass').value,
      code: codeEl ? codeEl.value : undefined,
    }, registerForm.querySelector('button'));
  };
</script>
</body>
</html>`;
}

function dashboardPage(email) {
  const safeEmail = escapeHtml(email);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Munshot Notetaker — Send a meeting</title>
<style>${STYLE}</style>
</head>
<body>
  <div class="card">
    <div class="row">
      <h1>Send a meeting</h1>
      <button class="linkbtn" id="logout">Log out</button>
    </div>
    <p class="sub">Signed in as ${safeEmail}</p>

    <form id="join-form">
      <label for="meeting">Meeting link</label>
      <input id="meeting" type="url" placeholder="https://meet.google.com/your-live-meet" required />
      <label for="email">Notetaker email</label>
      <input id="email" type="email" value="${safeEmail}" required />
      <p class="hint">The notetaker bot will join this meeting under this email.</p>
      <button type="submit">Send to notetaker</button>
    </form>

    <div class="msg" id="msg"></div>
  </div>

<script>
  var form = document.getElementById('join-form');
  var msg = document.getElementById('msg');

  function showMsg(text, kind) {
    msg.textContent = text;
    msg.className = 'msg' + (kind ? ' ' + kind : '');
  }

  document.getElementById('logout').onclick = async function () {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/';
  };

  form.onsubmit = async function (e) {
    e.preventDefault();
    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    showMsg('Sending…', '');
    try {
      var res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meeting_url: document.getElementById('meeting').value,
          email: document.getElementById('email').value,
        }),
      });
      var data = await res.json().catch(function () { return {}; });
      if (res.status === 401) {
        window.location.href = '/';
        return;
      }
      if (res.ok && data.ok) {
        showMsg('Sent! The notetaker has been asked to join.', 'ok');
        document.getElementById('meeting').value = '';
      } else {
        var detail = data.error || (data.response ? JSON.stringify(data.response) : 'Request failed.');
        showMsg('Failed: ' + detail, 'err');
      }
    } catch (e) {
      showMsg('Network error. Please try again.', 'err');
    } finally {
      btn.disabled = false;
    }
  };
</script>
</body>
</html>`;
}
