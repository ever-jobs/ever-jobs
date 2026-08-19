import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Version 1 — Technology services firm delivering enterprise applications and cloud solutions.
 *
 * Version 1 is an IT services and consulting company delivering enterprise
 * applications, cloud, data, and digital solutions. It is an Oracle,
 * Microsoft, and AWS partner delivering ERP, HCM, and cloud implementations.
 * It operates across the UK, Ireland, and other regions.
 *
 * Sector: IT services and enterprise software consulting. HQ: Dublin, Ireland.
 *
 * Source: SmartRecruiters job board, company identifier `Version1`
 * (`https://jobs.smartrecruiters.com/Version1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Version1';
const COMPANY_NAME = 'Version 1';

@SourcePlugin({
  site: Site.VERSION_1,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class Version1Service implements IScraper {
  private readonly logger = new Logger(Version1Service.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Version 1',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Version 1: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.VERSION_1;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'version1-');
      }
    }

    this.logger.log(`Version 1: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
