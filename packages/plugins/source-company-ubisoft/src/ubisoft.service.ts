import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Ubisoft — Developer and publisher of video games and interactive entertainment.
 *
 * Ubisoft develops and publishes video games and interactive entertainment
 * across console, PC, and mobile platforms. It operates development studios
 * worldwide and builds proprietary game engines and online services. The
 * company is publicly traded.
 *
 * Sector: Software / interactive entertainment (video games). HQ: Saint-Mandé, France.
 *
 * Source: SmartRecruiters job board, company identifier `ubisoft2`
 * (`https://jobs.smartrecruiters.com/ubisoft2`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'ubisoft2';
const COMPANY_NAME = 'Ubisoft';

@SourcePlugin({
  site: Site.UBISOFT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class UbisoftService implements IScraper {
  private readonly logger = new Logger(UbisoftService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Ubisoft',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Ubisoft: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.UBISOFT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'ubisoft-');
      }
    }

    this.logger.log(`Ubisoft: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
