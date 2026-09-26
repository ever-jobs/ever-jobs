# Ever Jobs

> A modular, extensible NestJS monorepo for aggregating job postings from multiple job boards.

![visitors](https://visitor-badge.laobi.icu/badge?page_id=ever-co.ever-jobs)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![NestJS](https://img.shields.io/badge/NestJS-10.x-e0234e.svg)](https://nestjs.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## ⭐️ Overview

**Ever® Jobs™** searches job postings from **160+ sources** concurrently and returns aggregated, normalized results through a single REST API, **GraphQL API**, **CLI**, or **MCP server** for AI assistants. Sources span search-based job boards, ATS (Applicant Tracking System) boards, and company-specific career APIs. Each source is an independent, reusable NestJS package — making it easy to add new sources, consume individual packages in other projects, or deploy the full API.

It is also used by our other platform, **Ever® Hust™ — The Anti-Hustle Career OS**: an open, agentic job-search platform that finds and evaluates opportunities, tailors your applications, and then tracks every application from the initial search all the way to a signed offer, see: <https://github.com/ever-hust/ever-hust> (AGPL v3)

### Search-Based Job Boards (109)

| Source                      | Method                 | Region                              |
| --------------------------- | ---------------------- | ----------------------------------- |
| **LinkedIn**                | HTML parsing (Cheerio) | Global                              |
| **Indeed**                  | GraphQL API            | 65+ countries                       |
| **Glassdoor**               | GraphQL API + CSRF     | 25+ countries                       |
| **ZipRecruiter**            | REST API               | US / Canada                         |
| **Google Jobs**             | Search page parsing    | Global                              |
| **Bayt**                    | HTML parsing (Cheerio) | Middle East / International         |
| **Naukri**                  | REST API               | India                               |
| **BDJobs**                  | REST API (public JSON) | Bangladesh                          |
| **Internshala**             | HTML parsing (Cheerio) | India (internships & jobs)          |
| **Exa**                     | Exa AI search API      | Global                              |
| **Upwork**                  | GraphQL API (OAuth2)   | Global (freelance)                  |
| **RemoteOK**                | REST API (JSON)        | Global (remote)                     |
| **Remotive**                | REST API (JSON)        | Global (remote)                     |
| **Jobicy**                  | REST API (JSON)        | Global (remote)                     |
| **Himalayas**               | REST API (JSON)        | Global (remote)                     |
| **Arbeitnow**               | REST API (JSON)        | Europe                              |
| **We Work Remotely**        | RSS feed               | Global (remote)                     |
| **USAJobs**                 | REST API (API key)     | US (government jobs)                |
| **Adzuna**                  | REST API (API key)     | 12+ countries                       |
| **Reed**                    | REST API (API key)     | UK                                  |
| **Jooble**                  | REST API (API key)     | 70+ countries                       |
| **CareerJet**               | REST API (affiliate)   | 80+ countries                       |
| **FindWork**                | REST API (API key)     | Global (developer jobs)             |
| **JobDataAPI**              | REST API (API key)     | Global (all industries)             |
| **Dice**                    | REST API + Playwright  | US (tech jobs)                      |
| **SimplyHired**             | HTML + Playwright      | Global                              |
| **Wellfound**               | Playwright SPA         | Global (startups)                   |
| **StepStone**               | Playwright SPA         | Germany                             |
| **Monster**                 | API + Playwright       | Global                              |
| **CareerBuilder**           | HTML + Playwright      | US                                  |
| **BuiltIn**                 | `__NEXT_DATA__` JSON   | US (tech startups)                  |
| **Snagajob**                | Search API             | US (hourly/part-time)               |
| **Dribbble Jobs**           | JSON API + HTML        | Global (design)                     |
| **The Muse**                | REST API (JSON)        | Global (career advice)              |
| **Working Nomads**          | REST API (JSON)        | Global (remote)                     |
| **4 Day Week**              | REST API (JSON)        | Global (4-day work week)            |
| **Startup.jobs**            | REST API (JSON)        | Global (startups)                   |
| **NoDesk**                  | REST API (JSON)        | Global (remote/flexible)            |
| **Web3 Career**             | REST API (JSON)        | Global (Web3/crypto)                |
| **Echojobs**                | REST API (JSON)        | Global (curated tech)               |
| **Jobstreet**               | REST API (JSON)        | Southeast Asia (SEEK)               |
| **CareerOneStop**           | REST API (Bearer)      | US (DOL/NLx)                        |
| **Arbeitsagentur**          | REST API (API key)     | Germany                             |
| **Hacker News**             | Firebase API (free)    | YC startups (Global)                |
| **Landing.jobs**            | REST API (public)      | Europe (tech/relocation)            |
| **Authentic Jobs**          | REST API (API key)     | Global (creative/dev)               |
| **CryptoJobsList**          | RSS feed               | Global (crypto/Web3)                |
| **Jobspresso**              | RSS feed (WordPress)   | Global (remote, curated)            |
| **HigherEdJobs**            | RSS feed               | US (higher education)               |
| **FOSS Jobs**               | RSS feed               | Global (open source)                |
| **LaraJobs**                | RSS feed               | Global (Laravel/PHP)                |
| **Python.org Jobs**         | RSS feed               | Global (Python)                     |
| **Drupal Jobs**             | RSS feed               | Global (Drupal/CMS)                 |
| **Real Work From Anywhere** | RSS feed               | Global (remote)                     |
| **Golang Projects**         | RSS feed               | Global (Go/Golang)                  |
| **WordPress Jobs**          | RSS feed               | Global (WordPress)                  |
| **Talroo**                  | REST API (publisher)   | Global (millions of jobs)           |
| **InfoJobs**                | REST API (Basic Auth)  | Spain / Italy                       |
| **JobTech Dev**             | REST API (API key)     | Sweden (50-80K jobs)                |
| **France Travail**          | REST API (OAuth2)      | France (800K+ jobs)                 |
| **NAV Arbeidsplassen**      | JSON Feed (Bearer)     | Norway                              |
| **jobs.ac.uk**              | RSS feed               | UK (academic/education)             |
| **Jobindex**                | RSS feed               | Denmark                             |
| **Get on Board**            | REST API (public)      | Latin America (tech)                |
| **Freelancer.com**          | REST API (public)      | Global (freelance/gig)              |
| **JoinRise**                | REST API (public)      | Global (tech startups)              |
| **Canada Job Bank**         | CKAN Open Data API     | Canada (government)                 |
| **ReliefWeb**               | REST API (JSON)        | Global (NGO/humanitarian)           |
| **UNDP Jobs**               | RSS 1.0 feed           | Global (UN/international)           |
| **DevITjobs**               | XML feed               | Europe (IT/dev, salary data)        |
| **PyJobs**                  | RSS feed               | Global (Python developer)           |
| **VueJobs**                 | RSS feed               | Global (Vue.js/frontend)            |
| **Conservation Jobs**       | RSS feed               | Global (environmental)              |
| **Coroflot**                | RSS feed               | Global (design/creative)            |
| **Berlin Startup Jobs**     | RSS feed (WordPress)   | Germany (Berlin startups)           |
| **Rails Job Board**         | RSS feed               | Global (Ruby/Rails)                 |
| **Elixir Jobs**             | RSS feed               | Global (Elixir/Phoenix)             |
| **Crunchboard**             | RSS feed               | Global (TechCrunch)                 |
| **Cryptocurrency Jobs**     | RSS feed (Atom)        | Global (blockchain/Web3)            |
| **HasJob**                  | Atom feed              | India/South Asia (tech)             |
| **iCrunchData**             | RSS feed               | US (data science/analytics)         |
| **SwissDevJobs**            | RSS feed               | Switzerland (tech, salary)          |
| **GermanTechJobs**          | RSS feed               | Germany (tech, salary)              |
| **VirtualVocations**        | RSS feed               | Global (remote/WFH)                 |
| **NoFluffJobs**             | JSON API               | Poland/CEE (tech, salary)           |
| **Green Jobs Board**        | RSS                    | Global (environmental)              |
| **EuroJobs**                | RSS                    | Europe (multi-country)              |
| **Open Source Design**      | RSS                    | Global (open source design)         |
| **Academic Careers**        | RSS                    | US (higher education)               |
| **RemoteFirstJobs**         | RSS                    | Global (remote-first)               |
| **Djinni**                  | RSS feed               | Ukraine (tech)                      |
| **HeadHunter**              | REST API (JSON)        | Russia/CIS (140K+ jobs)             |
| **Habr Career**             | REST API (JSON)        | Russia (tech community)             |
| **MyCareersFuture**         | REST API (JSON)        | Singapore (government)              |
| **Duunitori**               | REST API (JSON)        | Finland                             |
| **Jobs in Japan**           | RSS feed               | Japan (English tech jobs)           |
| **Jobs.ch**                 | REST API (JSON)        | Switzerland                         |
| **Guardian Jobs**           | RSS feed               | UK (The Guardian)                   |
| **AndroidJobs**             | RSS feed               | Android developer jobs              |
| **iOS Dev Jobs**            | RSS feed               | iOS/Swift developer jobs            |
| **DevOpsJobs**              | RSS feed               | Global (DevOps/infra)               |
| **Functional Works**        | GraphQL API            | Global (Haskell/Scala/FP)           |
| **PowerToFly**              | JSON API               | Global (diversity-focused)          |
| **Clojure Jobs**            | RSS feed               | Global (Clojure/ClojureScript)      |
| **EcoJobs**                 | RSS feed               | Global (environmental/conservation) |
| **JobsDB**                  | JSON API (Chalice)     | Asia-Pacific (SG, HK, TH)           |
| **TechCareers**             | HTML scraping          | US (tech niche)                     |
| **Level**                   | MCP server + RSS feed  | Global (AI-rated roles)             |
| **Simplify**                | Public listings JSON   | US (new grad & internships)         |

### ATS Job Boards (39)

ATS scrapers require a `companySlug` to target a specific company's job board. Ever Jobs integrates directly with each ATS platform's structured API, detecting new postings at the source — often hours before they appear on aggregated job boards like LinkedIn or Indeed.

| Source                 | ATS Platform       | Method                    | Notable Users                                                |
| ---------------------- | ------------------ | ------------------------- | ------------------------------------------------------------ |
| **Greenhouse**         | Greenhouse         | REST API                  | Airbnb, Coinbase, Datadog, DoorDash, HubSpot, Notion, Stripe |
| **Lever**              | Lever              | REST API                  | Netflix, Shopify, KPMG, Eventbrite, Atlassian                |
| **Workday**            | Workday            | REST API                  | Amazon, Salesforce, Target, Bank of America, Visa            |
| **Ashby**              | Ashby              | REST API                  | Ramp, Figma, Linear, Vercel, Plaid                           |
| **SmartRecruiters**    | SmartRecruiters    | REST API                  | Visa, Bosch, LinkedIn, Skechers, Equinox                     |
| **Jobvite**            | Jobvite            | REST API                  | Logitech, Schneider Electric, Zappos                         |
| **Workable**           | Workable           | GraphQL API               | Sephora, Bain Capital, Forbes                                |
| **SAP SuccessFactors** | SAP SuccessFactors | OData API + HTML fallback | Siemens, Accenture, Deloitte, EY                             |
| **Oracle Taleo**       | Oracle Taleo       | REST API (JSON)           | JPMorgan Chase, PepsiCo, Intel, Cisco                        |
| **iCIMS**              | iCIMS              | Playwright + JSON gateway | UPS, Uber, Johnson & Johnson, Target                         |
| **ADP Recruiting**     | ADP Workforce Now  | REST API                  | Major enterprises across industries                          |
| **UKG (UltiPro)**      | UKG Pro Recruiting | REST API                  | Major healthcare and manufacturing organizations             |
| **Rippling**           | Rippling           | REST API                  |                                                              |
| **Recruitee**          | Recruitee          | REST API                  |                                                              |
| **Teamtailor**         | Teamtailor         | REST API                  |                                                              |
| **BambooHR**           | BambooHR           | REST API (JSON)           |                                                              |
| **Personio**           | Personio           | XML feed                  |                                                              |
| **JazzHR**             | JazzHR             | HTML scraping             |                                                              |
| **Breezy HR**          | Breezy HR          | REST API                  |                                                              |
| **Comeet**             | Comeet             | REST API                  |                                                              |
| **Pinpoint**           | Pinpoint           | REST API                  |                                                              |
| **Manatal**            | Manatal            | REST API                  | 160K+ organizations (Asia-Pacific, global SMB)               |
| **Paylocity**          | Paylocity          | REST API (GUID)           | 30K+ US mid-market companies                                 |
| **Freshteam**          | Freshworks         | REST API (Bearer)         | 1K-5K companies globally                                     |
| **Bullhorn**           | Bullhorn           | REST API (Corp Token)     | 10K+ staffing agencies (#1 staffing ATS)                     |
| **Trakstar Hire**      | Trakstar           | REST API (Basic Auth)     | 5K+ companies (formerly RecruiterBox)                        |
| **HiringThing**        | HiringThing        | REST API (Basic Auth)     | 500+ companies (white-label ATS)                             |
| **Loxo**               | Loxo               | REST API                  | 1K-3K recruiting firms                                       |
| **Fountain**           | Fountain           | REST API (Bearer)         | 300+ enterprises (high-volume hourly hiring)                 |
| **Deel**               | Deel               | REST API (Bearer)         | 35K+ customers (global hiring/EOR platform)                  |
| **Phenom**             | Phenom People      | REST API                  | 900+ enterprises (Boeing, Hilton, Nestle, Verizon)           |
| **Jobylon**            | Jobylon            | JSON Feed                 | Hundreds of Nordic companies                                 |
| **Homerun**            | Homerun            | REST API (Bearer)         | Thousands of European SMBs                                   |
| **JobScore**           | JobScore           | JSON Feed (public)        | Thousands of companies                                       |
| **TalentLyft**         | TalentLyft         | REST API (Bearer)         | European companies                                           |
| **Crelate**            | Crelate            | REST API (API Key)        | Recruiting firms                                             |
| **iSmartRecruit**      | iSmartRecruit      | REST API (API Key)        | Global ATS                                                   |
| **Recruiterflow**      | Recruiterflow      | REST API (API Key)        | Recruiting agencies                                          |
| **InHire**             | InHire             | REST API (public, tenant) | Brazilian companies                                          |

### Company-Specific Scrapers (15)

Direct integrations with major tech companies' career APIs.

| Source        | API                               | Method           |
| ------------- | --------------------------------- | ---------------- |
| **Amazon**    | `amazon.jobs/api`                 | REST POST        |
| **Apple**     | `jobs.apple.com` (CSRF-protected) | REST POST + CSRF |
| **Microsoft** | Eightfold/PCSX API                | REST GET         |
| **Nvidia**    | Eightfold/PCSX API                | REST GET         |
| **TikTok**    | `lifeattiktok.com` API            | REST POST        |
| **Uber**      | `uber.com/api`                    | REST POST        |
| **Cursor**    | `cursor.com/careers`              | HTML scraping    |
| **Google**    | `careers.google.com` API          | REST GET         |
| **Meta**      | `metacareers.com`                 | `__NEXT_DATA__`  |
| **Netflix**   | `jobs.netflix.com` API            | REST GET         |
| **Stripe**    | Greenhouse API                    | REST GET         |
| **OpenAI**    | Ashby API                         | REST POST        |
| **IBM**       | `careers.ibm.com`                 | `__NEXT_DATA__`  |
| **Boeing**    | `jobs.boeing.com/api`             | REST GET         |
| **Zoom**      | Eightfold/PCSX API                | REST GET         |

---

## ✨ Features

- 🔍 **Multi-source aggregation** — Search 1 or all 160+ sources concurrently
- 🖥️ **CLI & API** — Use via REST API or command-line with JSON, CSV, table, or summary output
- 🤖 **MCP server** — [Model Context Protocol](https://modelcontextprotocol.io/) server for ChatGPT, Claude, and Copilot
- 🌐 **Country-aware** — Indeed & Glassdoor support 65+ countries with automatic domain resolution
- 🤝 **Polite by default** — Honest, configurable User-Agent, per-host pacing, back-off that honours `Retry-After`, optional robots.txt, and an egress guard; every knob configurable by env, plugin, operator per site/host, and per request ([crawl policy](docs/CRAWL_POLICY.md))
- 🔄 **Proxy support** — HTTP, HTTPS, SOCKS5 proxies; rotation configurable: one stable proxy per site (default), per scrape, or round-robin per request
- ⏱️ **Rate limiting** — Configurable min/max delay between requests, enforced per host across concurrent requests
- 📊 **Salary enrichment** — Extracts salary from descriptions when not provided directly
- 💰 **Annual salary normalization** — Convert hourly/monthly/weekly wages to annual equivalents
- 📝 **Description formats** — Returns descriptions as Markdown, HTML, or plain text
- 🏗️ **Modular architecture** — Each source is an independent NestJS package
- 📖 **Swagger docs** — Full OpenAPI documentation out of the box
- ⚡ **Concurrent execution** — All sources run in parallel via `Promise.allSettled`
- 🔐 **API key authentication** — Optional header-based auth with configurable keys
- 🚦 **Request throttling** — Per-client throttling with configurable limits
- 📦 **Response caching** — In-memory TTL cache with MD5 key generation
- 🏥 **Health checks** — `/health` and `/ping` endpoints with uptime & memory stats
- 🌐 **CORS support** — Environment-driven origin configuration
- 📋 **Request logging** — Per-request IDs, timing, and structured logs
- 🐳 **Docker ready** — Multi-stage Dockerfile, production & dev docker-compose
- 📄 **CSV export** — `POST /api/jobs/search?format=csv` with pagination

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** ≥ 18.x
- **npm** ≥ 9.x

### Installation

```bash
cd ever-jobs
npm install
cp .env.example .env   # configure environment variables
```

### Run in Development

```bash
npm run start:dev
```

The API will be available at `http://localhost:3001`.

### Docker

```bash
# Production
docker compose up -d

# Development (hot-reload)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

### Swagger Documentation

Open `http://localhost:3001/docs` in your browser for the interactive API explorer.

### MCP Server (AI Agent Integration)

Connect Ever Jobs to ChatGPT, Claude, or Copilot via the MCP server:

```bash
# Start the MCP server (requires Ever Jobs API running on port 3001)
cd apps/mcp && npm start
```

**Available MCP Tools:**

| Tool                  | Description                      |
| --------------------- | -------------------------------- |
| `search_jobs`         | Search 160+ sources with filters |
| `get_job_details`     | Get full job descriptions        |
| `list_sources`        | Browse sources by type           |
| `search_remote_jobs`  | Convenience tool for remote jobs |
| `get_salary_insights` | Salary market data for a role    |
| `compare_sources`     | Source catalog breakdown by type |

See [apps/mcp/README.md](apps/mcp/README.md) for Claude Desktop and ChatGPT setup instructions.

---

## CLI Usage

The CLI lets you run search jobs directly from the terminal without starting the API server.

```bash
# Basic search
npm run cli -- search --search-term "software engineer" --location "NYC"

# Multiple sites, CSV output to file
npm run cli -- search -s linkedin -s indeed -f csv -o jobs.csv

# Remote TypeScript jobs, table output
npm run cli -- search -q "typescript" --remote -f table

# With rate limiting (1-3 second delay between requests)
npm run cli -- search -q "engineer" --rate-delay-min 1 --rate-delay-max 3

# Per-request crawl policy: one request at a time per host, 2 s apart, sitemap discovery
npm run cli -- search -s softy --company-slug acme --max-per-host 1 --min-interval-ms 2000 --discovery sitemap

# Reproduce the pre-1690 crawler behaviour for this run
npm run cli -- search -q "engineer" --crawl-preset legacy

# Get help
npm run cli -- search --help
```

### CLI Options

| Flag                      | Short | Description                                      |
| ------------------------- | ----- | ------------------------------------------------ |
| `--site [sites...]`       | `-s`  | Sites to search (default: all)                   |
| `--search-term <term>`    | `-q`  | Job search keywords                              |
| `--location <loc>`        | `-l`  | Location to search                               |
| `--locations <locs...>`  |       | Several locations, searched one after another    |
| `--exclude-title <t...>`  |       | Drop jobs whose title has any of these terms     |
| `--exclude-keyword <t...>` |      | Drop jobs whose title or description has them    |
| `--exclude-preset <p...>` |       | Curated exclusion list: `security_clearance`     |
| `--company-slug <slug>`   |       | Company identifier for ATS scrapers              |
| `--remote`                | `-r`  | Remote jobs only                                 |
| `--results <n>`           | `-n`  | Results per site (default: 15)                   |
| `--format <fmt>`          | `-f`  | Output: `json`, `csv`, `table`, `summary`        |
| `--output <file>`         | `-o`  | Write to file instead of stdout                  |
| `--country <code>`        | `-c`  | Country (default: USA)                           |
| `--job-type <type>`       |       | `fulltime`, `parttime`, `internship`, `contract` |
| `--hours-old <h>`         |       | Max job age in hours                             |
| `--enforce-annual-salary` |       | Convert wages to annual                          |
| `--rate-delay-min <s>`    |       | Min delay between requests (seconds; per host bucket) |
| `--rate-delay-max <s>`    |       | Max delay between requests (seconds)             |
| `--stdin`                 |       | Read JSON input from stdin (for LLMs)            |
| `--no-description`        |       | Omit descriptions from output (reduces tokens)   |
| `--proxy [urls...]`       | `-p`  | Proxy URLs for rotation                          |
| `--user-agent <ua>`       |       | Custom User-Agent (implies `--user-agent-mode strict` unless one is given) |
| `--crawl <json>`          |       | Per-request crawl policy as JSON (any field, see [crawl policy](docs/CRAWL_POLICY.md)) |
| `--user-agent-mode <m>`   |       | `identify` (default), `strict`, `plugin`         |
| `--proxy-rotation <m>`    |       | `per-host` (default), `per-scrape`, `per-request`, `off` |
| `--max-per-host <n>`      |       | Max requests in flight per host bucket (0 = unlimited) |
| `--min-interval-ms <ms>`  |       | Minimum gap between request starts per host bucket |
| `--crawl-retries <n>`     |       | Retries per request on 429/5xx                   |
| `--robots-txt <m>`        |       | `off` (default), `crawl-delay`, `respect`        |
| `--discovery <m>`         |       | `auto` (default), `sitemap`, `listing` (e.g. Softy) |
| `--crawl-preset <p>`      |       | `polite` (default), `legacy` (pre-1690), `strict` — for this run |
| `--caller-overrides <m>`  |       | `any` (default), `stricter`, `none` — for this run |
| `--verbose`               | `-v`  | Debug output                                     |

### JSON Stdin Mode (for LLMs)

Accept a full JSON object via stdin — ideal for ChatGPT Code Interpreter and programmatic use:

```bash
# Pipe JSON input directly
echo '{"searchTerm": "engineer", "siteType": ["indeed"], "resultsWanted": 5}' | npm run cli -- search --stdin

# From a file
cat search_params.json | npm run cli -- search --stdin --format csv
```

---

## Configuration

All settings are configurable via environment variables. Copy `.env.example` to `.env` and adjust as needed.

| Variable               | Default     | Description                    |
| ---------------------- | ----------- | ------------------------------ |
| `ENABLE_API_KEY_AUTH`  | `false`     | Enable API key authentication  |
| `API_KEYS`             | (empty)     | Comma-separated valid API keys |
| `API_KEY_HEADER_NAME`  | `x-api-key` | Header name for API key        |
| `RATE_LIMIT_ENABLED`   | `false`     | Enable request throttling      |
| `RATE_LIMIT_REQUESTS`  | `100`       | Max requests per window        |
| `RATE_LIMIT_TIMEFRAME` | `3600`      | Window size in seconds         |
| `ENABLE_CACHE`         | `false`     | Enable response caching        |
| `CACHE_EXPIRY`         | `3600`      | Cache TTL in seconds           |
| `CORS_ORIGINS`         | `*`         | Allowed CORS origins           |
| `LOG_LEVEL`            | `info`      | Logging level                  |
| `ENABLE_SWAGGER`       | `true`      | Enable Swagger UI              |
| `PORT`                 | `3001`      | Server port                    |
| `EVER_JOBS_CLASSIFY_CAREER_LEVEL` | `true` | Attach `careerLevel` to every returned job; `false` removes it ([Career level](#career-level)) |
| `EVER_JOBS_CRAWL_PRESET` | `polite`  | Crawl behaviour preset: `polite`, `legacy` (exact pre-1690 behaviour), `strict` |
| `EVER_JOBS_CRAWL_USER_AGENT` | `default` | User-Agent; `default` = honest Ever Jobs UA, `browser` = pre-1690 Chrome UA, or any string |
| `EVER_JOBS_CRAWL_USER_AGENT_MODE` | `identify` | `identify`, `strict`, `plugin` — who decides the UA on the wire |
| `EVER_JOBS_CRAWL_CONTACT` | (empty) | Contact (e-mail/URL) inserted into the default UA so site operators can reach you |
| `EVER_JOBS_CRAWL_FROM` | (empty) | Adds a `From:` header                                |
| `EVER_JOBS_CRAWL_MAX_CONCURRENT_PER_HOST` | `4` | Requests in flight per host (0 = unlimited)     |
| `EVER_JOBS_CRAWL_MIN_INTERVAL_MS` | `100` | Minimum gap between request starts per host       |
| `EVER_JOBS_CRAWL_PROXY_ROTATION` | `per-host` | `per-host`, `per-scrape`, `per-request`, `off` |
| `EVER_JOBS_CRAWL_PROXIES` | (empty) | Proxy list; falls back to `DEFAULT_PROXIES`          |
| `EVER_JOBS_CRAWL_RETRIES` | `2`     | Retries on `EVER_JOBS_CRAWL_RETRY_STATUSES` (`429,502,503,504`); at most `10` |
| `EVER_JOBS_CRAWL_MAX_RETRY_AFTER_MS` | `60000` | Longer `Retry-After` → give up and cool the host |
| `EVER_JOBS_CRAWL_THROTTLE_RETRY_DELAY_MS` | `5000` | A `429`/`503` waits at least this (doubling per retry) and cools the host that long; `0` = no floor |
| `EVER_JOBS_CRAWL_ROBOTS_TXT` | `off` | `off`, `crawl-delay`, `respect`                        |
| `EVER_JOBS_CRAWL_BLOCK_PRIVATE_NETWORKS` | `true` | Refuse private/internal destinations (set `false` for local mocks) |
| `EVER_JOBS_CRAWL_POLICIES` | (empty) | JSON per-site / per-host policies (`{"sites":{…},"hosts":{…}}`) |
| `EVER_JOBS_CRAWL_CALLER_OVERRIDES` | `any` | What a request's `crawl` may change: `any`, `stricter`, `none` |

See [`.env.example`](.env.example) for the full list, and [`docs/CRAWL_POLICY.md`](docs/CRAWL_POLICY.md) for every crawl-policy variable, presets, precedence and per-site/per-host examples.

### Storage backends

Persisting search results is **off by default** (Spec 1722). Ever Jobs is a live aggregator:
the search API answers from the fan-out, and nothing in the API reads the store back. A fork
that wants its own corpus switches on a durable backend:

| `EVER_JOBS_STORE` | `EVER_JOBS_PERSIST_SEARCH` | Backend | Persists every search? | Also required |
| ----------------- | -------------------------- | ------- | ---------------------- | ------------- |
| unset | unset | memory | no | — |
| unset | `false` | memory | no | — |
| unset / `memory` | `true` | memory (process heap, capped by `EVER_JOBS_STORE_MAX_ROWS`) | yes | — |
| `sqlite` | unset | SQLite (Drizzle) | **yes** | `EVER_JOBS_STORE_SQLITE_PATH` |
| `postgres` | unset | Postgres (Prisma) | **yes** | `EVER_JOBS_STORE_DATABASE_URL` or `DATABASE_URL` |
| `postgres` | `false` | Postgres, connected but unused | no | same |

- `EVER_JOBS_STORE` also accepts the plugin package names `store-memory`, `store-sqlite-drizzle`,
  `store-postgres-prisma` (with or without `@ever-jobs/`), or set `EVER_JOBS_STORE_PLUGIN`
  instead. Both set to different backends → boot fails with `ERR_STORE_CONFLICT`.
- An explicit `EVER_JOBS_PERSIST_SEARCH` always wins.
- The boot **fails fast** with a message naming the variable when a selected backend is missing
  its configuration (`ERR_STORE_CONFIG_MISSING`), when Postgres is unreachable
  (`ERR_STORE_BACKEND_DOWN`, URL printed without credentials), or when the value is unknown
  (`ERR_STORE_NOT_FOUND`).
- Each persisted row's id is the job's `dedupKey`; source sightings go to `source_observation`.

**Enabling Postgres storage in a fork:**

```bash
npm ci
npm run store:postgres:generate          # generates @prisma/client for the store schema
export EVER_JOBS_STORE=postgres
export EVER_JOBS_STORE_DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/DATABASE'
npm run store:postgres:migrate           # creates canonical_job + source_observation (+ pg_trgm)
npm run store:postgres:status            # "Database schema is up to date!"
npm run start:dev                        # log: "Postgres store connected: postgresql://HOST:5432/DATABASE"
```

`store:postgres:migrate` reads the same URL variables as the API. The migration runs
`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`, so the migrating role needs that privilege (or a DBA
creates the extension once). The Docker image runs `prisma generate` during the build.

**SQLite:** `EVER_JOBS_STORE=sqlite` and `EVER_JOBS_STORE_SQLITE_PATH=/var/lib/ever-jobs/jobs.db`
(the directory is created; the schema is created on first boot).

**Write path at list-mode size.** A list-mode search persists 20–30 k canonical jobs. Both
durable backends write in chunks of `EVER_JOBS_STORE_BATCH_SIZE` rows (default `500`): Postgres
sends one `INSERT … ON CONFLICT DO UPDATE` statement per chunk (no long-running transaction) and
replaces observations with one statement per chunk that rewrites only rows whose URL, date or
title changed; SQLite writes one transaction per chunk and lets the event loop run between
chunks, so requests and NDJSON heartbeats keep flowing. Writes are atomic per chunk — every
write is an idempotent upsert, so a failure part-way is completed by the next persist. Postgres
also accepts `EVER_JOBS_STORE_TX_TIMEOUT_MS` (default `30000`) and
`EVER_JOBS_STORE_TX_MAX_WAIT_MS` (default `10000`) for its remaining interactive transactions;
the pool size is Prisma's `?connection_limit=N` on the URL. An invalid value fails the boot
with `ERR_STORE_CONFIG_INVALID`.

---

## API Usage

### `POST /api/jobs/search`

Search for jobs across one or more job boards. Returns a wrapped response with caching, CSV export (`?format=csv`), and pagination support (`?paginate=true`).

#### Request Body

```json
{
  "searchTerm": "software engineer",
  "siteType": ["linkedin", "indeed"],
  "location": "San Francisco, CA",
  "resultsWanted": 20,
  "country": "USA",
  "hoursOld": 72,
  "descriptionFormat": "markdown",
  "linkedinFetchDescription": true
}
```

#### Response

```json
{
  "count": 20,
  "cached": false,
  "jobs": [
    {
      "id": "li-3693012711",
      "site": "linkedin",
      "title": "Software Engineer - Early Career",
      "companyName": "Lockheed Martin",
      "jobUrl": "https://www.linkedin.com/jobs/view/3693012711",
      "location": {
        "city": "Sunnyvale",
        "state": "CA",
        "country": "USA"
      },
      "datePosted": "2025-02-07",
      "isRemote": false,
      "jobType": ["fulltime"],
      "compensation": {
        "interval": "yearly",
        "minAmount": 85000,
        "maxAmount": 130000,
        "currency": "USD"
      },
      "description": "By bringing together people that use..."
    }
  ]
}
```

#### CSV Export

```bash
curl -X POST http://localhost:3001/api/jobs/search?format=csv \
  -H 'Content-Type: application/json' \
  -d '{"searchTerm": "developer", "siteType": ["indeed"]}' -o jobs.csv
```

#### Pagination

```bash
curl -X POST "http://localhost:3001/api/jobs/search?paginate=true&page=1&page_size=10" \
  -H 'Content-Type: application/json' \
  -d '{"searchTerm": "developer"}'
```

Each page is its own search request. Pages share one crawl only through the search cache
(`ENABLE_CACHE=true` and a raw set within `EVER_JOBS_CACHE_MAX_JOBS`); without it every page
re-runs the whole fan-out and pages can disagree — see "Getting ALL jobs (list mode)" below.

#### Paginated Response

```json
{
  "count": 50,
  "total_pages": 5,
  "current_page": 1,
  "page_size": 10,
  "jobs": [...],
  "cached": false,
  "next_page": 2,
  "previous_page": null
}
```

#### Getting ALL jobs (list mode)

Omit `searchTerm` — or send `null`, `""` or whitespace — and the search runs in **list mode**
(Spec 1720): no keyword filter is applied anywhere, and every selected source returns what it
can list without a keyword, up to `resultsWanted` **per source**. Keyword and list calls
complement each other: some sources only return results for a keyword, others list their whole
board.

```bash
# Everything the non-ATS catalogue can list, up to 100 jobs per source, streamed (see below)
curl -N -X POST "http://localhost:3001/api/jobs/search?format=ndjson" \
  -H 'Content-Type: application/json' \
  -d '{"resultsWanted": 100}'
```

**Use NDJSON for list mode.** `?format=ndjson` streams the whole result of **one** crawl line by
line. An **unpaginated JSON** (or CSV) list-mode response builds the whole body as one string and
is capped only by `EVER_JOBS_MAX_JOBS_PER_SEARCH` (40 000 raw jobs by default) — at a few KB per
job that is a string of 100 MB or more on top of the jobs themselves.

**Pagination is not a substitute.** Every `?paginate=true` page is a separate search request;
the pages come from one crawl only while the search cache holds that crawl's raw set, which needs
**all** of: the cache is enabled (`ENABLE_CACHE=true` — off by default), the raw set holds at most
`EVER_JOBS_CACHE_MAX_JOBS` jobs (5 000 by default; a catalogue-wide list-mode crawl holds
20–30 k), the crawl was complete (an incomplete one is never cached), and the entry has not
expired or been evicted by another search (`CACHE_MAX_ITEMS`). Otherwise **every page re-runs the
whole fan-out** — each page costs a full crawl, and consecutive pages come from different crawls,
so they can disagree: a job can appear on two pages or on none, and `count` / `total_pages` can
change from one page to the next.

**Memory.** The whole result is held in memory until it has been deduplicated, even when
streamed (NDJSON only serialises line by line): a catalogue-wide list-mode crawl returns
20–30 k jobs today, at a few KB per job. These server-side bounds keep one request from
exhausting the heap, for JSON, CSV, NDJSON and GraphQL alike:

| Variable | Default | Effect |
| -------- | ------- | ------ |
| `EVER_JOBS_MAX_RESULTS_WANTED` | `1000` | `resultsWanted` is clamped to this, per source (warning logged). `0` = no cap |
| `EVER_JOBS_MAX_JOBS_PER_SEARCH` | `40000` | once the fan-out holds this many raw jobs, no further source is **started** (in-flight ones finish, like the deadline); each skipped source gets a `per_source` row with the detail `skipped: per-search job ceiling reached`. `0` = no cap. Lowered from 100 000 until the per-job footprint is measured in a pod |
| `EVER_JOBS_CACHE_MAX_JOBS` | `5000` | a search whose raw fan-out holds more jobs is served in full but **not cached** (the in-process cache would pin every job for the whole TTL). `0` = never cache |

Peak raw jobs per request ≤ `EVER_JOBS_MAX_JOBS_PER_SEARCH + EVER_JOBS_SEARCH_CONCURRENCY ×
EVER_JOBS_MAX_RESULTS_WANTED` (40 000 + 64 × 1 000 with the defaults). Size both to your heap
before raising either.

- The request log prints `term=<none>` in list mode (never `term="undefined"`), and `""`,
  whitespace, `null` and an omitted term share one cache entry.
- A source that cannot list without a keyword (its plugin metadata sets
  `requiresSearchTerm: true`; today `naukri`, `stepstone`, `careeronestop`) is **not called** in list mode; its
  `per_source` row reads `empty` with the detail `requires a searchTerm; not queried in list mode`.
- A source that fails without a keyword costs its own row, never the request.

#### Streaming NDJSON

`?format=ndjson` streams the result as newline-delimited JSON (Spec 1721) —
`Content-Type: application/x-ndjson; charset=utf-8`, one JSON object per line:

```text
{"type":"progress","sourcesDone":0,"sourcesTotal":0,"jobs":0}
{"type":"progress","sourcesDone":0,"sourcesTotal":1669,"jobs":0}
{"type":"progress","sourcesDone":412,"sourcesTotal":1669,"jobs":6120}
{"type":"job","data":{"id":"li-3693012711","title":"…","dedupKey":"4f1c…", …}}
{"type":"job","data":{…}}
{"type":"end","total":21873,"deduped":true,"durationMs":151234,"complete":true,"stopReason":null,"sourcesSkipped":0,"sourcesFailed":38,"sourcesPartial":3,"problemSources":[…],"problemSourcesTotal":57}
```

| Line | When |
| ---- | ---- |
| `progress` | first, immediately (`0/0/0` — this is what flushes the headers, also on a cache hit), again when the fan-out starts (real `sourcesTotal`), then at most every ~10 s while scraping, dedup, persistence and liveness run — doubles as a keep-alive for idle-timeout proxies |
| `job` | one per job, **same order and same per-job JSON as the JSON response** (including `dedupKey` and any field another feature adds) |
| `end` | exactly once, last; `total` equals the number of `job` lines; `complete`, `stopReason`, `sourcesSkipped`, `sourcesFailed` say whether the crawl covered every selected source; `sourcesPartial`, `problemSources`, `problemSourcesTotal` say which sources may not be used to expire postings (below) |
| `error` | `{"type":"error","message":"…"}` if anything fails after the headers were sent — the stream then closes **without** an `end` line |

**Was the crawl complete?** (Spec 1721 / FR-15) The `end` line says so:

| Field | Meaning |
| ----- | ------- |
| `complete` | `true` when every selected source was started and allowed to finish. `false` when the fan-out deadline (`EVER_JOBS_FANOUT_DEADLINE_MS`) or the job ceiling (`EVER_JOBS_MAX_JOBS_PER_SEARCH`) left sources unscraped — then a posting missing from this result may simply belong to a source that never ran |
| `stopReason` | `"deadline"`, `"job_ceiling"` (the first bound that tripped), or `null` when `complete` is `true` |
| `sourcesSkipped` | sources that contributed nothing because the fan-out stopped: not started, or abandoned mid-flight at the deadline. Keyword-only sources that list mode does not call are not counted |
| `sourcesFailed` | sources that ran and failed (`blocked`, `fetch_error`, `timeout`, `bad_input`, …). Failures do **not** make a crawl incomplete — a catalogue-wide crawl always has some |
| `sourcesPartial` | sources that returned some jobs and then failed (`partial`) — not failures, but their lists are incomplete |
| `problemSources` | `[{"site","reason"}]`, in fan-out order, at most 2 500 (the whole catalogue fits): every selected source whose result must **not** be used to expire its postings. `reason` is a failure reason (`blocked`, `fetch_error`, `timeout`, …), `partial`, `skipped` (a bound left it unstarted or abandoned it), `results_wanted` (it returned at least `resultsWanted` jobs, so its list was probably cut there) or `keyword_required` (list mode does not query it) |
| `problemSourcesTotal` | how many sources qualified before the cap; larger than `problemSources.length` means the list was truncated |

A cache hit reports the completeness of the crawl that produced the cached set. An incomplete
crawl (`complete: false`) is never cached, so a retry gets a fresh chance at the sources the
bound left out.

**Deciding expiry — per source.** A consumer that closes postings missing from a crawl must decide
it **per source**, never for the crawl as a whole: only a source this request **selected**, that
is **not** listed in `problemSources`, ran cleanly — it finished, did not fail, and was not cut
at `resultsWanted` — and only its postings may be expired by their absence. If
`problemSourcesTotal` is larger than `problemSources.length` the list was truncated: expire
nothing from that crawl. A `complete: true` crawl can still list problem sources (failures do not
make a crawl incomplete).

- **Decide expiry on a `dedup=false` crawl.** With `dedup=true` (the default) a posting of a clean
  source can be missing merely because dedup merged it into another source's record: the kept job
  of a merged cluster is the cluster's first job in output order, carrying that source's `site`
  and `id` (and, after a fuzzy merge, possibly a different `dedupKey`). `?dedup=false` returns
  every observation as its own job, so absence means the source did not return it.
- **A clean source can still be cut short by its own paging limit.** The `results_wanted` check
  only sees a source that returned **at least** `resultsWanted` jobs. A source that stops earlier
  because of a limit of its own — a plugin that reads a fixed number of pages, or an upstream API
  that caps its result count — returns fewer, is not listed, and yet did not list its whole board.
  The server cannot tell that apart from a board that really has that few postings, so treat
  absence from one clean crawl as evidence, not proof (e.g. require it across consecutive crawls,
  or check the posting's URL) before closing a posting.

```text
{"type":"end","total":14022,"deduped":false,"durationMs":120412,"complete":false,"stopReason":"deadline","sourcesSkipped":611,"sourcesFailed":35,"sourcesPartial":4,"problemSources":[{"site":"indeed","reason":"blocked"},{"site":"remoteok","reason":"partial"},…],"problemSourcesTotal":650}
```

Consumer rules: **treat a missing `end` line as a truncated, failed result**; **only treat a crawl
as complete when `complete` is `true`** — never infer "this posting is gone" from a crawl whose
`end` line says `false` or has no `complete` field (servers before FR-15 do not send it); **expire
per source only, from a `dedup=false` crawl** (above; servers before FR-20 send no `problemSources` —
then expire nothing); and ignore line types and fields you do not know (new ones may be added).
Input the search rejects before scraping (an unknown `siteCategories` value, a `companyDomain`
that maps to no plugin) is answered with a plain **400** before any line is sent. If the client disconnects, the server stops starting
new sources (in-flight ones finish) and discards the partial result — it is not cached, so a
retry never receives a truncated set. `paginate`, `page` and `page_size` are ignored;
`dedup`, `liveness` and `legitimacy` behave exactly as for JSON. Lines are written one at a time
with back-pressure — the server never builds the whole payload as one string. The response
sets `X-Accel-Buffering: no` so nginx-style proxies pass lines through as they are written.

Every job in every format (JSON, CSV column, NDJSON, GraphQL) carries **`dedupKey`**: the sha-256
of the normalised `company|title|location` — the same key the dedup engine clusters on, built from
the same fields (the flat `location`, every per-site `locations[]` entry and `isRemote`). The same
posting seen from a job board and from the company's ATS, today or next week, has the same
`dedupKey`, so a consumer can upsert on it.

Dedup (default `dedup=true`) only merges postings whose **locations are compatible** (the same
place, one side naming none, or a multi-office posting that lists the other's office) and whose
**employment types do not conflict** (an internship is never merged into a full-time posting, and
two different employment labels from one source are two postings) — Spec 1724. A role posted once
per office therefore comes back once per office. The kept job of a merged cluster carries the
union of the cluster's `locations[]`. Two postings the engine keeps apart although their company,
title and location coincide (e.g. a New York internship and a New York new-grad posting of the same
title) get distinct `dedupKey`s on the default path; with `dedup=false` they share one.

#### Choosing sources by category

`siteCategories` restricts the default fan-out to plugins whose metadata category is listed:
`job-board`, `niche`, `regional`, `remote`, `government`, `freelance`, `company`, `ats`.

```bash
curl -X POST http://localhost:3001/api/jobs/search \
  -H 'Content-Type: application/json' \
  -d '{"searchTerm": "rust", "siteCategories": ["job-board", "remote"]}'
```

- An explicit `siteType` / `companyDomain` wins; `siteCategories` is then ignored.
- ATS plugins still need `companySlug`: without it the default fan-out excludes them, so
  `["ats"]` alone selects nothing; with `companySlug`, `["ats"]` selects the ATS plugins.
- An unknown value is rejected with **400** naming the allowed values.

#### Liveness & legitimacy

`?liveness=true` probes each returned posting URL with the `liveness-http` plugin and attaches
`liveness: { state: active|expired|uncertain, checkedAt }`; `?legitimacy=true` attaches an
in-process `legitimacy: { state, reasons }`. Both are **off unless requested**. The operator
controls liveness server-side (Spec 1723):

| Variable | Default | Effect |
| -------- | ------- | ------ |
| `EVER_JOBS_LIVENESS_ENABLED` | `true` | `true` honours `?liveness=true`; `false` never probes — the response carries no `liveness` even when requested |
| `EVER_JOBS_LIVENESS_MAX_URLS` | `100` | probes per request; the first N jobs in output order are probed, the rest carry no `liveness`. `0` = no cap. 100 is the `page_size` ceiling, so paginated requests are never truncated |

#### Fan-out deadline

A search stops **starting** new sources once `EVER_JOBS_FANOUT_DEADLINE_MS` has elapsed
(default `120000`; in-flight sources finish, and one that never settles is abandoned at the
deadline). `0` disables the deadline. The older name `EVER_JOBS_SEARCH_DEADLINE_MS` is still
read when the new one is unset. Raise it for catalogue-wide list-mode crawls — with NDJSON the
client keeps receiving progress lines, so a long deadline no longer risks an idle timeout. A crawl
the deadline (or `EVER_JOBS_MAX_JOBS_PER_SEARCH`) cut short is reported on the NDJSON `end` line as
`"complete":false` with its `stopReason` — see "Was the crawl complete?" above.

#### Career level

Every job in every response format carries a server-computed `careerLevel` (Spec 1730): JSON,
paginated JSON, NDJSON (inside each `job` line's `data`), CSV (`careerLevel.level`,
`careerLevel.confidence` and `careerLevel.reasons` columns) and GraphQL
(`careerLevel { level confidence reasons }`).

```json
"careerLevel": {
  "level": "internship",
  "confidence": "high",
  "reasons": ["title: \"intern\"", "corroborated by jobType: internship"]
}
```

- `level` is one of `internship`, `new_grad`, `entry`, `mid`, `senior`, `staff`, `principal`,
  `manager`, `director`, `executive` or `unknown`. `confidence` is `high`, `medium` or `low`.
- Deterministic and in-process: no network, no LLM. The title decides; the source `jobType` /
  `employmentType` / `jobLevel` / `experienceRange` fields, then the first 3,000 visible
  description characters (HTML stripped), fill in only when the title is silent, and otherwise
  just move the confidence. The source fields themselves are never modified, and every one is
  length-capped before it is read, so an oversized scraped value cannot make classification slow.
- Guarded against the usual false friends: *Internal Audit Manager*, *International Sales*,
  *Staff Nurse*, *Senior Living*, *Lead Generation*, *Associate Director*, *Senior Partner
  Manager*. *Intern Program Manager* and *Campus Recruiter* run early-career programmes; they are
  not early-career roles.
- A title whose only cue is a season + year (*Software Engineer - Fall 2026*) is `internship` at
  `low` confidence: it may be a full-time start date. Threshold on `confidence` if you need
  high-precision internships; the `careerLevels` filter itself ignores confidence.
- Filter server-side with `"careerLevels": ["internship", "new_grad"]` in the request body
  (GraphQL: `careerLevels: [...]`). JSON and `?format=ndjson` share one pipeline, so they
  return the same filtered set in the same order. Unknown values are rejected (REST and NDJSON
  400, GraphQL `BAD_REQUEST`). `count` and the NDJSON `end` line's `total` are post-filter.
  The filter fails closed: if it cannot be applied (no classifier bound, or classification
  failed) the request is a 503, never an unfiltered 200; on NDJSON, whose status line is already
  sent, it is an `error` line and no `end` line. It is applied after the cache, so it does not
  change the search's cache entry (one entry holds the raw fan-out and its crawl-completeness
  record): a filtered and an unfiltered search share it.
- Only the jobs a response returns are classified when no filter is set: a page of
  `?paginate=true` classifies that page, and `?format=ndjson` classifies each batch of 256 jobs
  just before writing their lines, so a client that stops reading stops the classification. A
  `careerLevels` filter needs every job's level, so it classifies the whole deduplicated set once.
- Operators can switch the field off with `EVER_JOBS_CLASSIFY_CAREER_LEVEL=false`; an explicit
  `careerLevels` filter is still honoured.
- Rules, evaluation and decisions: [Spec 1730](.specify/specs/1730-career-level-classifier/spec.md).

### `POST /api/jobs/analyze`

Search and analyze jobs — returns summary statistics, company intelligence, and per-site comparison.

```bash
curl -X POST http://localhost:3001/api/jobs/analyze \
  -H 'Content-Type: application/json' \
  -d '{"searchTerm": "fullstack", "siteType": ["indeed"], "resultsWanted": 10}'
```

---

## Request Parameters

All parameters are optional. When `siteType` is omitted, search + company scrapers run (ATS scrapers are skipped unless `companySlug` is provided).

| Parameter                  | Type       | Default    | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `siteType`                 | `string[]` | all        | Sites to search. **Search**: `linkedin`, `indeed`, `zip_recruiter`, `glassdoor`, `google`, `bayt`, `naukri`, `bdjobs`, `internshala`, `exa`, `upwork`, `remoteok`, `remotive`, `jobicy`, `himalayas`, `arbeitnow`, `weworkremotely`, `usajobs`, `adzuna`, `reed`, `jooble`, `careerjet`, `dice`, `simplyhired`, `wellfound`, `stepstone`, `monster`, `careerbuilder`, `builtin`, `snagajob`, `dribbble`, `themuse`, `workingnomads`, `fourdayweek`, `startupjobs`, `nodesk`, `web3career`, `echojobs`, `jobstreet`, `careeronestop`, `arbeitsagentur`, `hackernews`, `landingjobs`, `findwork`, `jobdataapi`, `authenticjobs`, `cryptojobslist`, `jobspresso`, `higheredjobs`, `fossjobs`, `larajobs`, `pythonjobs`, `drupaljobs`, `realworkfromanywhere`, `golangjobs`, `wordpressjobs`, `talroo`, `infojobs`, `jobtechdev`, `francetravail`, `navjobs`, `jobsacuk`, `jobindex`, `getonboard`, `freelancercom`, `joinrise`, `canadajobbank`, `reliefweb`, `undpjobs`, `devitjobs`, `pyjobs`, `vuejobs`, `conservationjobs`, `coroflot`, `berlinstartupjobs`, `railsjobs`, `elixirjobs`, `crunchboard`, `cryptocurrencyjobs`, `hasjob`, `icrunchdata`, `swissdevjobs`, `germantechjobs`, `virtualvocations`, `nofluffjobs`, `greenjobsboard`, `eurojobs`, `opensourcedesignjobs`, `academiccareers`, `remotefirstjobs`, `djinni`, `headhunter`, `habrcareer`, `mycareersfuture`, `jobsinjapan`, `duunitori`, `jobsch`, `guardianjobs`, `androidjobs`, `iosdevjobs`, `devopsjobs`, `functionalworks`, `powertofly`, `clojurejobs`, `ecojobs`, `jobsbylevel`, `simplifyjobs`. **ATS**: `ashby`, `greenhouse`, `lever`, `workable`, `smartrecruiters`, `rippling`, `workday`, `recruitee`, `teamtailor`, `bamboohr`, `personio`, `jazzhr`, `icims`, `taleo`, `successfactors`, `jobvite`, `adp`, `ukg`, `breezyhr`, `comeet`, `pinpoint`, `manatal`, `paylocity`, `freshteam`, `bullhorn`, `trakstar`, `hiringthing`, `loxo`, `fountain`, `deel`, `phenom`, `jobylon`, `homerun`, `jobscore`, `talentlyft`, `crelate`, `ismartrecruit`, `recruiterflow`, `inhire`. **Company**: `amazon`, `apple`, `microsoft`, `nvidia`, `tiktok`, `uber`, `cursor`, `google_careers`, `meta`, `netflix`, `stripe`, `openai`, `ibm`, `boeing`, `zoom` |
| `companySlug`              | `string`   | —          | Company identifier for ATS scrapers (e.g. `stripe`, `notion`). When set without `siteType`, only ATS scrapers run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `siteCategories`           | `string[]` | —          | Restrict the default fan-out to plugin categories: `job-board`, `niche`, `regional`, `remote`, `government`, `freelance`, `company`, `ats`. Ignored when `siteType` is set; unknown values → 400 (see "Choosing sources by category") |
| `searchTerm`               | `string`   | —          | Job search keywords. Omit (or send `null` / `""` / whitespace) for **list mode**: no keyword filter, every selected source lists what it can (see "Getting ALL jobs") |
| `googleSearchTerm`         | `string`   | —          | Google-specific search query override                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `location`                 | `string`   | —          | Location to search near                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `locations`                | `string[]` | —          | Several locations searched in one request (up to 25; the first `EVER_JOBS_SEARCH_MAX_LOCATIONS`, default 10, are searched and the rest come back as `bad_input` diagnostics). Each source runs once per location, one after another, with its own `resultsWanted` / `offset`; same-source duplicates are removed. `location`, when also set, is searched first (Spec 1700) |
| `excludeTitleTerms`        | `string[]` | —          | Drop jobs whose title contains any of these words or phrases: whole-word, case- and accent-insensitive, trailing `*` = prefix, literal text (never a regex), negated mentions ignored. Applied after dedup (Spec 1700) |
| `excludeKeywords`          | `string[]` | —          | Drop jobs whose title or description contains any of these words or phrases (same rules as `excludeTitleTerms`) |
| `excludePresets`           | `string[]` | —          | Curated exclusion lists matched against title + description: `security_clearance` |
| `distance`                 | `number`   | `50`       | Search radius in miles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `isRemote`                 | `boolean`  | `false`    | Filter for remote jobs only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `jobType`                  | `string`   | —          | `fulltime`, `parttime`, `internship`, `contract`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `easyApply`                | `boolean`  | —          | Filter for easy-apply / hosted jobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `resultsWanted`            | `number`   | `15`       | Number of results **per source** (also in list mode); clamped to `EVER_JOBS_MAX_RESULTS_WANTED` (default `1000`)                                                                                                                                          |
| `offset`                   | `number`   | `0`        | Skip first N results                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `hoursOld`                 | `number`   | —          | Max job age in hours                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `country`                  | `string`   | `USA`      | Country for Indeed/Glassdoor domain                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `descriptionFormat`        | `string`   | `markdown` | `markdown`, `html`, or `plain`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `linkedinFetchDescription` | `boolean`  | `false`    | Fetch full LinkedIn descriptions (slower)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `linkedinFetchCompanyDetails` | `boolean` | unset (env) | Fetch each LinkedIn company page once (sequential, cached, capped at 25) to fill website, size, HQ, industry, description and logo. Unset = `EVER_JOBS_LINKEDIN_FETCH_COMPANY_DETAILS` (off) (Spec 1701) |
| `linkedinCompanyIds`       | `number[]` | —          | Filter LinkedIn by company IDs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `enforceAnnualSalary`      | `boolean`  | `false`    | Convert all wages to annual equivalent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `rateDelayMin`             | `number`   | —          | Minimum delay between requests in seconds. Maps to `crawl.minIntervalMs` (× 1000), enforced per host bucket across concurrent requests |
| `rateDelayMax`             | `number`   | —          | Maximum delay between requests in seconds. Maps to `crawl.jitterMs` = (max − min) × 1000 |
| `requestTimeout`           | `number`   | `60`       | Request timeout in seconds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `proxies`                  | `string[]` | —          | Proxy URLs (`host:port` or `user:pass@host:port`). Which one a request uses follows `crawl.proxyRotation` (default: one stable proxy per host); the operator may refuse caller proxies (`EVER_JOBS_CRAWL_CALLER_PROXIES=none`) |
| `caCert`                   | `string`   | —          | Path to CA certificate for proxies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `userAgent`                | `string`   | —          | Custom User-Agent string. Maps to `crawl.userAgent`, and to `crawl.userAgentMode: "strict"` unless that is set, so this UA is what goes out |
| `clientIp`                 | `string`   | —          | Client IP address for sources that require it (e.g. CareerJet). Also useful for proxy rotation strategies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `careerLevels`             | `string[]` | —          | Keep only jobs whose server-computed `careerLevel.level` is in the list: `internship`, `new_grad`, `entry`, `mid`, `senior`, `staff`, `principal`, `manager`, `director`, `executive`, `unknown`. Unknown values → 400. See [Career level](#career-level) |
| `retries` / `retryDelay` / `retryBackoff` / `retryMaxDelay` | `number` / `number` / `string` / `number` | — | Pre-1690 retry fields; when sent they map to `crawl.retries` / `retryBaseDelayMs` / `retryBackoff` / `retryMaxDelayMs` |
| `crawl`                    | `object`   | —          | Per-request crawl policy (identity, pacing, proxy rotation, retries, robots.txt, discovery). Any subset of the fields below; subject to the operator's `EVER_JOBS_CRAWL_CALLER_OVERRIDES`. Wins over the flat fields above |

#### `crawl` fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `userAgent` | `string` | Ever Jobs UA | UA to send; keywords `default`, `browser` |
| `userAgentMode` | `string` | `identify` | `identify` (our UA; plugins with a stated reason may use theirs), `strict` (our UA always), `plugin` (the plugin's declared UA) |
| `from` | `string` | — | `From:` header |
| `stripClientHints` | `boolean` | `true` | Drop `sec-ch-ua*` headers when our UA is sent |
| `proxyRotation` | `string` | `per-host` | `per-host`, `per-scrape`, `per-request`, `off` |
| `rateLimitScope` | `string` | `host` | Pacing bucket: `host`, `domain` (registrable domain), `site` |
| `maxConcurrentPerHost` | `integer` | `4` | Requests in flight per bucket (0 = unlimited) |
| `minIntervalMs` / `jitterMs` | `integer` | `100` / `0` | Gap between request starts, plus random jitter |
| `maxQueueWaitMs` | `integer` | `0` | Longest wait for a slot before failing fast (0 = no limit) |
| `adaptiveThrottle` | `boolean` | `true` | Slow a host down after 429/503, recover on success |
| `retries` / `retryStatuses` | `integer` / `integer[]` | `2` / `[429,502,503,504]` | Retry count (0–10) and statuses |
| `retryBackoff` | `string` | `exponential` | `exponential`, `linear`, `constant` |
| `retryBaseDelayMs` / `retryMaxDelayMs` | `integer` | `1000` / `30000` | Back-off base and cap |
| `retryJitter` / `retryOnNetworkError` | `boolean` | `true` / `false` | Full jitter; also retry connection errors |
| `respectRetryAfter` / `maxRetryAfterMs` / `retryAfterOverMax` | `boolean` / `integer` / `string` | `true` / `60000` / `give-up` | Honour `Retry-After`; beyond the max `give-up` (cool the host) or `cap` |
| `throttleRetryDelayMs` | `integer` | `5000` | Back-off floor after a `429`/`503`: retry *n* waits at least this × 2^n (capped at `max(retryMaxDelayMs, this)`), and the host cools down at least that long; `0` = no floor |
| `robotsTxt` | `string` | `off` | `off`, `crawl-delay`, `respect` |
| `blockPrivateNetworks` | `boolean` | `true` | Egress guard; a request can turn it on, never off |
| `discovery` | `string` | `auto` | `auto`, `sitemap`, `listing` (plugins with several strategies, e.g. Softy) |

```json
{
  "siteType": ["softy"],
  "companySlug": "acme",
  "crawl": { "maxConcurrentPerHost": 1, "minIntervalMs": 2000, "discovery": "sitemap" }
}
```

The same object is `crawl` on the GraphQL `SearchJobsInput` and the MCP `search_jobs` tool. Defaults shown are the `polite` preset (plugins and operators may set others); inspect what a source will actually run under with `GET /api/sources/:site/crawl-policy?host=<host>`. Details: [`docs/CRAWL_POLICY.md`](docs/CRAWL_POLICY.md).

---

## Response Schema

```
JobPost
├── id
├── site
├── title
├── companyName
├── companyUrl
├── jobUrl
├── jobUrlDirect
├── location
│   ├── city
│   ├── state
│   └── country
├── description
├── datePosted
├── isRemote
├── jobType[]                    fulltime, parttime, internship, contract
├── compensation
│   ├── interval                 yearly, monthly, weekly, daily, hourly
│   ├── minAmount
│   ├── maxAmount
│   └── currency
├── emails[]
├── listingType
│
├── department                   (ATS, Company scrapers)
├── team                         (ATS, Company scrapers)
├── atsId                        (ATS scrapers)
├── atsType                      (ATS scrapers)
├── employmentType               (ATS, Company scrapers)
├── applyUrl                     (ATS scrapers)
│
├── jobLevel                     (LinkedIn)
├── jobFunction                  (LinkedIn)
├── companyIndustry              (LinkedIn, Indeed)
│
├── companyAddresses             (Indeed)
├── companyNumEmployees          (Indeed)
├── companyRevenue               (Indeed)
├── companyDescription           (Indeed)
├── companyLogo                  (Indeed)
├── bannerPhotoUrl               (Indeed)
│
├── skills[]                     (Naukri)
├── experienceRange              (Naukri)
├── companyRating                (Naukri)
├── companyReviewsCount          (Naukri)
├── vacancyCount                 (Naukri)
├── workFromHomeType             (Naukri)
│
└── careerLevel                  (every job; server-computed, Spec 1730)
    ├── level                    internship | new_grad | entry | mid | senior | staff | principal | manager | director | executive | unknown
    ├── confidence               high | medium | low
    └── reasons[]
```

---

## Project Structure

```
ever-jobs/
├── apps/
│   ├── api/                          NestJS REST API
│   │   └── src/
│   │       ├── main.ts               Bootstrap + Swagger + CORS
│   │       ├── app.module.ts         Root module (config, guards, interceptors)
│   │       ├── auth/                 API key authentication guard
│   │       ├── cache/                In-memory TTL cache service
│   │       ├── config/               Configuration module (env vars)
│   │       ├── filters/              Global exception filter
│   │       ├── health/               Health check endpoints
│   │       ├── interceptors/         Request logging interceptor
│   │       └── jobs/
│   │           ├── jobs.controller.ts    POST /api/jobs/search + /analyze
│   │           ├── jobs.service.ts       Concurrent aggregation + post-processing
│   │           └── jobs.module.ts        Imports all source + analytics modules
│   │
│   └── cli/                          nest-commander CLI application
│       └── src/
│           ├── main.ts               CLI bootstrap (CommandFactory)
│           ├── cli.module.ts         Imports all source + analytics modules
│           └── commands/
│               ├── search.command.ts    CLI search with --analyze, --bd, 30+ options
│               └── compare.command.ts   Multi-site comparison with table output
│
├── packages/
│   ├── models/                       @ever-jobs/models
│   ├── common/                       @ever-jobs/common (HttpClient, converters, utils)
│   ├── analytics/                    @ever-jobs/analytics
│   ├── source-*/                     Search source modules (×105)
│   ├── source-ats-*/                 ATS source modules (×38)
│   └── source-company-*/             Company-specific source modules (×15)
│
├── .github/
│   ├── workflows/ci.yml              CI pipeline (build, type-check, Docker)
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── SECURITY.md
│   └── SUPPORT.md
│
├── docs/                             Project documentation
│   ├── ARCHITECTURE_OVERVIEW.md
│   ├── API_CHANGELOG.md
│   ├── DEPLOYMENT.md
│   ├── FAQ.md
│   ├── GLOSSARY.md
│   ├── PERFORMANCE_TUNING.md
│   ├── ROADMAP.md
│   ├── SECURITY_GUIDELINES.md
│   └── UPGRADE_GUIDE.md
│
├── Dockerfile                        Multi-stage Docker build
├── docker-compose.yml                Production deployment
├── docker-compose.dev.yml            Development with hot-reload
├── Makefile                          Dev & Docker shortcuts
├── .env.example                      Environment variable template
├── tool_manifest.json                Machine-readable tool metadata for MCP/LLMs
├── package.json
├── tsconfig.base.json
├── nx.json
└── nest-cli.json
```

---

## Architecture

### Modular Design

Each job board source is an independent NestJS package that implements the `IScraper` interface:

```typescript
interface IScraper {
  scrape(input: ScraperInputDto): Promise<JobResponseDto>;
}
```

This means you can:

- **Import individual packages** into your own NestJS application
- **Add new sources** by creating a new package that implements `IScraper`
- **Test sources independently** without the API layer

### Concurrent Execution

The `JobsService` orchestrator runs all selected sources concurrently using `Promise.allSettled`. Individual source failures don't affect other sources — results from successful sources are still returned.

Concurrency toward any single host is bounded separately by the crawl policy's process-wide per-host limiter (see [HTTP Client](#http-client)), so many plugins sharing one ATS API cannot burst it. When the search deadline abandons a slow source, its queued and in-flight requests are cancelled.

### Routing Logic

The service intelligently routes requests based on the input:

- **No `siteType` + no `companySlug`** → Runs search + company scrapers (ATS scrapers skipped — they need a company slug)
- **`companySlug` provided** → Runs ATS scrapers only (Ashby, Greenhouse, Lever, etc.)
- **Explicit `siteType`** → Runs exactly the specified scrapers, regardless of other parameters

### Post-Processing Pipeline

After searching, the orchestrator applies post-processing:

1. **Tag jobs with source** — Each job is tagged with its originating site
2. **Salary enrichment** — For USA jobs without direct compensation, salary is extracted from the description text
3. **Annual salary normalization** — When `enforceAnnualSalary` is enabled, hourly/monthly/weekly wages are converted to annual equivalents
4. **Sorting** — Results are sorted by site name, then by date posted (newest first)

### HTTP Client

A custom `HttpClient` wraps Axios. Every request is governed by a **crawl policy** ([Spec 1690](.specify/specs/1690-crawl-policy/spec.md), operator guide [`docs/CRAWL_POLICY.md`](docs/CRAWL_POLICY.md)) resolved per request from a preset, environment variables, builtin limits for bulk ATS APIs, the plugin's manifest, operator per-site/per-host policies, and the search request's `crawl` object:

- **Honest identity** — By default a User-Agent that names the project and links to it (`Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)`), optionally with your contact (`EVER_JOBS_CRAWL_CONTACT`) and a `From:` header. Plugins send their own UA only when their API requires it and they say why (USAJobs, HeadHunter). The pre-1690 browser UA is `EVER_JOBS_CRAWL_USER_AGENT=browser`.
- **Per-host pacing** — A process-wide limiter caps requests in flight and spaces request starts per host (or registrable domain, or site): 4 in flight and 100 ms by default, higher builtin limits for the Greenhouse, Lever, Ashby and SmartRecruiters APIs, adaptive slow-down after 429/503. `rateDelayMin`/`rateDelayMax` are enforced through it.
- **Proxy rotation modes** — HTTP/HTTPS/SOCKS5 proxies with `per-host` (default: one stable proxy per site), `per-scrape`, `per-request` (round-robin, the pre-1690 behaviour) or `off`.
- **Back-off that honours the server** — Retries with exponential back-off and jitter (default 2 on 429/502/503/504); never earlier than `Retry-After`; a `Retry-After` over 60 s gives up and cools the whole host.
- **robots.txt** — Opt-in (`crawl-delay` or `respect`).
- **Egress guard** — Refuses loopback, private, link-local and cluster-internal destinations (set `EVER_JOBS_CRAWL_BLOCK_PRIVATE_NETWORKS=false`, or allow-list hosts, for local mocks).
- **Custom CA certificates** — For enterprise proxy setups
- **Configurable timeouts** — Per-request and global timeout settings

`EVER_JOBS_CRAWL_PRESET=legacy` reproduces the pre-1690 behaviour exactly (browser UA, round-robin proxies, no pacing, linear retries); `strict` is the most conservative preset.

---

## Supported Countries

### LinkedIn & Google

Search globally using the `location` parameter.

### ZipRecruiter

Searches US and Canada using the `location` parameter.

### Indeed & Glassdoor

Support 65+ countries via the `country` parameter. Use `location` to narrow within a country.

|                |               |               |             |
| -------------- | ------------- | ------------- | ----------- |
| Argentina      | Australia\*   | Austria\*     | Bahrain     |
| Bangladesh     | Belgium\*     | Brazil\*      | Canada\*    |
| Chile          | China         | Colombia      | Costa Rica  |
| Czech Republic | Denmark       | Ecuador       | Egypt       |
| Finland        | France\*      | Germany\*     | Greece      |
| Hong Kong\*    | Hungary       | India\*       | Indonesia   |
| Ireland\*      | Israel        | Italy\*       | Japan       |
| Kuwait         | Luxembourg    | Malaysia      | Mexico\*    |
| Morocco        | Netherlands\* | New Zealand\* | Nigeria     |
| Norway         | Oman          | Pakistan      | Panama      |
| Peru           | Philippines   | Poland        | Portugal    |
| Qatar          | Romania       | Saudi Arabia  | Singapore\* |
| South Africa   | South Korea   | Spain\*       | Sweden      |
| Switzerland\*  | Taiwan        | Thailand      | Turkey      |
| Ukraine        | UAE           | UK\*          | USA\*       |
| Uruguay        | Venezuela     | Vietnam\*     |             |

_\* indicates Glassdoor support_

### Bayt

Searches `searchTerm` in one Bayt market: `country` when it is a Bayt market (UAE, Saudi Arabia, Qatar, Kuwait, Bahrain, Oman, Egypt, Morocco), else the market read from `location`, else `international`. Pages are fetched one at a time (at most 10) and a challenge is reported as a `blocked` diagnostic. `EVER_JOBS_BAYT_COUNTRY_SCOPE=false` always searches the international market, as before Spec 1710.

### Naukri

India-specific. Supports INR salary parsing (Lakhs/Crores).

### BDJobs

Bangladesh-specific. Reads the board's public JSON search and details API (Spec 1711): pages one at a time, `isRemote` / `jobType` / `hoursOld` filtered before any details request, details within the `descriptionDepth` budget. `BDJOBS_MODE=html` selects the earlier HTML scraper.

### Internshala

India-specific. Supports both internships and full-time jobs. Extracts stipend, duration, and apply-by dates.

Without `jobType` a search returns internships and jobs together (Spec 1706); `INTERNSHIP` or `FULL_TIME` narrows it to one stream. `searchTerm`, `location` and `isRemote` pick the listing path, one posting per card, at most 10 pages per stream, 2-5 s apart. `INTERNSHALA_DEFAULT_STREAMS=job` restores the earlier jobs-only default.

### Exa

Global AI-powered job search via the [Exa API](https://exa.ai). Requires `EXA_API_KEY` environment variable. Credentials can also be passed per-request via the `auth.exa` field in the request body.

### Upwork

Global freelance marketplace. Uses the official [Upwork SDK](https://github.com/upwork/node-upwork-oauth2) with GraphQL API (`marketplaceJobPostings` query). Supports two OAuth2 grant types:

- **`client_credentials`** — server-to-server, requires only `clientId` + `clientSecret`
- **`authorization_code`** — user-delegated, requires all four values below

| Variable               | Required                  | Description                                  |
| ---------------------- | ------------------------- | -------------------------------------------- |
| `UPWORK_CLIENT_ID`     | Yes (both flows)          | OAuth2 application client ID                 |
| `UPWORK_CLIENT_SECRET` | Yes (both flows)          | OAuth2 application client secret             |
| `UPWORK_GRANT_TYPE`    | No (auto-detected)        | `client_credentials` or `authorization_code` |
| `UPWORK_ACCESS_TOKEN`  | `authorization_code` only | Pre-obtained OAuth2 access token             |
| `UPWORK_REFRESH_TOKEN` | `authorization_code` only | Pre-obtained OAuth2 refresh token            |

Get API credentials at [developers.upwork.com](https://developers.upwork.com). Without credentials, Upwork searches gracefully return empty results.

Credentials can also be passed per-request via the `auth.upwork` field in the request body, which overrides env vars. See [Authentication docs](docs/AUTHENTICATION.md) for details.

### RemoteOK

Global remote job board with free JSON API (`remoteok.com/api`). Returns salary data when available. No authentication required.

### Remotive

Remote job board with free JSON API (`remotive.com/api/remote-jobs`). Supports category and search filters. Jobs are delayed 24 hours. No authentication required.

### Jobicy

Remote job board with free JSON API (`jobicy.com/api/v2/remote-jobs`). Provides annual salary data and supports region/industry/tag filtering. Returns up to 50 jobs per request. No authentication required.

### Himalayas

Remote job board with free JSON API (`himalayas.app/jobs/api`). Supports offset-based pagination (max 20 per page). No authentication required.

### Arbeitnow

European-focused job board with free JSON API (`arbeitnow.com/api/job-board-api`). Supports page-based pagination. No authentication required.

### We Work Remotely

Popular remote job board. Uses RSS feed (`weworkremotely.com/remote-jobs.rss`) — parsed without external XML libraries. Category-specific feeds also available. No authentication required.

### Recruitee (ATS)

Recruitee ATS integration. Per-company public API at `{slug}.recruitee.com/api/offers`. Provides salary data when available. Requires `companySlug` parameter.

### Teamtailor (ATS)

Teamtailor ATS integration. Per-company career page API. Requires `companySlug` parameter.

### USAJobs

US government job board with free API. Requires `USAJOBS_API_KEY` and `USAJOBS_EMAIL` environment variables. Register at [developer.usajobs.gov](https://developer.usajobs.gov/APIRequest/Index). Returns full descriptions with salary data from position remuneration fields. Credentials can also be passed per-request via the `auth.usajobs` field in the request body.

### Adzuna

Multi-country job aggregator covering 12+ countries. Requires `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` environment variables. Register at [developer.adzuna.com](https://developer.adzuna.com/signup). Free tier limited to 25 requests/min and 250 requests/day. Uses the `country` parameter to select the appropriate API endpoint. Credentials can also be passed per-request via the `auth.adzuna` field in the request body.

### Reed

UK-focused job board. Requires `REED_API_KEY` environment variable. Register at [reed.co.uk/developers](https://www.reed.co.uk/developers). Uses HTTP Basic Auth. Provides salary data in GBP. Credentials can also be passed per-request via the `auth.reed` field in the request body.

### Jooble

Job aggregator covering 70+ countries. Requires `JOOBLE_API_KEY` environment variable. Register at [jooble.org/api/about](https://jooble.org/api/about). Uses POST requests with the API key in the URL path. Salary data parsed from string format. Credentials can also be passed per-request via the `auth.jooble` field in the request body.

### CareerJet

Job aggregator covering 80+ countries with locale-based searches. Requires `CAREERJET_AFFID` environment variable. Register at [careerjet.com/partners](https://www.careerjet.com/partners/). Requires `clientIp` parameter for proper operation (falls back to `127.0.0.1`). Supports the `proxies` parameter for residential IP rotation. Credentials can also be passed per-request via the `auth.careerjet` field in the request body.

---

## Using Individual Packages

Each source package can be used independently in your own NestJS application:

```typescript
import { Module } from "@nestjs/common";
import { LinkedInModule, LinkedInService } from "@ever-jobs/source-linkedin";
import { ScraperInputDto } from "@ever-jobs/models";

@Module({
  imports: [LinkedInModule],
})
export class MyModule {
  constructor(private readonly linkedin: LinkedInService) {}

  async searchLinkedIn() {
    const input = new ScraperInputDto({
      searchTerm: "TypeScript developer",
      location: "Remote",
      resultsWanted: 10,
      linkedinFetchDescription: true,
    });

    const response = await this.linkedin.scrape(input);
    console.log(`Found ${response.jobs.length} LinkedIn jobs`);
  }
}
```

---

## Tips & Limitations

> **Indeed** is generally the most reliable source with minimal rate limiting.

> **LinkedIn** is the most restrictive — it typically rate-limits around the 10th page from a single IP. Using proxies is strongly recommended.

> **Google Jobs** requires specific search syntax. For best results, search for Google Jobs in your browser, apply filters, and use the resulting search query as `googleSearchTerm`.

> **All job boards** cap results at approximately 1,000 jobs per search query.

### Indeed Limitations

Only **one** of these filters can be active per search:

- `hoursOld`
- `jobType` + `isRemote`
- `easyApply`

### LinkedIn Limitations

Only **one** of these filters can be active per search:

- `hoursOld`
- `easyApply`

---

## FAQ

**Q: Indeed is returning unrelated jobs?**
Indeed searches job descriptions too. Use `-` to exclude terms and `""` for exact match:

```
"engineering intern" software summer (java OR python OR c++) 2025 -tax -marketing
```

**Q: Getting 429 (Too Many Requests)?**
You've been rate-limited. Solutions:

- Use `rateDelayMin` and `rateDelayMax` to add configurable delay between requests
- Use the `proxies` parameter to rotate IPs
- Reduce `resultsWanted`
- Since Spec 1690 Ever Jobs already backs off on 429 and honours `Retry-After` (a long one cools the whole host and is reported as `rate_limited` in the search diagnostics). The polite fix is to slow down for that host — `crawl.maxConcurrentPerHost` / `crawl.minIntervalMs` per request, or an operator host policy — rather than to rotate IPs past the site's limit. See [`docs/CRAWL_POLICY.md`](docs/CRAWL_POLICY.md) §18.

**Q: No results from Google?**
Google requires very specific query syntax. Search for jobs on Google in your browser, then copy the exact search box text into `googleSearchTerm`.

---

## Development

### Build

```bash
npm run build
```

### Type Check

```bash
npx tsc --project tsconfig.base.json --noEmit
```

### Production Start

```bash
npm run start:prod
```

### Run Tests

```bash
# Run all unit tests
npm test

# Run specific test suite
npx jest packages/common/__tests__/helpers.spec.ts --no-coverage

# Run with verbose output
npx jest --verbose --no-coverage --testPathPatterns __tests__
```

---

## ChatGPT & LLM Integration

Ever Jobs is designed to be used as a tool by ChatGPT, Claude, and other LLMs.

### Quick Start

```bash
# Basic search via JSON stdin
echo '{"searchTerm": "data scientist", "siteType": ["indeed"], "resultsWanted": 5}' | npm run cli -- search --stdin

# Search with analysis
npm run cli -- search --search-term "devops" --site indeed --analyze

# BD intelligence mode
npm run cli -- search --search-term "machine learning" --site linkedin --bd

# Multi-site comparison
npm run cli -- compare --search-term "backend developer" --results 10

# API endpoint for analysis
curl -X POST http://localhost:3001/api/jobs/analyze \
  -H 'Content-Type: application/json' \
  -d '{"searchTerm": "fullstack", "siteType": ["indeed"], "resultsWanted": 10}'
```

### Analytics Features

| Feature         | CLI Flag          | API Endpoint             | Description                           |
| --------------- | ----------------- | ------------------------ | ------------------------------------- |
| Summary stats   | `--analyze`       | `POST /api/jobs/analyze` | Remote %, salary range, top companies |
| BD intelligence | `--bd`            | —                        | Company analysis with hiring velocity |
| Site comparison | `compare` command | —                        | Cross-board metrics comparison table  |

### Prompt Templates

**Job Market Research:**

```
Search for "senior react developer" jobs in San Francisco on Indeed and LinkedIn.
Use the analyze flag to get summary statistics.

Input: {"searchTerm": "senior react developer", "location": "San Francisco, CA", "siteType": ["indeed", "linkedin"], "resultsWanted": 20}
```

**BD Intelligence:**

```
Find companies hiring AI/ML engineers. Identify which companies have the most
open positions and what locations they're hiring in.

Input: {"searchTerm": "AI ML engineer", "siteType": ["indeed", "linkedin"], "resultsWanted": 50}
Use --bd flag for company-level analysis.
```

**Multi-Site Comparison:**

```
Compare results for "data engineer" across all job boards.
Which board has the most listings? Best salary coverage?

Run: npm run cli -- compare --search-term "data engineer" --results 15
```

### Resources

| File                                       | Description                                    |
| ------------------------------------------ | ---------------------------------------------- |
| [`tool_manifest.json`](tool_manifest.json) | Machine-readable tool metadata for MCP servers |

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/new-source`)
3. Implement your source package in `packages/source-<name>/`
4. Ensure it implements the `IScraper` interface
5. Add the module to `apps/api/src/jobs/jobs.module.ts`
6. Submit a pull request

## 🔐 Security

**Ever Jobs** follows good security practices, but 100% security cannot be guaranteed in any software!
**Ever Jobs** is provided AS IS without any warranty. Use at your own risk!

In a production setup, all client-side to server-side (backend, APIs) communications should be encrypted using HTTPS/WSS/SSL (REST APIs, GraphQL endpoint, Socket.io WebSockets, etc.).

If you discover any issue regarding security, please disclose the information responsibly by emailing <mailto:security@ever.co> and not by creating a GitHub issue.

## ⚠️ Legal Disclaimer

**This software is provided for educational and research purposes only.**

### No Warranty

THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS, CONTRIBUTORS, OR COPYRIGHT HOLDERS (INCLUDING EVER CO) BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT, OR OTHERWISE, ARISING FROM, OUT OF, OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

### Data Collection & Unofficial API Risks

Several source modules in this project interact with third-party websites using **unofficial, undocumented APIs** or **HTML parsing techniques**. By using these modules, you acknowledge and accept the following risks:

- **Account suspension or ban** — Your user accounts on job boards (LinkedIn, Indeed, Glassdoor, etc.) may be temporarily or permanently suspended if the platform detects automated access that violates their Terms of Service.
- **IP blocking** — Your IP address may be rate-limited or blocked by target websites.
- **Terms of Service violations** — Automated data collection may violate the Terms of Service of the target platforms. It is **your responsibility** to review and comply with each platform's ToS before using the corresponding source module.
- **Data usage restrictions** — Job listing data obtained through this software may be subject to copyright or other legal protections. You are solely responsible for ensuring your use of the data complies with all applicable laws and regulations.

### Limitation of Liability

Ever Co and the contributors to this project:

- **Do not endorse or encourage** the violation of any website's Terms of Service.
- **Are not responsible** for any consequences resulting from the use of this software, including but not limited to account bans, legal action, data loss, or financial damages.
- **Make no guarantees** about the accuracy, completeness, or reliability of the collected data.
- **Accept no liability** for how this software is used by third parties.

**Use at your own risk.** If you are unsure about the legality of automated data collection from a particular website in your jurisdiction, consult a legal professional before proceeding.

---

## 🛡️ License

MIT © [Ever Co](https://github.com/ever-co)

## ™️ Trademarks

**Ever**® is a registered trademark of [Ever Co. LTD](https://ever.co).
**Ever® Jobs™**, **Ever® Demand™**, **Ever® Gauzy™**, **Ever® Teams™** and **Ever® OpenSaaS™** are all trademarks of [Ever Co. LTD](https://ever.co).

The trademarks may only be used with the written permission of Ever Co. LTD. and may not be used to promote or otherwise market competitive products or services.

All other brand and product names are trademarks, registered trademarks, or service marks of their respective holders.

## 🍺 Contribute

- Please give us a :star: on Github, it **helps**!
- You are more than welcome to submit feature requests in the [separate repo](https://github.com/ever-co/feature-requests/issues)
- Pull requests are always welcome! Please base pull requests against the _develop_ branch and follow the [contributing guide](.github/CONTRIBUTING.MD).

## 💪 Thanks to our Contributors

See our contributors list in [CONTRIBUTORS.md](https://github.com/ever-jobs/ever-jobs/blob/develop/.github/CONTRIBUTORS.md).
You can also view a full list of our [contributors tracked by GitHub](https://github.com/ever-jobs/ever-jobs/graphs/contributors).

<img src="https://contributors-img.web.app/image?repo=ever-jobs/ever-jobs" />

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=ever-jobs/ever-jobs&type=Date)](https://star-history.com/#ever-jobs/ever-jobs&Date)

## Credits

- This project is a TypeScript/NestJS port of the original Python [JobSpy](https://github.com/speedyapply/JobSpy) library by Cullen Watson, re-architected as a modular monorepo for server-side deployment and package reuse.
- Implements many features from [JobSpy-api](https://github.com/rainmanjam/jobspy-api) in TypeScript/NestJS.
- Company-specific and ATS scrapers ported from [ats-scrapers](https://github.com/speedyapply/ats-scrapers).

## ©️ Copyright

#### Copyright © 2026-present, Ever Co. LTD. All rights reserved

## 🔥 P.S

- If you are running any business or doing freelance, check our new project [Ever Gauzy](https://github.com/ever-co/ever-gauzy) - Open Business Management Platform (ERP/CRM/HRM)
- [We are Hiring: remote TypeScript / NodeJS / NestJS / Angular & React developers](https://github.com/ever-co/jobs#available-positions)
