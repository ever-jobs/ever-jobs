import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Lindus Health — Contract research organization running end-to-end clinical trials.
 *
 * Lindus Health is a clinical research organization (CRO) that runs clinical
 * trials end-to-end using its own technology platform. It aims to make
 * trials faster and more reliable for biotech and pharma sponsors. The
 * company operates in the UK and US.
 *
 * Sector: Biotech / healthtech (clinical trials). HQ: London, England, UK.
 *
 * Source: Ashby job board, company slug `lindus`
 * (`https://jobs.ashbyhq.com/lindus`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'lindus';
const COMPANY_NAME = 'Lindus Health';

@SourcePlugin({
  site: Site.LINDUS_HEALTH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LindusHealthService implements IScraper {
  private readonly logger = new Logger(LindusHealthService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Lindus Health',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Lindus Health: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LINDUS_HEALTH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'lindushealth-');
      }
    }

    this.logger.log(`Lindus Health: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
