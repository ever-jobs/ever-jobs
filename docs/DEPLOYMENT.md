# Deployment Guide

## Docker Compose (recommended)

```bash
# 1. Copy and edit environment variables
cp .env.example .env

# 2. Build and start
docker compose up -d

# 3. Verify health
curl http://localhost:3001/health
```

## Standalone Docker

```bash
docker build -t ever-jobs-api .
docker run -d \
  --name ever-jobs-api \
  -p 3001:3001 \
  --env-file .env \
  ever-jobs-api
```

## Development (Docker)

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

This mounts your source code for hot-reload and enables debug logging.

## Development (Local)

```bash
npm install
npm run start:dev
```

## Kubernetes (basic example)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ever-jobs-api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: ever-jobs-api
  template:
    metadata:
      labels:
        app: ever-jobs-api
    spec:
      containers:
        - name: api
          image: ever-jobs-api:latest
          ports:
            - containerPort: 3001
          envFrom:
            - configMapRef:
                name: ever-jobs-config
          livenessProbe:
            httpGet:
              path: /health
              port: 3001
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /ping
              port: 3001
            initialDelaySeconds: 5
            periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: ever-jobs-api
spec:
  selector:
    app: ever-jobs-api
  ports:
    - port: 80
      targetPort: 3001
  type: LoadBalancer
```

## Environment Variables

See [`.env.example`](../.env.example) for all configurable options.

## Workday-backed company sources (Specs 1736 / 1737)

55 company plugins (53 large US employers, Spec 1736, plus the Workday-backed
quant firms `gresearch` and `arrowstreetcapital`, Spec 1737) delegate to the
`workday` adapter. They ship **enabled** and run in the default fan-out, as do
the other quant-firm plugins of Spec 1737 (owner decision, 2026-09-26,
Spec 1736 §7 / T16) — except SIG, which stays explicit-only because its
careers host's robots.txt disallows crawlers (Spec 1735 §4.7). No deployment setting is required: the per-board bound
below (`WORKDAY_MAX_DETAIL_FETCHES`, `WORKDAY_SCRAPE_TIME_BUDGET_MS`) caps
what each Workday board can cost.

### Emergency switch (optional; Spec 1736 §7, T16)

If the batch misbehaves in production — a Workday cluster rate-limits the
egress IP, a consumer is flooded, or a board regresses — it can be switched
off without a code change or a rebuild. This is an emergency lever, not a
deploy prerequisite: leave it unset normally. Append to any existing value,
restart, and remove it again once the cause is fixed:

```bash
EVER_JOBS_DISABLED_SOURCES=salesforce,adobe,intel,hp,hpe,mastercard,paypal,capitalone,walmart,target,northropgrumman,boozallen,caci,gdit,leidos,blueorigin,redhat,motorolasolutions,stryker,jnj,philips,mckesson,workdayinc,micron,analogdevices,tmobile,comcast,disney,nike,fidelity,statestreet,blackrock,autodesk,zillow,expediagroup,3m,rtx,humana,cvshealth,chevron,visa,geaerospace,wellsfargo,snap,morganstanley,copart,coxenterprises,broadcom,pfizer,marvell,generalmotors,warnerbrosdiscovery,moderna,gresearch,arrowstreetcapital
```

This is exactly the set of plugins whose service delegates to `Site.WORKDAY`
(checked against the source). The `workday` adapter itself stays registered,
so explicit `siteType: ["workday"]` + `companySlug` searches keep working.
Disabled ids are skipped at registration and logged at boot
(`Skipping disabled plugin: …`); an unknown id logs a warning.

### Per-board bound (Spec 1736 §8, T11)

Workday detail requests are sequential and paced (one in flight, 250–500 ms
apart), so every Workday scrape is bounded:

| Variable | Default | Effect |
| --- | --- | --- |
| `WORKDAY_MAX_DETAIL_FETCHES` | `50` | Detail requests per scrape (per board). Postings past it are returned at list level: no description or compensation. `0` = none. |
| `WORKDAY_SCRAPE_TIME_BUDGET_MS` | `90000` | Budget per scrape over listing and enrichment, measured from the start of that board's scrape. Once spent, no new page or detail request starts; a listing cut short is reported as `partial` in the per-source diagnostics. Capped at 3/4 of the fan-out deadline (below). `0` = none, cap included. |

**The fan-out deadline** is `EVER_JOBS_FANOUT_DEADLINE_MS` (preferred, Spec
1721), with `EVER_JOBS_SEARCH_DEADLINE_MS` (Spec 5026) read when the
preferred name is unset, blank or not a number; 120 000 ms when neither is
set; `0` or negative disables it. Builds from before the list-mode change
(Spec 1721) read only the fallback name, so a deployment that must work on
both sets the preferred one and, if it differs from the default, the
fallback to the same value.

**The Workday budget and the fan-out deadline are separate clocks.** The
deadline runs from the start of the search; the budget runs from the start
of each board's own scrape, which can be well after the search started (the
board waits for a concurrency slot, or is the second board of a multi-board
plugin such as Visa). Keep `WORKDAY_SCRAPE_TIME_BUDGET_MS` below the
deadline the deployment sets; the adapter also caps it at 3/4 of the
fan-out deadline it reads from the same variables (90 s of the default
120 s), so lowering the deadline alone cannot leave a board running for
longer than the search waits. A board that starts late can still be
abandoned by the deadline; the budget then bounds how long it runs on,
detached, not when it ends.

A full sync that needs every description raises all three together
(`WORKDAY_MAX_DETAIL_FETCHES`, `WORKDAY_SCRAPE_TIME_BUDGET_MS` and the
fan-out deadline) and selects the boards explicitly (`siteType`).

**Key Workday postings on `id`.** A posting is enriched while it is among a
board's first `WORKDAY_MAX_DETAIL_FETCHES` and returned at list level once newer
postings push it past the cap. Both copies carry the same `id` (the
requisition id) and the same title, company and location, but a list-level
copy can still differ where the search row cannot know what the detail says
(several locations, a newer relative posted date). A consumer that stores
these postings upserts on `id` and lets a later enriched copy fill in the
description (Spec 1736 §8.1).
