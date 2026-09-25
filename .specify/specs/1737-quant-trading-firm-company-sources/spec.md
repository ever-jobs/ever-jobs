# Spec 1737 — Quant / Trading-Firm Company Sources (31 firms)

| Field | Value |
| --- | --- |
| Spec ID | 1737 |
| Slug | quant-trading-firm-company-sources |
| Status | implemented |
| Owner | agent (lane ej-sources) |
| Created | 2026-09-24 |
| Last updated | 2026-09-25 |
| Related specs | 1735 (pipeline), 1736 (Workday company sources) |

## 1. Problem statement

Quantitative trading firms, market makers and systematic hedge funds run some
of the most competitive intern and new-grad programmes in software, research
and trading, and they post them early. Ever Jobs had almost none of them as
company sources, so a consumer asking for "software engineer intern" saw Jane
Street, Hudson River Trading or Optiver roles only when some job board
happened to mirror them.

## 2. Scope

31 company plugins, each delegating to an existing ATS adapter through the
registry (Spec 1735): 26 on Greenhouse, 2 on Workday, 1 on Lever, 1 on Ashby,
1 on iCIMS. Chicago Trading Company delegates to two Greenhouse boards,
campus first. Every board was verified live on 2026-09-24.

All plugins are tagged `segment=quant-trading` in their description (Spec 1735
§4.3) so a later company-tier feature can select them; the seed file carries
the same tag machine-readably.

## 3. Non-goals — firms not covered, and why

No bespoke scraper was written: every covered firm is on a supported ATS, and
none of the remaining firms exposes a simple public listing that a supported
adapter can read (Q-109).

| Firm | Finding (2026-09-24) |
| --- | --- |
| Citadel, Citadel Securities | Own careers sites (`citadel.com/careers`, `citadelsecurities.com/careers`); no supported ATS board found. Candidate for a bespoke scraper if the listing is simple and public. |
| D. E. Shaw | Own careers site (`deshaw.com/careers/<id>`); no supported ATS board found. |
| Two Sigma | Avature portal at `careers.twosigma.com/careers/OpenRoles`; the Avature adapter's fixed `/careers/SearchJobs/` path answers HTTP 404 there. Needs a configurable listing path in the adapter. |
| Millennium | Its Workday site (`mlp:5:mlpcareers`) answers 0 postings; careers moved to `career.mlp.com`. |
| AQR | Workday site `aqr:1:AQRexternalcareers` answers HTTP 401 to anonymous requests. |
| Balyasny | Careers on a Salesforce Experience Cloud site; no supported adapter. |
| PEAK6, Wolverine Trading | No public ATS board found (Greenhouse guesses 404). |
| Man Group | No public ATS board found. |

## 4. Contracts

- `Site.<KEY> = '<key>'`, `category: 'company'`, `companyDomains` = the firm's
  domain(s); where the domain-derived token differs from the key the domain is
  declared (`qube-rt.com` → `qube_rt`, `tower-research.com` →
  `towerresearchcapital`, `squarepoint-capital.com` → `squarepoint`,
  `vaticlabs.ai` → `vaticlabs`, `gravitontrading.com` /
  `gravitonresearch.com` → `gravitonresearchcapital`).
- Delegation, id rewrite (`gh-` / `lever-` / `ashby-` / `wd-{tenant}-` /
  `icims-careers-sig-` → `<key>-`), diagnostics and tags as Spec 1735.
- **SIG is explicit-only** (Spec 1735 §3.1, §4.7): `careers-sig.icims.com/robots.txt`
  disallows every crawler (`User-agent: *`, `Disallow: /`, checked 2026-09-25),
  so the plugin never runs in the default fan-out. It scrapes only when a
  caller selects it (`siteType: ['sig']` or `companyDomain: ['sig.com']`);
  otherwise it returns an empty result with an `empty` diagnostic naming the
  reason, without a request. Decision recorded in Q-109.
- No caller credential is forwarded (`auth: undefined`, Spec 1735 §4.5), and
  `source-ats-greenhouse` uses the env Harvest key only for the board named by
  `GREENHOUSE_HARVEST_BOARD`, so the 26 Greenhouse plugins always read their
  own public board — never the operator's Harvest account.
- Greenhouse boards return the whole board in one request (the adapter asks
  for `content=true`), so these plugins cost one request per call; the Workday
  ones cost what Spec 1736 describes; iCIMS pages at 20 per request.

## 5. Verified boards

For iCIMS the probe reads the first page only (20 postings); SIG's board has
more.

| Plugin (`Site`) | Company | Platform | Board (slug / tenant:wd:site) | Verified | Jobs seen |
| --- | --- | --- | --- | --- | --- |
| `hudsonrivertrading` | Hudson River Trading | Greenhouse | `wehrtyou` | 2026-09-24 | 85 |
| `jumptrading` | Jump Trading | Greenhouse | `jumptrading` | 2026-09-24 | 114 |
| `optiver` | Optiver | Greenhouse | `optiverus` | 2026-09-24 | 165 |
| `drw` | DRW | Greenhouse | `drweng` | 2026-09-24 | 165 |
| `akunacapital` | Akuna Capital | Greenhouse | `akunacapital` | 2026-09-24 | 42 |
| `fiverings` | Five Rings | Greenhouse | `fiveringsllc` | 2026-09-24 | 16 |
| `oldmissioncapital` | Old Mission | Greenhouse | `oldmissioncapital` | 2026-09-24 | 37 |
| `xtxmarkets` | XTX Markets | Greenhouse | `xtxmarketstechnologies` | 2026-09-24 | 9 |
| `point72` | Point72 | Greenhouse | `point72` | 2026-09-24 | 220 |
| `bridgewater` | Bridgewater Associates | Greenhouse | `bridgewater89` | 2026-09-24 | 14 |
| `radixtrading` | Radix Trading | Greenhouse | `radixexperienced` | 2026-09-24 | 7 |
| `headlandstech` | Headlands Technologies | Greenhouse | `headlandstechnologiesllc` | 2026-09-24 | 8 |
| `belvederetrading` | Belvedere Trading | Lever | `belvederetrading` | 2026-09-24 | 21 |
| `chicagotrading` | Chicago Trading Company | Greenhouse | `chicagotradingcampus` (campus) | 2026-09-24 | 8 |
| `chicagotrading` | Chicago Trading Company | Greenhouse | `chicagotrading` (lateral) | 2026-09-24 | 25 |
| `flowtraders` | Flow Traders | Greenhouse | `flowtraders` | 2026-09-24 | 48 |
| `mavensecurities` | Maven Securities | Greenhouse | `mavensecuritiesholdingltd` | 2026-09-24 | 45 |
| `qube_rt` | Qube Research & Technologies | Greenhouse | `quberesearchandtechnologies` | 2026-09-24 | 201 |
| `gresearch` | G-Research | Workday | `gresearch:103:G-Research` | 2026-09-24 | 64 |
| `arrowstreetcapital` | Arrowstreet Capital | Workday | `arrowstreetcapital:5:Arrowstreet` | 2026-09-24 | 23 |
| `voleon` | The Voleon Group | Ashby | `voleon` | 2026-09-24 | 55 |
| `worldquant` | WorldQuant | Greenhouse | `worldquant` | 2026-09-24 | 102 |
| `schonfeld` | Schonfeld | Greenhouse | `schonfeld` | 2026-09-24 | 79 |
| `genevatrading` | Geneva Trading | Greenhouse | `genevatrading` | 2026-09-24 | 15 |
| `vaticlabs` | Vatic Labs | Greenhouse | `vaticlabs` | 2026-09-24 | 8 |
| `sig` | Susquehanna International Group (SIG) | iCIMS | `careers-sig` | 2026-09-24 | 20+ |
| `towerresearchcapital` | Tower Research Capital | Greenhouse | `towerresearchcapital` | 2026-09-24 | 91 |
| `imc` | IMC Trading | Greenhouse | `imc` | 2026-09-24 | 172 |
| `janestreet` | Jane Street | Greenhouse | `janestreet` | 2026-09-24 | 228 |
| `squarepoint` | Squarepoint Capital | Greenhouse | `squarepointcapital` | 2026-09-24 | 89 |
| `virtu` | Virtu Financial | Greenhouse | `virtu` | 2026-09-24 | 49 |
| `gravitonresearchcapital` | Graviton Research Capital | Greenhouse | `gravitonresearchcapital` | 2026-09-24 | 19 |

The raw record is `scripts/seeds/ats-delegate-company-verification.json`.

## 6. Test plan

Identical to Spec 1736 §6, run against the real Greenhouse, Lever, Ashby,
Workday and iCIMS adapters with mocked HTTP serving the recorded listings.
For iCIMS the 404 case asserts only an empty result: the adapter treats a 4xx
board as an unknown tenant and returns a bare empty response. Chicago Trading
Company additionally runs the multi-board block (order, remaining budget,
early stop, cross-board de-duplication, partial outage).
