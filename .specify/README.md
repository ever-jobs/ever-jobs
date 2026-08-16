# `.specify/` — GitHub Spec Kit Workspace

This directory follows the [GitHub Spec Kit](https://github.com/github/spec-kit) layout.
Every meaningful change to Ever Jobs (new feature, refactor, source addition, infra
change) goes through the **Specify → Plan → Tasks → Implement** loop, with artefacts
stored here.

```
.specify/
├── README.md                # this file
├── memory/
│   └── constitution.md      # immutable design principles for the project
├── specs/
│   └── <NNN>-<slug>/
│       ├── spec.md          # functional spec (what & why)
│       ├── plan.md          # implementation plan (how)
│       ├── tasks.md         # ordered tasks with acceptance criteria
│       └── notes.md         # optional research/scratch
└── templates/
    ├── spec.template.md
    ├── plan.template.md
    └── tasks.template.md
```

## Numbering

`NNN` is a zero-padded incrementing ID (historically 3 digits; higher-numbered
forks use 4). Slugs are kebab-case. Examples:

- `001-plugin-architecture-foundation`
- `002-source-pipeline-batching`
- `010-deduplication-engine`

Numbers are minted **per fork** from a disjoint band so that two forks never
pick the same number. `ranges.json` reserves one band per fork (keyed by its
`origin` repo); run `npm run spec:next` to get the next number for the current
fork — never hand-number. See `.specify/specs/787-fork-spec-range-reservation/`
for the design and `scripts/spec-ranges.ts` for the allocator.

A band may set an optional `policy` in `ranges.json`:

- absent / unknown → default `max-in-band + 1`.
- `reserve-overlaps` → fill gaps and hold the lowest-available numbers open as
  renumber targets for any number that ended up with more than one directory
  (e.g. after a cross-fork merge). `spec:next` prints those reserved numbers on
  stderr.

`docs-lint` enforces the registry on every push/PR: bands stay disjoint, every
spec number sits inside a reserved band, and no two directories share a number
(except a small allow-list of numbers already duplicated across forks before
that check existed).

## Workflow

1. **Specify.** Copy `templates/spec.template.md` → `specs/NNN-<slug>/spec.md`. Fill it out.
2. **Plan.** Copy `templates/plan.template.md` → same dir. Outline phases & risks.
3. **Tasks.** Copy `templates/tasks.template.md` → same dir. Break plan into ≤1-day tasks.
4. **Implement.** Pick the first unchecked task. Cross-reference `AGENTS.md` rules.
5. **Mirror.** Update `docs/index.md` and `docs/log.md`. Add a doc-mirror under
   `docs/specs/<NNN>-<slug>.md` if the spec is human-facing.

## Status Conventions

In `tasks.md`, tasks are checkboxes:

- `- [ ] T01 — Add Foo enum value` → pending
- `- [~] T02 — Implement scraper` → in-progress
- `- [x] T03 — Write unit tests` → done
- `- [-] T04 — Old approach` → dropped (keep, don't delete; explain why)

## Cross-Cutting Concerns

Specs that affect multiple subsystems should reference each other in `notes.md`
under a `## Related` heading.

## Constitution

Always re-read [`memory/constitution.md`](memory/constitution.md) before authoring a
new spec. It encodes non-negotiable design principles.
