# Ever Jobs CLI

Command-line interface for searching and comparing job postings from 65+ job boards.

Built with [nest-commander](https://docs.nestjs.com/recipes/nest-commander) on the Ever Jobs scraping engine.

## Installation

```bash
# From the monorepo root
yarn install
yarn build cli
```

## Commands

### `search` — Search Job Postings

Search one or more job boards for matching positions.

```bash
ever-jobs search [options]
```

#### Basic Examples

```bash
# Search LinkedIn for "React developer"
ever-jobs search -s linkedin -q "React developer"

# Multi-site search with location filter
ever-jobs search -s linkedin -s indeed -q "DevOps" -l "New York"

# Remote-only, last 24 hours, top 20 results
ever-jobs search -s linkedin -q "Python" -r --hours-old 24 -n 20

# Output as CSV file
ever-jobs search -s indeed -q "Data Scientist" -f csv -o results.csv

# Table view for quick scanning
ever-jobs search -s glassdoor -q "Product Manager" -f table

# ATS board scraping (company-specific)
ever-jobs search -s ashby --company-slug stripe -n 50
ever-jobs search -s greenhouse --company-slug github -n 50
ever-jobs search -s workday --company-slug "tesla:5:Tesla" -n 30
```

#### LLM / Programmatic Usage (stdin)

The CLI accepts JSON input via stdin for integration with LLMs and scripts:

```bash
echo '{"siteType":["linkedin","indeed"],"searchTerm":"ML Engineer","isRemote":true}' | ever-jobs search --stdin

# Pipe from a file
cat search-params.json | ever-jobs search --stdin -f csv -o output.csv
```

#### BD Intelligence Mode

Analyze hiring patterns across companies instead of listing individual jobs:

```bash
ever-jobs search -s linkedin -q "Engineering" --bd
```

#### Analysis Mode

Append salary, remote %, and company analytics after results:

```bash
ever-jobs search -s linkedin -s indeed -q "Backend" --analyze
```

#### Full Options Reference

| Flag                           | Short | Argument     | Default  | Description                                      |
| ------------------------------ | ----- | ------------ | -------- | ------------------------------------------------ |
| `--site`                       | `-s`  | `[sites...]` | all      | Sites to search (see Sources below)              |
| `--search-term`                | `-q`  | `<term>`     | —        | Job search keywords                              |
| `--google-search-term`         | —     | `<term>`     | —        | Google-specific search query override            |
| `--location`                   | `-l`  | `<location>` | —        | Location to search near                          |
| `--distance`                   | `-d`  | `<miles>`    | 50       | Search radius in miles                           |
| `--remote`                     | `-r`  | —            | false    | Filter for remote jobs only                      |
| `--job-type`                   | —     | `<type>`     | —        | `fulltime`, `parttime`, `internship`, `contract` |
| `--easy-apply`                 | —     | —            | false    | Filter for easy-apply / hosted jobs              |
| `--results`                    | `-n`  | `<count>`    | 15       | Results wanted per site                          |
| `--offset`                     | —     | `<n>`        | 0        | Skip first N results                             |
| `--hours-old`                  | —     | `<hours>`    | —        | Max job age in hours                             |
| `--country`                    | `-c`  | `<code>`     | USA      | Country for Indeed/Glassdoor domain              |
| `--description-format`         | —     | `<fmt>`      | markdown | `markdown`, `html`, `plain`                      |
| `--linkedin-fetch-description` | —     | —            | false    | Fetch full LinkedIn descriptions (slower)        |
| `--linkedin-company-ids`       | —     | `[ids...]`   | —        | Filter LinkedIn by company IDs                   |
| `--enforce-annual-salary`      | —     | —            | false    | Convert all wages to annual equivalent           |
| `--timeout`                    | —     | `<seconds>`  | 60       | Request timeout per source                       |
| `--proxy`                      | `-p`  | `[urls...]`  | —        | Proxy URLs for rotation                          |
| `--ca-cert`                    | —     | `<path>`     | —        | CA certificate path for proxies                  |
| `--user-agent`                 | —     | `<ua>`       | —        | Custom User-Agent string (implies `--user-agent-mode strict` unless one is given) |
| `--rate-delay-min`             | —     | `<seconds>`  | —        | Minimum delay between requests (per host bucket) |
| `--rate-delay-max`             | —     | `<seconds>`  | —        | Maximum delay between requests                   |
| `--format`                     | `-f`  | `<format>`   | json     | `json`, `csv`, `table`, `summary`                |
| `--output`                     | `-o`  | `<file>`     | stdout   | Write output to file                             |
| `--verbose`                    | `-v`  | —            | false    | Enable verbose debug output                      |
| `--no-description`             | —     | —            | false    | Omit descriptions (reduces size for LLMs)        |
| `--analyze`                    | —     | —            | false    | Append analytics after results                   |
| `--bd`                         | —     | —            | false    | BD intelligence mode (company analysis)          |
| `--stdin`                      | —     | —            | false    | Read JSON input from stdin                       |
| `--company-slug`               | —     | `<slug>`     | —        | Company slug for ATS board scraping              |
| `--upwork-auth-json`           | —     | `<json>`     | —        | Upwork auth as JSON string                       |
| `--crawl`                      | —     | `<json>`     | —        | Per-request crawl policy (any field; see [CRAWL_POLICY.md](./CRAWL_POLICY.md)) |
| `--user-agent-mode`            | —     | `<mode>`     | identify | `identify`, `strict`, `plugin`                   |
| `--proxy-rotation`             | —     | `<mode>`     | per-host | `per-host`, `per-scrape`, `per-request`, `off`   |
| `--max-per-host`               | —     | `<n>`        | 4        | Max requests in flight per host bucket (0 = unlimited) |
| `--min-interval-ms`            | —     | `<ms>`       | 100      | Minimum gap between request starts per host bucket |
| `--crawl-retries`              | —     | `<n>`        | 2        | Retries per request on 429/5xx                   |
| `--robots-txt`                 | —     | `<mode>`     | off      | `off`, `crawl-delay`, `respect`                  |
| `--discovery`                  | —     | `<mode>`     | auto     | `auto`, `sitemap`, `listing` (e.g. Softy)        |
| `--crawl-preset`               | —     | `<preset>`   | polite   | `polite`, `legacy` (pre-1690), `strict` — sets `EVER_JOBS_CRAWL_PRESET` for this run |
| `--caller-overrides`           | —     | `<mode>`     | any      | `any`, `stricter`, `none` — sets `EVER_JOBS_CRAWL_CALLER_OVERRIDES` for this run |

---

### `compare` — Cross-Board Comparison

Search all 65+ boards individually and compare results side-by-side.

```bash
ever-jobs compare [options]
```

#### Examples

```bash
# Compare "React developer" across all sites
ever-jobs compare -q "React developer"

# Compare with location filter, save to file
ever-jobs compare -q "DevOps" -l "San Francisco" -o comparison.json

# Remote jobs only, last 48 hours
ever-jobs compare -q "ML Engineer" -r --hours-old 48
```

#### Output

The compare command outputs:

1. **stderr**: A table comparing each site (total jobs, with salary, remote, unique companies)
2. **stdout**: Full JSON with site comparison data and aggregated summary

#### Options

| Flag               | Short | Argument     | Default           | Description          |
| ------------------ | ----- | ------------ | ----------------- | -------------------- |
| `--search-term`    | `-q`  | `<term>`     | software engineer | Search keywords      |
| `--location`       | `-l`  | `<location>` | —                 | Location filter      |
| `--results`        | `-n`  | `<count>`    | 15                | Results per site     |
| `--country`        | `-c`  | `<code>`     | USA               | Country domain       |
| `--hours-old`      | —     | `<hours>`    | —                 | Max job age          |
| `--remote`         | `-r`  | —            | false             | Remote only          |
| `--job-type`       | —     | `<type>`     | —                 | Job type filter      |
| `--rate-delay-min` | —     | `<seconds>`  | —                 | Min request delay    |
| `--rate-delay-max` | —     | `<seconds>`  | —                 | Max request delay    |
| `--crawl` and the other crawl flags | — | — | — | Same as `search` (`--crawl`, `--user-agent-mode`, `--proxy-rotation`, `--max-per-host`, `--min-interval-ms`, `--crawl-retries`, `--robots-txt`, `--discovery`, `--crawl-preset`, `--caller-overrides`) |
| `--output`         | `-o`  | `<file>`     | stdout            | Write output to file |
| `--verbose`        | `-v`  | —            | false             | Verbose output       |

---

## Output Formats

### JSON (default)

```json
[
  {
    "id": "abc123",
    "site": "linkedin",
    "title": "Senior React Developer",
    "companyName": "Acme Corp",
    "location": { "city": "San Francisco", "state": "CA", "country": "US" },
    "jobUrl": "https://linkedin.com/jobs/...",
    "datePosted": "2025-02-15",
    "isRemote": true,
    "compensation": {
      "minAmount": 150000,
      "maxAmount": 200000,
      "currency": "USD",
      "interval": "yearly"
    }
  }
]
```

### CSV

Flat columns: `id, site, title, companyName, location, jobUrl, datePosted, jobType, isRemote, minAmount, maxAmount, currency, interval, description`

### Table

```
Site         │ Title                                   │ Company                  │ Location                 │ Posted       │ Remote
─────────────┼─────────────────────────────────────────┼──────────────────────────┼──────────────────────────┼──────────────┼───────
linkedin     │ Senior React Developer                  │ Acme Corp                │ San Francisco, CA        │ 2025-02-15   │ Yes
```

### Summary

```
=== Job Search Summary ===
Total jobs found: 45
Remote positions: 12
With salary data: 28

--- By Source ---
  linkedin: 15
  indeed: 18
  glassdoor: 12

--- By Job Type ---
  fulltime: 30
  contract: 15
```

---

## Supported Sites

### General Job Boards (34)

linkedin, indeed, glassdoor, zip_recruiter, google, bayt, naukri, bdjobs, internshala, exa, upwork, and more.

### ATS Boards (13)

ashby, greenhouse, lever, workable, smartrecruiters, rippling, workday, and more.

Requires `--company-slug` to specify which company board to scrape.

### Regional (8)

Country-specific boards for specialized regional searches.

### Company-Specific (10)

Direct company career page scrapers (Amazon, Apple, Microsoft, Nvidia, etc.).

> See the full source inventory in the [main README](../README.md).

---

## Environment Variables

| Variable                       | Description                                            |
| ------------------------------ | ------------------------------------------------------ |
| `EVER_JOBS_API_URL`            | API base URL (default: `http://localhost:3001`)        |
| `HTTP_PROXY` / `HTTPS_PROXY`   | Global proxy configuration                             |
| `EVER_JOBS_CRAWL_*`            | Crawl policy (identity, pacing, proxies, retries, robots.txt, egress guard) — the CLI obeys the same variables as the API; full list in [CRAWL_POLICY.md](./CRAWL_POLICY.md) |
| `NODE_TLS_REJECT_UNAUTHORIZED` | Set to `0` to skip TLS verification (development only) |
