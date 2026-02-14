# Roadmap

## Current (v0.1.x)

- ✅ Multi-source job searching (34 sources)
- ✅ API key authentication
- ✅ Rate limiting
- ✅ In-memory caching
- ✅ CSV export and pagination
- ✅ Health check endpoints
- ✅ Docker deployment
- ✅ Swagger / OpenAPI docs
- ✅ CLI application
- ✅ ATS integrations (Ashby, Greenhouse, Lever, Workable, SmartRecruiters, Rippling, Workday, Recruitee, Teamtailor)
- ✅ Company-specific scrapers (Amazon, Apple, Microsoft, Nvidia, TikTok, Uber, Cursor)
- ✅ Remote job boards (RemoteOK, Remotive, Jobicy, Himalayas, Arbeitnow, We Work Remotely)

## Planned (v0.2.0)

- Additional sources: USAJobs, Adzuna, Reed, Jooble, CareerJet (Tier 1.5 — free API key required)
- Redis-backed caching (scalable, persistent)
- WebSocket / SSE support for real-time search progress
- Job deduplication across sources
- Configurable retry policies per source
- Prometheus metrics endpoint (`/metrics`)

## Future Considerations (v0.3.0+)

- Tier 2 sources: Wellfound (AngelList), StepStone, Dice, SimplyHired, JazzHR, Personio, BambooHR
- Tier 3 sources: Monster, CareerBuilder, iCIMS, Oracle Taleo, SAP SuccessFactors
- GraphQL API alongside REST
- OAuth2 authentication
- Frontend dashboard for job search results
- Plugin architecture for community-contributed source modules
- Job alerts / notifications (email, webhook)
- Enterprise features (multi-tenant, audit logs)
