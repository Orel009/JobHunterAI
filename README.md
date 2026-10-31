# JobHunter

Local-first, zero-cost personal job-application agent. Discovers jobs on Israeli job sites, filters and scores
them with a local LLM (Ollama), and, from Phase 2, prepares applications for review. Everything runs on your
machine, and all personal data stays in `./data` (gitignored).

**Safety defaults:** `DRY_RUN=true` (never submits), no CAPTCHA/bot-protection bypass, no automated login.
If a site shows a challenge, the run is marked `blocked` and stops.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Scaffold, DB, browser session + login, Drushim discovery, prefilter, Ollama scoring, Jobs screen, model bench | ✅ |
| 2 | profile:init, answers bank, Drushim apply flow (DRY_RUN), Review queue | — |
| 3 | AllJobs + JobMaster, auto-submit gate, email apply, scheduler, History | — |

## Setup (Windows 11)

1. **Node.js 22.13+** (tested on Node 24): <https://nodejs.org>. SQLite is the built-in `node:sqlite`, so no native build tools are needed.
2. **Ollama**: <https://ollama.com/download>, then pull the models:
   ```powershell
   ollama pull gemma4:12b
   # optional, Hebrew-centric candidate for the bench (official Dicta GGUF, ~7 GB):
   ollama pull hf.co/dicta-il/DictaLM-3.0-Nemotron-12B-Instruct-GGUF:Q4_K_M
   ```
3. **Install + browser:**
   ```powershell
   npm install
   npx playwright install chromium
   ```
4. **Config:**
   ```powershell
   copy .env.example .env                       # every variable is documented inside
   copy preferences.example.yaml preferences.yaml
   ```
   Edit `preferences.yaml`: search titles, locations, filters, and **`candidateSummary`** (true facts only; the
   scorer uses it until `data/profile/profile.json` exists in Phase 2).
5. **DB:** created and migrated automatically on first start (`npm run db:migrate` runs migrations explicitly).

## Running

| What | Command |
|---|---|
| Log in to a site once (manual, in the persistent profile) | `npm run login -- drushim` → log in, then close the window |
| API + dashboard | `npm run dev` → open <http://127.0.0.1:5173> |
| Discovery + scoring from the terminal | `npm run discover -- drushim [discover\|score\|full]` |
| Model comparison report | `npm run model:bench` → `data/reports/model-bench-*.md` |
| Network investigation of a site | `npm run investigate -- drushim <url> [--click "text"] [--wait 30]` → `data/investigations/` |
| Tests (unit + Playwright on local fixtures) | `npm test` |
| Typecheck | `npm run typecheck` |

Only one process can use `data/browser-profile` at a time: don't run `login` while a discovery run is active.

### Phase 1 check

1. `npm run login -- drushim`, log in, close the window.
2. `npm run dev`, open the dashboard.
3. Click **Discover Drushim** and follow the live log. The stages are search → prefilter → details → scoring.
4. Scored jobs appear sorted by score. Click a row to see the Hebrew reasoning, matched/missing requirements and the post.

## How it works

```
preferences.yaml ─► search terms ─► SiteAdapter.search()  (Playwright, persistent profile, paced)
                                         │  RawJob
                                         ▼
                      normalize + id = sha1(site:externalId) ─► upsert (never duplicates)
                                         │                     └► cross-site dedupe (company + title, 14 days)
                                         ▼
                      deterministic prefilter (title/seniority/location/company) ─► skipped + reason
                                         ▼ pass
                      getDetails() for jobs without full text (job page)
                                         ▼
                      Ollama structured output (JSON schema) → zod → retry once → cache ─► scores
```

### Drushim (from the network investigation)

- **Search page** `https://www.drushim.co.il/jobs/search/<term>/` is Next.js. The first page of results is server-rendered
  in `__NEXT_DATA__` (`dehydratedState.queries['search-results']`), with title, company, city, description, `filterQuestions`,
  `hasSmartFilter` and `allowNoCv`.
- **"הצג עוד משרות"** fires `GET webapi.drushim.co.il/api/jobs/search?SearchTerm=…&page=N`. The adapter clicks it and captures
  the response with `waitForResponse`. That response contains full Description + Requirements, `JobInfo.HasFilter`
  (questionnaire), and `SendCVButtonModel.ExternalLink` (external apply).
- **Job page** `/job/<code>/<hash>/` holds `__NEXT_DATA__.props.pageProps.job` with `requirements[]`, `description[]`,
  `externalApplyUrl`, `filterQuestions[]`, salary range, experience.
- **Session probe:** `gw.drushim.co.il/auth/seeker-details` returns 401 when logged out.
- **Bot management:** Radware/ShieldSquare-style beacons (`__uzma*` cookies) are present. Normal paced browsing was not challenged.
  An invisible reCAPTCHA v3 iframe is on every page and is *not* treated as a block; only visible challenges are.
- Selectors and URL patterns live in `backend/src/sites/drushim/selectors.json`.

## Layout

```
backend/src/
  config.ts  log.ts               env (zod) + pino → console, data/logs, dashboard SSE
  db/                             node:sqlite, migrations/*.sql, repo.ts
  browser/session.ts              persistent context, pacing, block detection
  sites/types.ts registry.ts      SiteAdapter, RawJob/Job
  sites/drushim/                  adapter.ts, normalize.ts (pure), selectors.json
  core/                           text normalization, job ids/merge, dedupe, prefilter, prefs
  llm/                            ollama.ts (structured output + cache), score.ts
  pipeline/runner.ts              one run at a time: discover → prefilter → details → score
  server/                         Fastify REST + SSE
  cli/                            login, discover, bench, investigate, migrate
backend/test/                     vitest; *.pw.test.ts drive Chromium against local fixtures only
backend/bench/                    bench questions + 2 public job posts (fictional sample profile)
frontend/src/                     React dashboard
data/                             (gitignored) DB, logs, screenshots, browser-profile, profile/, reports/
```

## Notes

- **Hebrew abbreviations in JSON:** with grammar-constrained output, an ASCII `"` inside קו"ח / ש"ח ends the JSON string
  and silently truncates the text. Every structured call tells the model to use the gershayim `״` (see `llm/ollama.ts`).
- Gemma 4 is a thinking model; calls send `think: false` for speed and clean JSON.
- `PREFERENCES_FILE` and `DATA_DIR` can point elsewhere (useful for a throwaway test DB).
