# Hunter (Fajr to Isha)

Life and job-hunt tracker with two practice agents that **search the web themselves**, no AI API key needed.

- **Sony** (interviewer): reads your role and job description, searches the web for current interview questions and model answers, mixes them into the interview, and never repeats questions you already got (it also changes daily).
- **Sam** (English partner): collects fresh conversation questions from the web, checks your grammar online (LanguageTool), and corrects you only after the conversation in a PDF report.

Backend: `server.js` (Node 18+, zero dependencies). Endpoints: `POST /api/research`, `POST /api/grammar`, `GET /api/health`.
If the web is unreachable within 5 seconds, the agents fall back to the built-in question bank.

Run locally: `npm start`  |  Test: `npm test`  |  Deploy: Render (`render.yaml`).

## Real AI mode (optional)
Add ONE of these environment variables on Render and Sam and Sony become real AI (replies, follow-ups and reports written by a language model, using the web research as material). Without a key they use the built-in logic.
- `GEMINI_API_KEY` (free key: aistudio.google.com)
- `GROQ_API_KEY` (free key: console.groq.com)
- `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY`
Optional: `AI_MODEL` to override the default model.
