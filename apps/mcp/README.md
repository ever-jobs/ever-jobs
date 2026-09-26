# Ever Jobs MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that lets AI assistants like **ChatGPT**, **Claude**, **GitHub Copilot**, and others search for jobs across **65+ sources** — including LinkedIn, Indeed, Glassdoor, company career pages, and ATS platforms.

## Quick Start

### Install & Run

```bash
# From the ever-jobs monorepo root
cd apps/mcp
npm install
npm run build
npm start          # starts the MCP server in stdio mode
```

### Connect to Claude Desktop

Add to your Claude Desktop config (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ever-jobs": {
      "command": "node",
      "args": ["<path-to>/ever-jobs/apps/mcp/dist/index.js"],
      "env": {
        "EVER_JOBS_API_URL": "http://localhost:3001"
      }
    }
  }
}
```

### Connect to ChatGPT / Other Clients

Use any MCP-compatible client. The server communicates via **stdio** (standard input/output).

## Tools

### `search_jobs`

Search for jobs across all sources.

| Parameter     | Type    | Required | Description                                        |
| ------------- | ------- | -------- | -------------------------------------------------- |
| `query`       | string  | ✅       | Job search query (e.g. "software engineer")        |
| `location`    | string  | ❌       | Location filter (e.g. "San Francisco", "Remote")   |
| `source`      | string  | ❌       | Specific source id (use `list_sources` to see all) |
| `company`     | string  | ❌       | Company slug for ATS sources (e.g. "stripe")       |
| `limit`       | number  | ❌       | Max results (default: 20, max: 100)                |
| `remote_only` | boolean | ❌       | Filter to remote positions only                    |
| `crawl`       | object  | ❌       | Per-request crawl policy (Spec 1690), camelCase    |

`crawl` is forwarded to the API unchanged as the `crawl` field (same key in every
`EVER_JOBS_MCP_REQUEST_KEYS` style); see [`docs/CRAWL_POLICY.md`](../../docs/CRAWL_POLICY.md).

### `get_job_details`

Get detailed information about a specific job posting.

| Parameter | Type   | Required | Description                 |
| --------- | ------ | -------- | --------------------------- |
| `job_url` | string | ❌       | Full URL of the job posting |
| `job_id`  | string | ❌       | Ever Jobs internal job ID   |

### `list_sources`

List all available job sources.

| Parameter | Type   | Required | Description                                                          |
| --------- | ------ | -------- | -------------------------------------------------------------------- |
| `type`    | string | ❌       | Filter: `all`, `job_board`, `ats`, `company`, `remote`, `aggregator` |

### `search_remote_jobs`

Search for remote-only positions across all remote-first job boards (RemoteOK, Remotive, We Work Remotely, Jobicy, Himalayas, Arbeitnow).

| Parameter | Type   | Required | Description                      |
| --------- | ------ | -------- | -------------------------------- |
| `query`   | string | ✅       | Job search query                 |
| `source`  | string | ❌       | Specific remote source to target |
| `limit`   | number | ❌       | Max results (default: 25)        |

### `get_salary_insights`

Aggregate salary data from job search results. Returns min, max, median, P25, and P75 salary statistics.

| Parameter  | Type   | Required | Description                            |
| ---------- | ------ | -------- | -------------------------------------- |
| `query`    | string | ✅       | Job title/role to research             |
| `location` | string | ❌       | Location to focus on                   |
| `limit`    | number | ❌       | Number of jobs to sample (default: 50) |

### `compare_sources`

Compare all available job sources by type. Returns a breakdown of sources grouped by category (job board, ATS, company, remote, aggregator) with counts.

_No parameters required._

## Resources

| URI                  | Description                        |
| -------------------- | ---------------------------------- |
| `everjobs://sources` | Complete list of available sources |
| `everjobs://guide`   | Search tips and usage guide        |

## Environment Variables

| Variable                        | Default                 | Description                                                                                                                                                                  |
| ------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVER_JOBS_API_URL`             | `http://localhost:3001` | Ever Jobs API endpoint                                                                                                                                                       |
| `EVER_JOBS_MCP_LOCATION_FORMAT` | `full`                  | How a job's `location` string is rendered: `full` = `city, state, country` (falling back to the site name, then its label text); `city` = the legacy city-only string        |
| `EVER_JOBS_MCP_REQUEST_KEYS`    | `camel`                 | Search request key style sent to the API: `camel` (what `ScraperInputDto` accepts), `snake` (the legacy wire shape), `both`                                                  |

Remote-only jobs: whether their `location` reads `Remote` depends on the API's
`EVER_JOBS_LOCATION_REMOTE_CITY` (default `false` — a bare `Remote` label gives
`null` and `Remote - US` gives `United States`, with `is_remote` carrying the
signal; `true` restores `Remote` / `Remote, United States`). See `.env.example`.

## Source Coverage

- **21** Job Boards (LinkedIn, Indeed, Glassdoor, Dice, Monster, Upwork, Exa, BuiltIn, Snagajob, Dribbble, ...)
- **6** Remote Job Boards (RemoteOK, Remotive, We Work Remotely, Jobicy, Himalayas, Arbeitnow)
- **4** Aggregator APIs (Adzuna, Reed, Jooble, CareerJet)
- **22** ATS Platforms (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Rippling, Workday, ...)
- **12** Company Career Pages (Google, Meta, Netflix, Stripe, OpenAI, Amazon, Apple, Microsoft, NVIDIA, TikTok, Uber, Cursor)

**Total: 65 sources**
