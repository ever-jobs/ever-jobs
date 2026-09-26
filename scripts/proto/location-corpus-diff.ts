/**
 * PROTOTYPE runner — feeds every location label set found in a cached board
 * payload corpus through parseLocationList (current) and parseLocationListV2
 * (proposed) and writes a JSONL diff + summary counts.
 *
 * Usage:
 *   npx ts-node --project tsconfig.base.json -r tsconfig-paths/register \
 *     scripts/proto/location-corpus-diff.ts <corpusDir> <outDir>
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseLocationList } from '../../packages/common/src/utils/location-parser';
import { parseLocationListV2 } from './location-parser-v2';

interface InputCase {
  key: string;
  labels: string[];
  source: string;
}

function collectCases(corpusDir: string): Map<string, InputCase> {
  const cases = new Map<string, InputCase>();
  const push = (labels: Array<string | null | undefined>, source: string) => {
    const cleaned = labels
      .map((l) => (typeof l === 'string' ? l.trim() : ''))
      .filter((l): l is string => l.length > 0);
    if (!cleaned.length) return;
    const key = JSON.stringify(cleaned);
    if (!cases.has(key)) cases.set(key, { key, labels: cleaned, source });
  };

  const files: string[] = [];
  for (const domain of fs.readdirSync(corpusDir)) {
    const dir = path.join(corpusDir, domain);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('jobs_') && f.endsWith('.json')) files.push(path.join(dir, f));
    }
  }

  for (const file of files) {
    const domain = path.basename(path.dirname(file));
    let doc: unknown;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const jobs: unknown[] = Array.isArray(doc)
      ? doc
      : Array.isArray((doc as { jobs?: unknown[] }).jobs)
        ? (doc as { jobs: unknown[] }).jobs
        : [];
    const ats = (doc as { ats?: string }).ats ?? 'api';

    for (const job of jobs) {
      if (typeof job !== 'object' || job === null) continue;
      const j = job as Record<string, unknown>;
      const src = `${domain}#${ats}`;

      if (typeof j.locationsText === 'string') push([j.locationsText], src);
      if (typeof j.location === 'string') push([j.location], src);
      if (j.location && typeof j.location === 'object') {
        const loc = j.location as Record<string, unknown>;
        if (typeof loc.name === 'string') push([loc.name], src);
        // post-parse merged blob: whole city string is one input; append the
        // country as a segment to approximate the original label list
        if (typeof loc.city === 'string' && loc.city) {
          const labels = [loc.city];
          if (typeof loc.country === 'string' && loc.country) labels.push(loc.country);
          push(labels, src);
        }
      }
      if (Array.isArray(j.secondaryLocations)) {
        const labels = (j.secondaryLocations as Array<Record<string, unknown>>)
          .map((s) => (typeof s?.location === 'string' ? s.location : null))
          .filter((l): l is string => Boolean(l));
        if (labels.length) {
          if (typeof j.location === 'string') push([j.location, ...labels], src);
          else push(labels, src);
        }
      }
      if (Array.isArray(j.locations)) {
        const labels = (j.locations as Array<Record<string, unknown>>)
          .map((l) => (typeof l?.name === 'string' ? l.name : null))
          .filter((l): l is string => Boolean(l));
        if (labels.length) push(labels, src);
      }
      const cats = j.categories as Record<string, unknown> | undefined;
      if (cats) {
        if (Array.isArray(cats.allLocations)) {
          push(cats.allLocations as string[], src);
        } else if (typeof cats.location === 'string') {
          push([cats.location], src);
        }
      }
      if (Array.isArray(j.offices)) {
        for (const o of j.offices as Array<Record<string, unknown>>) {
          if (typeof o?.name === 'string') push([o.name], src);
        }
      }
    }
  }
  return cases;
}

function main(): void {
  const [corpusDir, outDir] = process.argv.slice(2);
  if (!corpusDir || !outDir) {
    console.error('usage: location-corpus-diff <corpusDir> <outDir>');
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const cases = collectCases(corpusDir);
  const diffPath = path.join(outDir, 'diff.jsonl');
  const out = fs.createWriteStream(diffPath);
  let changed = 0;
  const changedLocation = { n: 0 };
  const changedLocations = { n: 0 };

  for (const c of cases.values()) {
    const v1 = parseLocationList(c.labels);
    const v2 = parseLocationListV2(c.labels);
    const locSame = JSON.stringify(v1.location) === JSON.stringify(v2.location);
    const locsSame = JSON.stringify(v1.locations) === JSON.stringify(v2.locations);
    if (locSame && locsSame) continue;
    changed += 1;
    if (!locSame) changedLocation.n += 1;
    if (!locsSame) changedLocations.n += 1;
    out.write(
      JSON.stringify({
        source: c.source,
        input: c.labels,
        locationNow: v1.location,
        locationProposed: v2.location,
        locationsNow: v1.locations,
        locationsProposed: v2.locations,
        remoteNow: { remote: v1.remoteMentioned, wfh: v1.workFromHomeType },
        remoteProposed: { remote: v2.remoteMentioned, wfh: v2.workFromHomeType },
      }) + '\n',
    );
  }
  out.end();

  const summary = {
    uniqueInputs: cases.size,
    changed,
    unchanged: cases.size - changed,
    changedLocation: changedLocation.n,
    changedLocations: changedLocations.n,
    diffPath,
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main();
