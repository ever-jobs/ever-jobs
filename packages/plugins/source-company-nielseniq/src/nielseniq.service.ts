import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * NielsenIQ — Consumer intelligence company providing retail measurement and analytics.
 *
 * NielsenIQ provides consumer intelligence through retail measurement,
 * market data, and analytics platforms. It builds software and data products
 * that measure consumer purchasing behavior for retailers and manufacturers.
 * The company operates globally.
 *
 * Sector: Consumer intelligence data & analytics technology. HQ: Chicago, Illinois, USA.
 *
 * Source: SmartRecruiters job board, company identifier `NielsenIQ`
 * (`https://jobs.smartrecruiters.com/NielsenIQ`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'NielsenIQ';
const COMPANY_NAME = 'NielsenIQ';

@SourcePlugin({
  site: Site.NIELSENIQ,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class NielsenIQService implements IScraper {
  private readonly logger = new Logger(NielsenIQService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape NielsenIQ',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `NielsenIQ: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.NIELSENIQ;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'nielseniq-');
      }
    }

    this.logger.log(`NielsenIQ: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
