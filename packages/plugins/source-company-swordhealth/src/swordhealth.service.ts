import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Sword Health — AI-powered digital platform for musculoskeletal, pelvic, and mental health care.
 *
 * Sword Health delivers virtual physical therapy and related care through
 * AI-assisted programs and licensed clinicians, covering musculoskeletal,
 * pelvic health, and mental health across employer and health-plan channels.
 *
 * Sector: Digital Health. HQ: New York, New York, USA.
 *
 * Source: Lever job board, company slug `swordhealth`
 * (`https://jobs.lever.co/swordhealth`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'swordhealth';
const COMPANY_NAME = 'Sword Health';

@SourcePlugin({
  site: Site.SWORD_HEALTH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SwordHealthService implements IScraper {
  private readonly logger = new Logger(SwordHealthService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Sword Health',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Sword Health: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SWORD_HEALTH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'swordhealth-');
      }
    }

    this.logger.log(`Sword Health: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
