import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Applied Intuition — Provides software for developing, testing, and deploying autonomous systems across automotive and defense.
 *
 * Applied Intuition builds software tools and infrastructure for developing
 * autonomous systems, including simulation, validation, and vehicle
 * operating systems. Its product lines span self-driving systems, defense
 * autonomy, and vehicle software. The company has a dedicated Government
 * segment focused on defense autonomy tooling.
 *
 * Sector: Defense & Autonomy. HQ: Mountain View, California, USA.
 *
 * Source: Ashby job board, company slug `applied`
 * (`https://jobs.ashbyhq.com/applied`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'applied';
const COMPANY_NAME = 'Applied Intuition';

@SourcePlugin({
  site: Site.APPLIED_INTUITION,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AppliedIntuitionService implements IScraper {
  private readonly logger = new Logger(AppliedIntuitionService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Applied Intuition',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Applied Intuition: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.APPLIED_INTUITION;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'appliedintuition-');
      }
    }

    this.logger.log(`Applied Intuition: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
