import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Assured — AI platform for automating insurance claims processing.
 *
 * Assured builds AI software to automate insurance claims processing,
 * including in health and other insurance lines. Its platform aims to speed
 * up claims handling for insurers. The company hires across engineering and
 * operations.
 *
 * Sector: Healthtech (claims AI). HQ: United States.
 *
 * Source: Ashby job board, company slug `assured-health`
 * (`https://jobs.ashbyhq.com/assured-health`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'assured-health';
const COMPANY_NAME = 'Assured';

@SourcePlugin({
  site: Site.ASSURED,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AssuredService implements IScraper {
  private readonly logger = new Logger(AssuredService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Assured',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Assured: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ASSURED;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'assured-');
      }
    }

    this.logger.log(`Assured: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
