import { CRAWL_ENV, resetCrawlPolicyEnvCache, resetEffectiveCrawlPolicyCache } from '@ever-jobs/common';
import { CRAWL_POLICY_DTO_VALUES, CrawlPolicyDto, ScraperInputDto } from '@ever-jobs/models';

/**
 * CLI flags that feed the per-request crawl policy (Spec 1690 §5.2), shared by
 * the `search` and `compare` commands.
 *
 * `--crawl <json>` takes any `CrawlPolicyDto` field; the convenience flags set
 * one field each and win over the same field in `--crawl`. The preset and the
 * caller-override rule are process-wide: the CLI is its own process, so
 * `--crawl-preset` / `--caller-overrides` set `EVER_JOBS_CRAWL_PRESET` /
 * `EVER_JOBS_CRAWL_CALLER_OVERRIDES` for this run (winning over the environment);
 * every other `EVER_JOBS_CRAWL_*` variable applies to the CLI as to the API.
 */
export interface CrawlCliOptions {
  /** Raw `--crawl` JSON. */
  crawl?: string;
  userAgentMode?: string;
  proxyRotation?: string;
  maxPerHost?: number;
  minIntervalMs?: number;
  crawlRetries?: number;
  robotsTxt?: string;
  discovery?: string;
  /** `--crawl-preset`: `polite` | `legacy` | `strict` for this CLI run. */
  crawlPreset?: string;
  /** `--caller-overrides`: `any` | `stricter` | `none` for this CLI run. */
  callerOverrides?: string;
}

/** Help text shared by both commands' `--crawl` flag. */
export const CRAWL_FLAG_DESCRIPTION =
  'Per-request crawl policy as JSON (Spec 1690), e.g. \'{"maxConcurrentPerHost":1,"minIntervalMs":1000}\'. ' +
  'Any crawl field is accepted; the flags below override single fields. The preset is process-wide: ' +
  '--crawl-preset (or EVER_JOBS_CRAWL_PRESET=polite|legacy|strict, plus any EVER_JOBS_CRAWL_* variable).';

/** Help text of `--crawl-preset`. */
export const CRAWL_PRESET_FLAG_DESCRIPTION =
  'Crawl preset for this run: polite (default), legacy (exact pre-1690 behaviour), strict. ' +
  'Sets EVER_JOBS_CRAWL_PRESET for this process.';

/** Help text of `--caller-overrides`. */
export const CALLER_OVERRIDES_FLAG_DESCRIPTION =
  'Which --crawl fields may apply: any (default), stricter (only more polite values), none. ' +
  'Sets EVER_JOBS_CRAWL_CALLER_OVERRIDES for this process.';

const PRESET_VALUES: readonly string[] = ['polite', 'legacy', 'strict'];
const CALLER_OVERRIDE_VALUES: readonly string[] = ['any', 'stricter', 'none'];

/**
 * Apply the process-wide flags (`--crawl-preset`, `--caller-overrides`) to `env`
 * (the CLI's own `process.env` by default) and drop the cached crawl-policy
 * parse, so the next request resolves under them. Invalid values are skipped and
 * returned as warnings.
 */
export function applyCrawlProcessOptions(
  options: Pick<CrawlCliOptions, 'crawlPreset' | 'callerOverrides'>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const warnings: string[] = [];
  let changed = false;
  const set = (flag: string, name: string, raw: string | undefined, allowed: readonly string[]): void => {
    if (raw === undefined) return;
    const value = String(raw).trim().toLowerCase();
    if (!allowed.includes(value)) {
      warnings.push(`${flag} must be one of ${allowed.join(', ')}; ignoring "${raw}"`);
      return;
    }
    env[name] = value;
    changed = true;
  };
  set('--crawl-preset', CRAWL_ENV.PRESET, options.crawlPreset, PRESET_VALUES);
  set('--caller-overrides', CRAWL_ENV.CALLER_OVERRIDES, options.callerOverrides, CALLER_OVERRIDE_VALUES);
  if (changed && env === process.env) {
    resetCrawlPolicyEnvCache();
    resetEffectiveCrawlPolicyCache();
  }
  return warnings;
}

/** `--user-agent-mode`, `--proxy-rotation`, … → crawl field and allowed values. */
const ENUM_FLAGS = [
  ['userAgentMode', '--user-agent-mode', CRAWL_POLICY_DTO_VALUES.userAgentMode],
  ['proxyRotation', '--proxy-rotation', CRAWL_POLICY_DTO_VALUES.proxyRotation],
  ['robotsTxt', '--robots-txt', CRAWL_POLICY_DTO_VALUES.robotsTxt],
  ['discovery', '--discovery', CRAWL_POLICY_DTO_VALUES.discovery],
] as const;

/** Numeric convenience flag → crawl field. */
const INT_FLAGS = [
  ['maxPerHost', '--max-per-host', 'maxConcurrentPerHost'],
  ['minIntervalMs', '--min-interval-ms', 'minIntervalMs'],
  ['crawlRetries', '--crawl-retries', 'retries'],
] as const;

/**
 * Parse a non-negative integer flag value. Returns `NaN` for anything else so
 * the mapper can report it (commander passes the raw string to the parser).
 */
export function parseNonNegativeInt(val: string): number {
  const trimmed = String(val).trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/**
 * Build `ScraperInputDto.crawl` from the CLI flags. Invalid values are skipped
 * and reported in `warnings` (the CLI prints them), never thrown — the same
 * "warn and ignore" stance as `--upwork-auth-json`. Returns `crawl: undefined`
 * when no crawl flag was given.
 */
export function buildCrawlPolicyFromCli(options: CrawlCliOptions): {
  crawl?: CrawlPolicyDto;
  warnings: string[];
} {
  const warnings: string[] = [];
  const fields: Record<string, unknown> = {};

  if (options.crawl !== undefined) {
    try {
      const parsed: unknown = JSON.parse(options.crawl);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.assign(fields, parsed);
      } else {
        warnings.push('--crawl must be a JSON object; ignoring');
      }
    } catch {
      warnings.push('Invalid JSON for --crawl; ignoring');
    }
  }

  for (const [key, flag, allowed] of ENUM_FLAGS) {
    const value = options[key];
    if (value === undefined) continue;
    if ((allowed as readonly string[]).includes(value)) {
      fields[key] = value;
    } else {
      warnings.push(`${flag} must be one of ${allowed.join(', ')}; ignoring "${value}"`);
    }
  }

  for (const [key, flag, field] of INT_FLAGS) {
    const value = options[key];
    if (value === undefined) continue;
    if (Number.isSafeInteger(value) && value >= 0) {
      fields[field] = value;
    } else {
      warnings.push(`${flag} must be a non-negative integer; ignoring`);
    }
  }

  if (Object.keys(fields).length === 0) {
    return { warnings };
  }
  return { crawl: Object.assign(new CrawlPolicyDto(), fields), warnings };
}

/**
 * Merge the crawl flags into `input.crawl` (flags win over a `crawl` object that
 * came in through `--stdin` JSON), apply the process-wide flags
 * (`applyCrawlProcessOptions`), and print any warnings to stderr, like the rest
 * of the CLI's diagnostics.
 */
export function applyCrawlCliOptions(input: ScraperInputDto, options: CrawlCliOptions): ScraperInputDto {
  const { crawl, warnings } = buildCrawlPolicyFromCli(options);
  warnings.push(...applyCrawlProcessOptions(options));
  for (const warning of warnings) {
    console.error(`Warning: ${warning}`);
  }
  if (crawl) {
    input.crawl = Object.assign(new CrawlPolicyDto(), input.crawl ?? {}, crawl);
  }
  return input;
}
