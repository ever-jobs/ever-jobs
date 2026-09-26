# FAQ

## How do I enable Swagger UI?

Set `ENABLE_SWAGGER=true` (default) in your `.env` file. Swagger UI is at `http://localhost:3001/swg` and the Scalar API docs are at `http://localhost:3001/docs`. You can change the paths with `SWAGGER_PATH` and `SCALAR_PATH`.

## Where are logs stored?

Logs are written to stdout/stderr by default. In Docker, a `./logs` volume is mounted at `/app/logs`. Set `LOG_LEVEL` to `debug`, `info`, `warn`, or `error`.

## How do I customize default search parameters?

Set environment variables in `.env`:

```bash
DEFAULT_SITE_NAMES=linkedin,indeed
DEFAULT_RESULTS_WANTED=10
DEFAULT_DISTANCE=25
DEFAULT_DESCRIPTION_FORMAT=html
DEFAULT_COUNTRY=UK
```

## How do I debug environment variables?

Check the `/health` endpoint — it returns the current environment name. For full config, start the server with `LOG_LEVEL=debug` and check the startup logs.

## How do I enable API key authentication?

```bash
ENABLE_API_KEY_AUTH=true
API_KEYS=key1,key2,key3
```

Then include `x-api-key: key1` in request headers.

## How does Ever Jobs identify itself, and how fast does it crawl?

By default every request carries `Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)`
and is paced per host (4 in flight, 100 ms apart), backs off on 429/`Retry-After`, and uses one
stable proxy per site. Add your contact with `EVER_JOBS_CRAWL_CONTACT`, change anything per site,
host or request, or restore the pre-1690 behaviour with `EVER_JOBS_CRAWL_PRESET=legacy`. See
[CRAWL_POLICY.md](./CRAWL_POLICY.md).

## How do I set up rate limiting?

_This section is about limiting **incoming** API requests. Outgoing requests to job sites are
paced by the crawl policy (above)._

```bash
RATE_LIMIT_ENABLED=true
RATE_LIMIT_REQUESTS=100    # max requests
RATE_LIMIT_TIMEFRAME=3600  # per this many seconds
```

## Can I export results as CSV?

Yes — add `?format=csv` to the search endpoint:

```bash
curl -X POST http://localhost:3001/api/jobs/search?format=csv \
  -H 'Content-Type: application/json' \
  -d '{"searchTerm": "developer"}'
```

## How does caching work?

When `ENABLE_CACHE=true`, search results are cached in memory using an MD5 hash of the query parameters. Cache expires after `CACHE_EXPIRY` seconds (default 3600). Cached responses include `"cached": true`.

## How many job sources are supported?

Currently **160 sources**: 107 search-based job boards, 38 ATS integrations, and 15 company-specific scrapers. See the [README](../README.md) for the full list.

## How do I search remote job boards?

The remote-focused job boards (RemoteOK, Remotive, Jobicy, Himalayas, Arbeitnow, We Work Remotely) are included in default searches automatically. You can also target them specifically:

```bash
npm run cli -- search --search-term "typescript" --site remoteok --site remotive --site jobicy
```

## How do I use ATS sources?

All 38 ATS scrapers require a `companySlug` parameter to target a specific company's career board:

```bash
# Search a specific company's Greenhouse board
npm run cli -- search --company-slug "stripe" --site greenhouse

# Search a specific company's Lever board
npm run cli -- search --company-slug "figma" --site lever
```

When `companySlug` is provided without explicit `siteType`, all ATS scrapers run automatically.

## What remote job boards have salary data?

RemoteOK and Jobicy provide salary information in their APIs. Remotive includes salary as a text field. Himalayas includes min/max salary when available. For other sources, the salary enrichment pipeline attempts to extract salary from job descriptions.
