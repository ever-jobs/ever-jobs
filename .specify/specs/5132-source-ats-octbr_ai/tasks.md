# Tasks 5132 — Source ATS Plugin: Octbr (octbr.ai)

- [x] Scaffold package `source-ats-octbr_ai` (package.json, tsconfig.json,
      src/{index,module,constants,types,service}.ts)
- [x] Register `Site.OCTBR_AI`, `ALL_SOURCE_MODULES`, tsconfig path,
      jest moduleNameMapper
- [x] Unit tests: listing data-page fixture → 15 jobs; detail fixture →
      description + datePosted; slug missing → empty; bad HTML → classified error
- [x] jest + tsc + lint:docs green
- [x] docs/index.md row + docs/log.md entry
- [x] Live scrape of `starcloud` slug → 15 jobs
