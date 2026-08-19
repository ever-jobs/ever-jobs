import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Minor International — Global hospitality group operating hotels, resorts, and restaurants across multiple countries.
 *
 * Minor International (Minor Hotels) is a Thailand-based hospitality and
 * restaurant group headquartered in Bangkok. It operates and manages hotels,
 * resorts, and residences across numerous countries under brands such as
 * Anantara, Avani, and NH Hotels, alongside restaurant and lifestyle
 * businesses.
 *
 * Sector: Hospitality. HQ: Bangkok, Bangkok, Thailand.
 *
 * Source: SmartRecruiters job board, company identifier `MinorInternational`
 * (`https://jobs.smartrecruiters.com/MinorInternational`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'MinorInternational';
const COMPANY_NAME = 'Minor International';

@SourcePlugin({
  site: Site.MINOR_INTERNATIONAL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MinorInternationalService implements IScraper {
  private readonly logger = new Logger(MinorInternationalService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Minor International',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Minor International: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MINOR_INTERNATIONAL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'minorinternational-');
      }
    }

    this.logger.log(`Minor International: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
