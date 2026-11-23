'use strict';
/* Hunter: static host + live web-research agents (no AI API needed).
   POST /api/research  -> searches the web, extracts interview / conversation questions and model answers
   POST /api/grammar   -> online grammar check (LanguageTool) for Sam
   GET  /api/health */
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib');
const PORT = process.env.PORT || 3000;
const DDG = process.env.DDG_URL || 'https://html.duckduckgo.com/html/';
const BING = process.env.BING_URL || 'https://www.bing.com/search';
const LT = process.env.LT_URL || 'https://api.languagetool.org/v2/check';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DEADLINE = +process.env.RESEARCH_MS || 4700;

/* ---------- helpers ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, ms, opt) {
  opt = opt || {};
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { method: opt.method || 'GET', body: opt.body, signal: ac.signal, redirect: 'follow',
      headers: Object.assign({ 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html,application/json,*/*' }, opt.headers || {}) });
    if (!r.ok) return '';
    return (await r.text()).slice(0, 700000);
  } catch (e) { return ''; } finally { clearTimeout(t); }
}
const ent = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&nbsp;': ' ', '&rsquo;': "'", '&lsquo;': "'", '&ldquo;': '"', '&rdquo;': '"', '&ndash;': '-', '&mdash;': '-', '&hellip;': '...' };
const dec = s => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, m => { if (ent[m]) return ent[m]; const n = /^&#x/i.test(m) ? parseInt(m.slice(3), 16) : /^&#/.test(m) ? parseInt(m.slice(2), 10) : NaN; return isNaN(n) ? ' ' : String.fromCharCode(n); });
const strip = s => dec(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
function rng(seed) { let a = parseInt(hash(seed), 36) || 1; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const BAD_HOST = /^(localhost|.*\.local|.*\.internal)$|^\d+\.\d+\.\d+\.\d+$|^\[/i;
const SKIP_HOST = /(youtube|youtu\.be|facebook|instagram|twitter|x\.com|pinterest|tiktok|linkedin|amazon|udemy|coursera|duckduckgo|bing\.com|microsoft\.com\/en-us\/bing|google\.)/i;
function okUrl(u) { try { const x = new URL(u); return /^https?:$/.test(x.protocol) && !BAD_HOST.test(x.hostname) && !SKIP_HOST.test(x.hostname) && !/\.(pdf|docx?|pptx?|zip|png|jpe?g)$/i.test(x.pathname); } catch (e) { return false; } }

/* ---------- search engines ---------- */
function parseDDG(h) {
  const out = [], re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(h))) {
    let u = dec(m[1]); const q = /[?&]uddg=([^&]+)/.exec(u); if (q) u = decodeURIComponent(q[1]); if (u.startsWith('//')) u = 'https:' + u;
    out.push({ url: u, title: strip(m[2]) });
  }
  return out;
}
function parseBing(h) {
  const out = [], re = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(h))) {
    let u = dec(m[1]); const q = /[?&]u=a1([^&]+)/.exec(u);
    if (q) { try { u = Buffer.from(q[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch (e) { } }
    out.push({ url: u, title: strip(m[2]) });
  }
  return out;
}
async function search(q) {
  let r = parseDDG(await get(DDG + '?q=' + encodeURIComponent(q), 2200)).filter(x => okUrl(x.url));
  if (r.length < 2) r = r.concat(parseBing(await get(BING + '?q=' + encodeURIComponent(q) + '&setlang=en', 2200)).filter(x => okUrl(x.url)));
  return r;
}

/* ---------- question extraction ---------- */
const QSTART = /^(what|how|why|when|where|which|who|explain|describe|tell me|define|differentiate|distinguish|compare|can you|could you|do you|did you|have you|are you|is there|is it|write|give me|give an|walk me|name|list|state|mention|how would|what's|whats|suppose|imagine)\b/i;
const NOISE = /(click here|subscribe|sign up|cookie|privacy|http|www\.|©|copyright|download|newsletter|read more|table of contents|advertis|login|log in|follow us|share this|buy now|enroll|certification course|free trial|\bour (course|team|blog)\b)/i;
function cleanQ(t) {
  t = t.replace(/^\s*(?:q(?:uestion)?\s*)?\d{1,3}\s*[.):\-–]\s*/i, '').replace(/^\s*(?:q(?:uestion)?\s*\d{0,3}\s*[.):\-–]\s*)/i, '').replace(/^[\s•\-–*#]+/, '').replace(/\s+/g, ' ').trim();
  return t;
}
function isQ(t) {
  if (t.length < 18 || t.length > 180) return false;
  if (NOISE.test(t)) return false;
  if (!QSTART.test(t)) return false;
  if (!/\?$/.test(t) && !/^(explain|describe|define|differentiate|distinguish|compare|write|name|list|state|mention|tell me|give|walk me)\b/i.test(t)) return false;
  if (t.split(' ').length < 4) return false;
  return true;
}
function blocks(html) {
  html = html.replace(/<(script|style|nav|footer|header|aside|form|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const out = [], re = /<(h[1-6]|li|p|summary|dt|dd|strong|b|td|div)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/^(div|td)$/i.test(m[1]) && /<(p|li|h[1-6]|div|td|ul|ol|table)\b/i.test(m[2])) continue;
    const t = strip(m[2]);
    if (t) out.push({ tag: m[1].toLowerCase(), text: t });
  }
  return out;
}
const STOP = new Set('about above after again also because before being between both could does doing each from have having here into just like make more most other over same should some such than that their them then there these they this those through under until very were what when where which while will with would your you and are for not the but can how why who its our out use used using one two'.split(' '));
function kw(text) {
  const c = {}; (text.toLowerCase().match(/[a-z][a-z+#.]{3,}/g) || []).forEach(w => { if (!STOP.has(w)) c[w] = (c[w] || 0) + 1; });
  return Object.keys(c).sort((a, b) => c[b] - c[a]).slice(0, 8);
}
function cat(t) {
  t = t.toLowerCase();
  if (/power ?bi|dax|tableau|dashboard|visuali[sz]|measure|report/.test(t)) return 'pbi';
  if (/\bsql\b|select |join|query|database|primary key|foreign key|normali|group by|index|stored procedure|window function|\btable/.test(t)) return 'sql';
  if (/python|pandas|numpy|dataframe|\blist\b|tuple|dictionary|lambda|matplotlib/.test(t)) return 'py';
  if (/excel|vlookup|xlookup|pivot|spreadsheet|macro/.test(t)) return 'excel';
  if (/mean|median|correlation|hypothesis|probabil|regression|variance|standard deviation|p-value|outlier|distribution/.test(t)) return 'stat';
  if (/tell me about a time|weakness|strength|conflict|deadline|team|challenge|mistake|difficult|pressure/.test(t)) return 'beh';
  if (/about yourself|why do you want|why should we hire|where do you see|salary|why this (company|role)/.test(t)) return 'motiv';
  if (/sales (dropped|decline)|how would you (measure|investigate|analy[sz]e)|case|metric|kpi/.test(t)) return 'case';
  return 'gen';
}
function extractQA(html, src) {
  const bl = blocks(html), out = [], seen = new Set();
  for (let i = 0; i < bl.length; i++) {
    const b = bl[i], q = cleanQ(b.text);
    if (!isQ(q)) continue;
    const key = q.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(key)) continue; seen.add(key);
    let a = '', j = i + 1;
    while (j < bl.length && a.length < 420) {
      const n = bl[j], nq = cleanQ(n.text);
      if (isQ(nq) || /^h[1-6]$/.test(n.tag)) break;
      if (n.text.length > 30 && !NOISE.test(n.text)) a += (a ? ' ' : '') + n.text;
      j++;
    }
    a = a.replace(/^(answer|ans|a)\s*[:.\-]\s*/i, '').trim();
    if (a.length > 360) { const cut = a.slice(0, 360), p = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; ')); a = p > 120 ? cut.slice(0, p + 1) : cut.replace(/\s\S*$/, '') + '...'; }
    if (a.length < 40) a = '';
    out.push({ q, a, src, c: cat(q + ' ' + a), k: kw(q + ' ' + a) });
  }
  return out;
}

/* ---------- job-description understanding ---------- */
const SKILLS = ['sql', 'power bi', 'python', 'excel', 'tableau', 'statistics', 'etl', 'payroll', 'mis', 'reporting', 'dashboard', 'pandas', 'dax', 'data cleaning', 'a/b testing', 'machine learning', 'vlookup', 'pivot', 'stakeholder', 'data warehouse', 'looker', 'r programming', 'power query', 'data visualization', 'business intelligence', 'forecasting', 'kpi', 'compliance', 'sap', 'oracle', 'mysql', 'postgresql', 'snowflake', 'azure', 'aws', 'spark', 'javascript', 'typescript', 'react', 'angular', 'vue', 'node.js', 'express', 'java', 'spring boot', 'django', 'flask', 'docker', 'kubernetes', 'mongodb', 'redis', 'rest api', 'graphql', 'git', 'ci/cd', 'selenium', 'flutter', 'kotlin', 'terraform', 'kafka', 'microservices', 'html', 'css'];
const isDataRole = (role, jd) => { const t = ((role || '') || (jd || '')).toLowerCase(); return !t.trim() || (/analyst|analytics|\bbi\b|\bmis\b|reporting|payroll|power ?bi|tableau|data entry/.test(t) && !/developer|engineer|scientist|machine/.test(t)); };
function jdSkills(role, jd) {
  const t = (role + ' ' + jd).toLowerCase(), hits = [];
  SKILLS.forEach(s => { const n = t.split(s).length - 1; if (n) hits.push([s, n]); });
  hits.sort((a, b) => b[1] - a[1]); return hits.map(h => h[0]);
}
const MODS = ['freshers', 'scenario based', 'most asked', 'technical round', 'behavioral and technical', 'with sample answers', 'HR round', 'real interview', 'top 50', 'step by step answers'];
const SEEDS = {
  sql: ['https://www.interviewbit.com/sql-interview-questions/', 'https://www.geeksforgeeks.org/sql-interview-questions/'],
  py: ['https://www.interviewbit.com/python-interview-questions/'],
  pbi: ['https://www.simplilearn.com/power-bi-interview-questions-and-answers-article'],
  gen: ['https://www.interviewbit.com/data-analyst-interview-questions/', 'https://www.geeksforgeeks.org/data-analyst-interview-questions-and-answers/'],
  beh: ['https://www.themuse.com/advice/interview-questions-and-answers']
};

/* ---------- research ---------- */
const cache = new Map();
function rank(items, ctx, seenSet, seed) {
  const R = rng(seed), jdw = new Set((ctx.jd + ' ' + ctx.role).toLowerCase().match(/[a-z][a-z+#]{2,}/g) || []);
  const best = new Map();
  items.forEach(x => { const id = 'w' + hash(x.q.toLowerCase().replace(/[^a-z0-9]/g, '')); if (!best.has(id) || (x.a && !best.get(id).a)) best.set(id, Object.assign({ id }, x)); });
  return [...best.values()].filter(x => !seenSet.has(x.id)).map(x => {
    let s = 0; x.k.forEach(w => { if (jdw.has(w)) s += 1.5; }); ctx.skills.forEach(sk => { if ((x.q + ' ' + x.a).toLowerCase().includes(sk)) s += 3; });
    if (x.a) s += 2; if (ctx.skills.length && ctx.skills.some(sk => cat(sk) === x.c)) s += 2;
    return Object.assign(x, { _s: s + R() * 4 });
  }).sort((a, b) => b._s - a._s).map(x => { delete x._s; return x; });
}
async function researchInt(p, state) {
  const role = (p.role || 'Data Analyst').slice(0, 80), jd = (p.jd || '').slice(0, 6000), skills = jdSkills(role, jd), R = rng(p.day + role);
  const mod = () => MODS[Math.floor(R() * MODS.length)];
  const queries = [`${role} interview questions and answers ${mod()}`];
  skills.slice(0, 2).forEach(s => queries.push(`${s} interview questions with answers for ${role} ${mod()}`));
  if (queries.length < 3) queries.push(`${role} behavioral interview questions how to answer`);
  state.queries = queries;
  const res = await Promise.all(queries.map(q => search(q)));
  let urls = []; res.forEach(r => r.slice(0, 3).forEach(x => { if (!urls.includes(x.url)) urls.push(x.url); }));
  urls = urls.slice(0, 7);
  const seeds = []; if (isDataRole(role, jd)) (skills.slice(0, 2).concat(['gen'])).forEach(s => (SEEDS[cat(s) === 'gen' && s !== 'gen' ? 'gen' : cat(s)] || SEEDS[s] || []).forEach(u => { if (!urls.includes(u) && !seeds.includes(u)) seeds.push(u); }));
  const todo = urls.concat(urls.length < 4 ? seeds.slice(0, 3) : []);
  await Promise.all(todo.map(async u => {
    const h = await get(u, 2300); if (!h) return;
    const host = new URL(u).hostname.replace(/^www\./, ''), qa = extractQA(h, host);
    if (qa.length) { state.items.push(...qa); state.sources.add(host); }
  }));
  return { skills };
}
const SAMQ = ['conversation questions to practice speaking English', 'daily English conversation questions for adults', 'ESL speaking practice questions'];
async function researchSam(p, state) {
  const topic = (p.topic || '').slice(0, 40), R = rng(p.day + topic);
  const qs = [SAMQ[Math.floor(R() * SAMQ.length)] + (topic ? ' ' + topic : ''), `interesting small talk questions ${MODS[Math.floor(R() * MODS.length)].replace(/HR round|technical round|real interview/, 'for friends')}`];
  state.queries = qs;
  const res = await Promise.all(qs.map(q => search(q)));
  let urls = []; res.forEach(r => r.slice(0, 3).forEach(x => { if (!urls.includes(x.url)) urls.push(x.url); }));
  await Promise.all(urls.slice(0, 6).map(async u => {
    const h = await get(u, 2300); if (!h) return;
    const host = new URL(u).hostname.replace(/^www\./, ''), found = [];
    blocks(h).forEach(b => { const q = cleanQ(b.text); if (q.length >= 15 && q.length <= 120 && /\?$/.test(q) && QSTART.test(q) && !NOISE.test(q) && q.split(' ').length >= 4 && !/\b(interview|salary|resume)\b/i.test(q)) found.push({ q, a: '', src: host, c: 'chat', k: [] }); });
    if (found.length) { state.items.push(...found); state.sources.add(host); }
  }));
  return { skills: [] };
}
async function research(p) {
  const agent = p.agent === 'sam' ? 'sam' : 'int', seenArr = Array.isArray(p.seen) ? p.seen.slice(-500).map(String) : [], seenSet = new Set(seenArr);
  p.day = String(p.day || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const ck = [agent, p.day, hash((p.role || '') + (p.jd || '') + (p.topic || ''))].join('|');
  const ctxBase = { role: p.role || '', jd: (p.jd || '').slice(0, 6000), skills: [] };
  if (cache.has(ck) && Date.now() - cache.get(ck).t < 6 * 3600e3) {
    const c = cache.get(ck); ctxBase.skills = c.skills;
    return { items: rank(c.items, ctxBase, seenSet, ck + seenArr.length).slice(0, 16), sources: c.sources, cached: true };
  }
  const state = { items: [], sources: new Set(), queries: [] }; let info = { skills: [] };
  const work = (agent === 'sam' ? researchSam(p, state) : researchInt(p, state)).then(i => { info = i; ctxBase.skills = i.skills; cache.set(ck, { t: Date.now(), items: state.items.slice(), sources: [...state.sources], skills: i.skills }); }).catch(() => { });
  await Promise.race([work, sleep(DEADLINE)]);
  ctxBase.skills = info.skills.length ? info.skills : jdSkills(p.role || '', p.jd || '');
  const items = rank(state.items.slice(), ctxBase, seenSet, ck + seenArr.length).slice(0, 16);
  return { items, sources: [...state.sources], queries: state.queries, partial: !items.length };
}

/* ---------- grammar (LanguageTool) ---------- */
async function grammar(text) {
  text = String(text || '').slice(0, 1500);
  if (!text.trim()) return { ok: true, fixes: [] };
  const body = new URLSearchParams({ language: 'en-US', text, enabledOnly: 'false' }).toString();
  const raw = await get(LT, 3200, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } });
  let j; try { j = JSON.parse(raw); } catch (e) { return { ok: false, fixes: [] }; }
  const ms = (j.matches || []).filter(m => m.replacements && m.replacements.length && !/^(STYLE|REDUNDANCY|PLAIN_ENGLISH)$/i.test((m.rule && m.rule.issueType) || '') && !/COMMA|WHITESPACE|UPPERCASE_SENTENCE|EN_QUOTES|DASH/i.test((m.rule && m.rule.id) || ''));
  const sents = []; const re = /[^.!?\n]+[.!?]*/g; let s; while ((s = re.exec(text))) sents.push({ a: s.index, b: s.index + s[0].length, t: s[0] });
  const fixes = [];
  sents.forEach(se => {
    const mm = ms.filter(m => m.offset >= se.a && m.offset + m.length <= se.b).sort((x, y) => y.offset - x.offset);
    if (!mm.length) return;
    let better = se.t; mm.forEach(m => { better = better.slice(0, m.offset - se.a) + m.replacements[0].value + better.slice(m.offset - se.a + m.length); });
    const first = mm[mm.length - 1];
    fixes.push({ said: se.t.trim(), better: better.trim(), why: (first.shortMessage || first.message || 'Grammar').slice(0, 110) });
  });
  return { ok: true, fixes };
}

/* ---------- AI brain (optional): any ONE free/paid key in the environment turns Sam and Sony into real AI ---------- */
function aiConf() {
  const e = process.env;
  if (e.GEMINI_API_KEY) return { name: 'gemini', key: e.GEMINI_API_KEY, model: e.AI_MODEL || 'gemini-2.0-flash' };
  if (e.GROQ_API_KEY) return { name: 'groq', key: e.GROQ_API_KEY, model: e.AI_MODEL || 'llama-3.3-70b-versatile', url: e.GROQ_URL || 'https://api.groq.com/openai/v1/chat/completions' };
  if (e.OPENROUTER_API_KEY) return { name: 'openrouter', key: e.OPENROUTER_API_KEY, model: e.AI_MODEL || 'meta-llama/llama-3.3-70b-instruct:free', url: e.OPENROUTER_URL || 'https://openrouter.ai/api/v1/chat/completions' };
  if (e.ANTHROPIC_API_KEY) return { name: 'anthropic', key: e.ANTHROPIC_API_KEY, model: e.AI_MODEL || 'claude-haiku-4-5' };
  if (Date.now() < freeOffUntil) return null;
  return { name: 'free', key: '', model: e.FREE_AI_MODEL || 'openai', url: e.POLL_URL || 'https://text.pollinations.ai/openai' };
}
let freeFails = 0, freeOffUntil = 0;
async function aiChat(prompt) {
  const c = aiConf(); if (!c) return { error: 'no_key' };
  prompt = String(prompt || '').slice(0, 30000);
  let url, headers = { 'content-type': 'application/json' }, body, pick;
  if (c.name === 'gemini') {
    url = (process.env.GEMINI_URL || 'https://generativelanguage.googleapis.com/v1beta/models/' + c.model + ':generateContent') + '?key=' + encodeURIComponent(c.key);
    body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.85, maxOutputTokens: 2200 } };
    pick = j => j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts.map(x => x.text || '').join('');
  } else if (c.name === 'anthropic') {
    url = process.env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages'; headers['x-api-key'] = c.key; headers['anthropic-version'] = '2023-06-01';
    body = { model: c.model, max_tokens: 2200, temperature: 0.85, messages: [{ role: 'user', content: prompt }] };
    pick = j => j.content && j.content[0] && j.content[0].text;
  } else {
    url = c.url; if (c.key) headers.authorization = 'Bearer ' + c.key;
    body = { model: c.model, messages: [{ role: 'user', content: prompt }], temperature: 0.85, max_tokens: 2200 };
    pick = j => j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  }
  const raw = await get(url, c.name === 'free' ? 15000 : 28000, { method: 'POST', body: JSON.stringify(body), headers });
  let j; try { j = JSON.parse(raw); } catch (e) { if (c.name === 'free' && ++freeFails >= 2) { freeOffUntil = Date.now() + 5 * 60000; freeFails = 0; } return { error: 'provider' }; }
  const text = pick(j);
  if (c.name === 'free') { if (text) freeFails = 0; else if (++freeFails >= 2) { freeOffUntil = Date.now() + 5 * 60000; freeFails = 0; } }
  return text ? { text: String(text) } : { error: 'empty' };
}

/* ---------- http ---------- */
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const files = new Map();
function load() {
  if (!fs.existsSync(PUB)) return;
  fs.readdirSync(PUB).forEach(f => {
    const buf = fs.readFileSync(path.join(PUB, f)), ext = path.extname(f);
    files.set('/' + f, { buf, gz: /html|js|css|json|svg/.test(ext) ? zlib.gzipSync(buf, { level: 6 }) : null, type: MIME[ext] || 'application/octet-stream' });
  });
}
load();
const hits = new Map();
setInterval(() => hits.clear(), 60000).unref();
function limited(ip) { const n = (hits.get(ip) || 0) + 1; hits.set(ip, n); return n > 40; }
function body(req, max) { max = max || 20000; return new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > max) { req.destroy(); no(new Error('big')); } }); req.on('end', () => ok(d)); req.on('error', no); }); }
function json(res, code, o) { const s = JSON.stringify(o); res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(s); }

const server = http.createServer(async (req, res) => {
  const u = req.url.split('?')[0], ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (u === '/api/health') { const c = aiConf(); return json(res, 200, { ok: true, ai: !!c, provider: c ? c.name : null, time: new Date().toISOString() }); }
    if (u === '/api/ai' && req.method === 'POST') {
      if (limited(ip)) return json(res, 429, { error: 'slow down' });
      const p = JSON.parse((await body(req, 60000)) || '{}'); const r = await aiChat(p.prompt); return json(res, r.text ? 200 : 502, r);
    }
    if (u === '/api/research' && req.method === 'POST') {
      if (limited(ip)) return json(res, 429, { error: 'slow down' });
      const p = JSON.parse((await body(req)) || '{}'); return json(res, 200, await research(p));
    }
    if (u === '/api/grammar' && req.method === 'POST') {
      if (limited(ip)) return json(res, 429, { error: 'slow down' });
      const p = JSON.parse((await body(req)) || '{}'); return json(res, 200, await grammar(p.text));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method' });
    const f = files.get(u === '/' ? '/index.html' : u);
    if (!f) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    const h = { 'content-type': f.type, 'cache-control': u === '/' || u === '/index.html' ? 'no-cache' : 'public,max-age=86400', vary: 'accept-encoding' };
    if (f.gz && /gzip/.test(req.headers['accept-encoding'] || '')) { h['content-encoding'] = 'gzip'; res.writeHead(200, h); return res.end(req.method === 'HEAD' ? undefined : f.gz); }
    res.writeHead(200, h); res.end(req.method === 'HEAD' ? undefined : f.buf);
  } catch (e) { json(res, 500, { error: 'server' }); }
});
if (require.main === module) server.listen(PORT, () => console.log('Hunter listening on ' + PORT));
module.exports = { aiChat, aiConf, extractQA, parseDDG, parseBing, research, grammar, cat, server };
