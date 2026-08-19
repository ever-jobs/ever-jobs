import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Sprinter Health — Delivers in-home health services including lab work and preventive care.
 *
 * Sprinter Health provides in-home healthcare services such as blood draws,
 * diagnostics, and preventive care visits. It dispatches trained field
 * clinicians and coordinates with health plans and providers. The company
 * operates across multiple US markets.
 *
 * Sector: Healthtech (in-home care). HQ: Menlo Park, CA, USA.
 *
 * Source: Ashby job board, company slug `sprinter-health`
 * (`https://jobs.ashbyhq.com/sprinter-health`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'sprinter-health';
const COMPANY_NAME = 'Sprinter Health';

@SourcePlugin({
  site: Site.SPRINTER_HEALTH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SprinterHealthService implements IScraper {
  private readonly logger = new Logger(SprinterHealthService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Sprinter Health',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Sprinter Health: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SPRINTER_HEALTH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'sprinterhealth-');
      }
    }

    this.logger.log(`Sprinter Health: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
