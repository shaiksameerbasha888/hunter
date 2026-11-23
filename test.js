/* Offline test: a mock web (search engine, article pages, LanguageTool) on localhost. */
const http = require('http'), assert = require('assert');
const page = `<html><body><nav><a>Home</a></nav><h2>1. What is the difference between WHERE and HAVING in SQL?</h2><p>WHERE filters rows before grouping while HAVING filters groups after aggregation, for example HAVING COUNT(*) > 5.</p>
<h2>Q2: Explain INNER JOIN and LEFT JOIN with an example.</h2><p>INNER JOIN returns only matching rows. LEFT JOIN keeps every row from the left table and fills NULL where no match exists.</p>
<ul><li>How do you handle missing values in a dataset?</li></ul><p>Subscribe to our newsletter today</p>
<h3>Tell me about a time you faced a deadline under pressure?</h3><p>Use the STAR method: situation, task, action, result, and finish with what you learned from the experience.</p></body></html>`;
const chat = `<html><body><ul><li>What is your favourite way to spend a weekend?</li><li>Do you prefer tea or coffee, and why?</li><li>Click here to subscribe?</li></ul></body></html>`;
const mock = http.createServer((req, res) => {
  let d = ''; req.on('data', c => d += c); req.on('end', () => {
    const u = new URL(req.url, 'http://x'); const port = mock.address().port;
    if (u.pathname === '/ddg') { const q = u.searchParams.get('q'); const target = /conversation|small talk|ESL/i.test(q) ? 'chat' : 'qa';
      return res.end(`<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('http://example.test:' + port + '/' + target)}&rut=1">Result</a>`); }
    if (u.pathname === '/qa' || u.pathname === '/chat') { res.setHeader('content-type', 'text/html'); return res.end(u.pathname === '/qa' ? page : chat); }
    if (u.pathname === '/lt') { const text = new URLSearchParams(d).get('text'); const i = text.indexOf('go');
      return res.end(JSON.stringify({ matches: i < 0 ? [] : [{ offset: i, length: 2, message: 'The verb form is wrong.', replacements: [{ value: 'went' }], rule: { id: 'VERB', issueType: 'grammar' } }] })); }
    if (u.pathname === '/v1chat') return res.end(JSON.stringify({ choices: [{ message: { content: 'Hi, I am Sam.' } }] }));
    res.statusCode = 404; res.end('');
  });
});
mock.listen(0, async () => {
  const port = mock.address().port;
  process.env.DDG_URL = `http://127.0.0.1:${port}/ddg`; process.env.BING_URL = `http://127.0.0.1:${port}/none`; process.env.LT_URL = `http://127.0.0.1:${port}/lt`;
  // URLs from results use example.test, which a real network would resolve; route it to the mock instead
  const of = global.fetch; global.fetch = (u, o) => of(String(u).replace(/^http:\/\/example\.test:\d+/, `http://127.0.0.1:${port}`), o);
  const s = require('./server.js');
  // okUrl blocks IP literals by design (SSRF guard), example.test passes it
  const qa = s.extractQA(page, 'x');
  console.log('extracted:', qa.map(x => x.q));
  assert(qa.length === 4, 'expected 4 questions, got ' + qa.length);
  assert(/before grouping/.test(qa[0].a), 'answer attached');
  assert(!qa.some(x => /subscribe/i.test(x.q)), 'noise filtered');
  assert(qa[1].c === 'sql' && qa[3].c === 'beh', 'categories');
  const r1 = await s.research({ agent: 'int', role: 'Data Analyst', jd: 'We need SQL and Power BI reporting skills', day: '2026-11-23', seen: [] });
  console.log('int research:', r1.items.length, r1.sources);
  assert(r1.items.length >= 3 && r1.sources.length);
  const seen = r1.items.slice(0, 2).map(x => x.id);
  const r2 = await s.research({ agent: 'int', role: 'Data Analyst', jd: 'We need SQL and Power BI reporting skills', day: '2026-11-23', seen });
  assert(!r2.items.some(x => seen.includes(x.id)), 'seen questions are excluded');
  const r3 = await s.research({ agent: 'sam', topic: 'free talk', day: '2026-11-23', seen: [] });
  console.log('sam research:', r3.items.map(x => x.q));
  assert(r3.items.length === 2, 'sam questions (noise removed)');
  const g = await s.grammar('Yesterday I go to college.');
  console.log('grammar:', JSON.stringify(g));
  assert(g.ok && g.fixes[0].better === 'Yesterday I went to college.');
  const g2 = await s.grammar('I went home.'); assert(g2.ok && !g2.fixes.length);
  // AI brain through a mock OpenAI-compatible provider
  process.env.GROQ_API_KEY = 'k'; process.env.GROQ_URL = `http://127.0.0.1:${port}/v1chat`;
  assert(s.aiConf().name === 'groq');
  const a = await s.aiChat('hello'); console.log('ai:', JSON.stringify(a)); assert(a.text === 'Hi, I am Sam.');
  delete process.env.GROQ_API_KEY; assert((await s.aiChat('x')).error === 'no_key');
  console.log('ALL TESTS PASSED'); process.exit(0);
});
