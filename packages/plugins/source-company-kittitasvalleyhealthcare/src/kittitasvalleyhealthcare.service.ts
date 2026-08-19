import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Kittitas Valley Healthcare — Community hospital and clinic network serving Kittitas County, Washington.
 *
 * Kittitas Valley Healthcare is a public hospital district operating a
 * community hospital and a network of clinics in Kittitas County,
 * Washington. It provides acute care, emergency services, and primary and
 * specialty outpatient care.
 *
 * Sector: Healthcare / Hospital System. HQ: Ellensburg, Washington, USA.
 *
 * Source: SmartRecruiters job board, company identifier `KittitasValleyHealthcare`
 * (`https://jobs.smartrecruiters.com/KittitasValleyHealthcare`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'KittitasValleyHealthcare';
const COMPANY_NAME = 'Kittitas Valley Healthcare';

@SourcePlugin({
  site: Site.KITTITAS_VALLEY_HEALTHCARE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class KittitasValleyHealthcareService implements IScraper {
  private readonly logger = new Logger(KittitasValleyHealthcareService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Kittitas Valley Healthcare',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Kittitas Valley Healthcare: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.KITTITAS_VALLEY_HEALTHCARE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'kittitasvalleyhealthcare-');
      }
    }

    this.logger.log(`Kittitas Valley Healthcare: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
