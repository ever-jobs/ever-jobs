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
`workday` adapter and run in the default fan-out.

### Deploy gate (Spec 1736 §7, T10)

A consumer that keeps only page 1 of a response sorted by site name (ever-hust
today: 80 jobs) sees `3m` first — about 700 3M postings — once these plugins
are deployed. Until that consumer ingests full results (NDJSON stream or every
page), deploy with the batch switched off. No code change, one line; append to
any existing value and remove it once the consumer is live:

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
| `WORKDAY_MAX_DETAIL_FETCHES` | `50` | Detail requests per scrape (per board). Postings past it are returned at list level: no description, compensation or hiring organisation. `0` = none. |
| `WORKDAY_SCRAPE_TIME_BUDGET_MS` | `90000` | Budget per scrape over listing and enrichment. Once spent, no new page or detail request starts; a listing cut short is reported as `partial` in the per-source diagnostics. `0` = none. |

Keep `WORKDAY_SCRAPE_TIME_BUDGET_MS` below the fan-out deadline
(`EVER_JOBS_SEARCH_DEADLINE_MS`, 120 000 by default). A full sync that needs
every description raises all three together and selects the boards
explicitly (`siteType`).
