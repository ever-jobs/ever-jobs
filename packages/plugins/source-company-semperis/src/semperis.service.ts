import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Semperis — Identity security and resilience platform focused on Active Directory and Entra ID.
 *
 * Semperis provides identity security and resilience solutions focused on
 * protecting, monitoring, and recovering directory services such as Active
 * Directory and Entra ID. Its products target detection, response, and
 * recovery from identity-based attacks.
 *
 * Sector: Identity Security. HQ: Hoboken, New Jersey, United States.
 *
 * Source: Ashby job board, company slug `semperis`
 * (`https://jobs.ashbyhq.com/semperis`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'semperis';
const COMPANY_NAME = 'Semperis';

@SourcePlugin({
  site: Site.SEMPERIS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SemperisService implements IScraper {
  private readonly logger = new Logger(SemperisService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Semperis',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Semperis: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SEMPERIS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'semperis-');
      }
    }

    this.logger.log(`Semperis: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
