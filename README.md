# JobHunter

A local-first, zero-cost personal job-application agent for the Israeli job market. It finds jobs, filters and scores
them with a local LLM, prepares each application with a field-by-field plan, and submits only after you approve it.
Everything runs on your Windows PC. There are no paid APIs and no cloud LLMs, and your data stays in `./data`.

**Full guide (Hebrew): [docs/GUIDE.md](docs/GUIDE.md)**

<!-- Screenshot placeholder: add docs/screenshot.png and reference it here -->
_Screenshot: coming soon._

## Features

- **Discovery** on Drushim. It reads the site's own data rather than scraping the page, with human pacing and per-run limits. AllJobs and JobMaster come next.
- **Deterministic prefilter** (titles, seniority, locations, companies), then **LLM scoring** with Hebrew reasoning (Ollama, `gemma4:12b`).
- **Profile from your CVs** (`profile:init`), built from a Hebrew and an English PDF. Every fact is checked against the CV text, and contradictions are listed for you to resolve.
- **Answers bank**: you answer each question once, and it is reused for every later job.
- **Field resolution** in this order: profile, then the answers bank, then skill years, then a fact-cited draft. The LLM never answers yes/no, salary, availability, legal and similar questions.
- **CV per job language**: Hebrew or English, chosen deterministically, with a manual override.
- **Review queue**: field plan with the source of every answer, inline editing, screenshots, and Approve/Reject.
- **One command**: `npm start` checks everything, starts the system and opens the dashboard. `npm run doctor` only reports.

## Quick start (Windows 11)

1. Install [Node.js LTS](https://nodejs.org) and [Ollama](https://ollama.com/download), then run `ollama pull gemma4:12b`.
2. Create your config: `copy .env.example .env` and `copy preferences.example.yaml preferences.yaml`, then edit `preferences.yaml`.
3. Put `cv-he.pdf` and `cv-en.pdf` in `data\profile\`, run `npm install`, then `npm run profile:init`. Review the draft and rename it to `profile.json`.
4. Log in to Drushim once by hand: `npm run login -- drushim`.
5. Run `npm start` (or double-click `start.cmd`). Add `--hunt` for one full pass: `npm start -- --hunt`.

If something is wrong, `npm run doctor` tells you what and how to fix it.

## Safety

- **`DRY_RUN=true` by default**: the agent goes up to the final submit click, takes a screenshot, and stops. Real submission needs
  `DRY_RUN=false` **and** your explicit approval in the review queue. There is no auto-submit.
- **No bypassing**: CAPTCHA, bot protection and rate limits are never circumvented, and login is never automated. A challenge stops the run with status `blocked`.
- **No invented facts**: every value sent traces back to your profile or the answers bank, and its provenance is stored per field.
  LLM drafts must cite profile facts, are checked by a second pass, and are always shown to you before anything is sent.

## Development

`npm run dev` (API with auto-reload plus the Vite dev server) · `npm test` · `npm run typecheck`. See [docs/GUIDE.md](docs/GUIDE.md#מבנה-הפרויקט) for the project layout and how to add a site.
