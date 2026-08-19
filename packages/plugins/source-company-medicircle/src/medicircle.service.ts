import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * MediCircle — Platform for redistributing unused specialty medications.
 *
 * MediCircle operates a pharmacy and technology platform focused on
 * recovering and redistributing unused specialty medications. It runs
 * redistribution operations alongside a software team. The company hires
 * pharmacy technicians and engineers.
 *
 * Sector: Healthtech (pharmacy / drug redistribution). HQ: New York, NY, USA.
 *
 * Source: Ashby job board, company slug `medicircle`
 * (`https://jobs.ashbyhq.com/medicircle`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'medicircle';
const COMPANY_NAME = 'MediCircle';

@SourcePlugin({
  site: Site.MEDICIRCLE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MediCircleService implements IScraper {
  private readonly logger = new Logger(MediCircleService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape MediCircle',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `MediCircle: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MEDICIRCLE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'medicircle-');
      }
    }

    this.logger.log(`MediCircle: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
