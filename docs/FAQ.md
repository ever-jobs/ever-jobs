# FAQ

## How do I enable Swagger UI?

Set `ENABLE_SWAGGER=true` (default) in your `.env` file. The docs are available at `http://localhost:3000/api/docs`. You can change the path with `SWAGGER_PATH`.

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

## How do I set up rate limiting?

```bash
RATE_LIMIT_ENABLED=true
RATE_LIMIT_REQUESTS=100    # max requests
RATE_LIMIT_TIMEFRAME=3600  # per this many seconds
```

## Can I export results as CSV?

Yes — use the GET endpoint with `?format=csv`:

```
GET /api/v1/search_jobs?search_term=developer&format=csv
```

## How does caching work?

When `ENABLE_CACHE=true`, search results are cached in memory using an MD5 hash of the query parameters. Cache expires after `CACHE_EXPIRY` seconds (default 3600). Cached responses include `"cached": true`.

## How many job sources are supported?

Currently **34 sources**: 17 search-based job boards, 9 ATS integrations, and 7 company-specific scrapers. See the [README](../README.md) for the full list.

## How do I search remote job boards?

The remote-focused job boards (RemoteOK, Remotive, Jobicy, Himalayas, Arbeitnow, We Work Remotely) are included in default searches automatically. You can also target them specifically:

```bash
npm run cli -- search --search-term "typescript" --site remoteok --site remotive --site jobicy
```

## How do I use the new ATS sources (Recruitee, Teamtailor)?

Like all ATS scrapers, they require a `companySlug` parameter:

```bash
# Search a specific company's Recruitee board
npm run cli -- search --company-slug "mycompany" --site recruitee

# Search a specific company's Teamtailor board
npm run cli -- search --company-slug "mycompany" --site teamtailor
```

## What remote job boards have salary data?

RemoteOK and Jobicy provide salary information in their APIs. Remotive includes salary as a text field. Himalayas includes min/max salary when available. For other sources, the salary enrichment pipeline attempts to extract salary from job descriptions.
