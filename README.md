# JobHunter

> **Setting this up for yourself? Start here: [docs/FRIEND-SETUP.md](docs/FRIEND-SETUP.md)** (Hebrew, step by step, from a fresh Windows PC).
> Stuck? Paste [docs/AI-HELP-PROMPT.md](docs/AI-HELP-PROMPT.md) into any AI assistant together with the two guides.

A local-first personal job-application agent for the Israeli job market. It finds jobs, filters and scores them
with a language model, prepares each application with a field-by-field plan, and submits only after you approve it.
It runs on your Windows PC, and your data stays in `./data`. The default model is local and free (Ollama); paid API
providers are optional.

**Full guide (Hebrew): [docs/GUIDE.md](docs/GUIDE.md)**

<!-- Screenshot placeholder: add docs/screenshot.png and reference it here -->
_Screenshot: coming soon._

## Features

- **Setup wizard**: on a fresh installation the dashboard walks you through everything. You never edit a file by hand.
- **Discovery and applying** on Drushim, JobMaster and Jobnet (Jobnet: regions mapped to your locations in Preferences, every opt-in — distribution to similar jobs, job alerts, consulting — unticked and verified in the evidence and the request; jobs marked "location approximate"), with human pacing and per-run limits; any bot-protection page stops the run. JobMaster: CV files from your JobMaster account (Preferences), suitability questions answered only from your answers bank / profile, "send my CV to similar categories" always unticked and verified in the evidence and in the request itself (the send is aborted otherwise), and the contact-details question answered from Preferences (default no).
- **Role types with tiers**, searched in Hebrew and English. A job's tier comes from its title, and search-only role types (e.g. Junior) never set it.
- **Deterministic prefilter** (whole-word title keywords, seniority, course/training titles, locations by city or site region) and an **experience cap** read from the requirements text. Then comes **LLM scoring** for the job's role type, with Hebrew reasoning and a dev-content score that caps fallback (tier 3) roles.
- **Ranking that prefers junior roles**: `rank = score + experience boost + tier boost`. Jobs, the review queue and preparation all follow it.
- **Pluggable model provider**: Ollama (default, local), Anthropic, OpenAI or Google Gemini, chosen per task (analyze / write) on the Settings screen. All of them use native structured output, validated with a retry. Also included: usage and cost tracking, and an optional daily token limit.
- **Profile from your CV(s)**: upload a Hebrew and/or English PDF in the dashboard. Every fact is checked against the CV text. Later uploads show a reviewable diff, and your own edits are never overwritten.
- **Hebrew in your grammatical gender**: drafts, standard questions and scoring text use male or female forms, as you choose.
- **Answers bank**: you answer each question once, and it is reused for every later job.
- **Field resolution** in this order: profile, then the answers bank, then skill years, then a fact-cited draft. The LLM never answers yes/no, salary, availability, legal and similar questions.
- **CV per job language**: Hebrew or English, chosen deterministically, with a manual override.
- **Run & send**: one session run from the header (or `npm start -- --hunt --send`): discover on every enabled site, score, prepare, and send what passes the auto-submit gate. Live progress, then a "Done. Safe to close / shut down" summary.
- **Review queue**: field plan with the source of every answer, inline editing, screenshots, Approve/Reject, and **batch approval** (select by rank, sent one by one with normal pacing; stops on a CAPTCHA, a daily cap or a session problem). Drafts, pending answers and flagged claims always need individual review.
- **History**: every application sent, with its evidence, your own outcome tracking (screening call, interview, offer…), CSV export and response-rate stats.
- **Email job alerts: LinkedIn and Indeed (optional add-on, off by default, each source separately)**: jobs from their alert emails, read over IMAP (read-only, Gmail app password), then scored like the rest. Applying is **assisted only**: the job opens in your own browser, and a helper panel shows the right CV and copy-ready answers. JobHunter never logs in to LinkedIn or Indeed, never opens them in its automated browser, and never clicks or scrapes anything there. Indeed links are resolved offline: a Drushim job joins the normal Drushim flow, a company / ATS link goes to the review queue, Indeed Apply is assisted. The same job from several sources (company + title within 14 days) is one job with every link. See [the guide](docs/GUIDE.md#תוסף-אופציונלי-התראות-משרות-במייל-linkedin-indeed).
- **One command**: `npm start` checks everything, installs what is missing, starts the system and opens the dashboard. `npm run doctor` only reports.

## Quick start (Windows 11)

1. Install [Node.js LTS](https://nodejs.org) (22.13+) and [Google Chrome](https://www.google.com/chrome/).
   Optionally, install [Ollama](https://ollama.com/download) for a free local model. It needs a GPU with enough memory, about 8 GB for `gemma4:12b`.
2. Get the code:
   ```powershell
   git clone https://github.com/Orel009/JobHunterAI.git
   cd JobHunterAI
   ```
3. Run `npm start` (or double-click `start.cmd`). The first run does the following:
   - installs the dependencies and the browser;
   - creates `.env` and `data/preferences.yaml` from the examples;
   - opens the dashboard with the **setup wizard**.
4. Complete the wizard's nine steps:
   1. your name and Hebrew gender;
   2. the model provider, with a connection test;
   3. your CV upload;
   4. profile review;
   5. skill levels and links;
   6. declared experience;
   7. role types, locations and max years;
   8. your Drushim CV names, plus a login window (a normal Chrome window, so Google sign-in works) where you log in yourself;
   9. standard answers.

After that, daily use is one session: `npm start`, click **▶ Run & send**, approve what waits in the review queue, and close when it says **Done. Safe to close / shut down**. From the command line: `npm start -- --hunt --send` (prints the summary and exits). Scheduling is optional: Settings → Schedule (while the app runs), or `npm run schedule:install` for a Windows Task Scheduler task (shown before it is created; runs only while you are logged in).
If something is wrong, `npm run doctor` tells you what and how to fix it.

## Choosing a model

| Provider | Cost | Privacy |
|---|---|---|
| Ollama (default) | free | everything stays on your computer |
| Anthropic, OpenAI, Google Gemini | pay per use | job posts, profile facts and CV text are sent to the provider |

- Pick the provider and model per task on the **Settings** screen. Model names are suggested from the provider's model list, and **Test connection** checks the choice.
- API keys are stored only in your local `.env`. They are never saved in the database or logged, and the UI only shows them masked.
- Costs come from the per-token prices you enter; nothing is hard-coded. `DAILY_LLM_TOKEN_LIMIT` pauses model steps for the rest of the day once reached.
- `npm start` and `npm run doctor` check the selected provider. With Ollama, they also check that the model fits your GPU memory.
- `npm run model:bench` compares models across providers. Set `BENCH_MODELS=gemma4:12b,anthropic:<model>,…` in `.env`.

## Updating your CV

1. Upload the new PDF on the **Profile** screen. It is read in the background, and nothing changes until you review it.
2. Review the proposed changes. Accept or reject each one, or use **Accept all safe changes** (additions and date fixes only).
3. Optionally re-score the active jobs against the updated profile.

Your own edits always survive a CV update: skill links, levels, aliases, removed skills, declared experience, edited dates and gender.

Applications send the CV stored **on your Drushim account**, so a banner reminds you to upload the new file to Drushim too, under the CV name set in your preferences.

## Editing your profile and preferences

The **Profile**, **Preferences** and **Settings** screens edit everything in forms. Every save is validated, and the previous version is backed up under `data/`.

## Safety

- **`DRY_RUN=true` by default**: the agent goes up to the final submit click, takes a screenshot, and stops. Real submission needs
  `DRY_RUN=false` **and** your explicit approval in the review queue.
- **Auto-submit is off by default.** If you turn it on for a site (Settings, with a warning), an application is sent without review only when every gate condition holds: rank ≥ 90, every answer from your profile / bank, company cooldown, daily limit, full description, and more. Every check is recorded in History, and **Pause auto-submit** in the header stops it immediately.
- **LinkedIn is never automated**: any request to linkedin.com from the automated browser is blocked, and LinkedIn jobs cannot enter the automated apply flow.
- **No bypassing**: CAPTCHA, bot protection and rate limits are never circumvented, and login is never automated: the login window is your installed Chrome, started as a normal process with no automation, and you close it when done. Automation then uses the same installed Chrome and profile. A challenge stops the run with status `blocked`.
- **No invented facts**: every value sent traces back to your profile or the answers bank, and its provenance is stored per field.
  LLM drafts must cite profile facts, are checked by a second pass, and are always shown to you before anything is sent.

## Sharing a copy without GitHub access

`npm run package` writes `dist/JobHunter-<version>.zip` with **only the git-tracked files** of the last commit (`git archive`). It then reads the zip back and fails, deleting it, if anything under `data/`, a `.env`, a PDF, a database or `preferences.yaml` is inside. Uncommitted changes are not included. The recipient extracts it and follows [docs/FRIEND-SETUP.md](docs/FRIEND-SETUP.md) (route B).

## Development

`npm run dev` (API with auto-reload plus the Vite dev server) · `npm test` · `npm run typecheck`. See [docs/GUIDE.md](docs/GUIDE.md#מבנה-הפרויקט) for the project layout and how to add a site.
