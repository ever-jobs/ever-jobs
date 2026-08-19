import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Masdar — Abu Dhabi-based renewable energy company developing solar, wind and green hydrogen projects worldwide.
 *
 * Masdar (Abu Dhabi Future Energy Company) is a clean-energy developer and
 * investor headquartered in Abu Dhabi. It develops, owns and operates
 * utility-scale solar, wind and battery storage projects and is active in
 * green hydrogen. The company operates across dozens of countries.
 *
 * Sector: Renewables & Clean Energy. HQ: Abu Dhabi, Abu Dhabi, United Arab Emirates.
 *
 * Source: SmartRecruiters job board, company identifier `Masdar`
 * (`https://jobs.smartrecruiters.com/Masdar`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Masdar';
const COMPANY_NAME = 'Masdar';

@SourcePlugin({
  site: Site.MASDAR,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MasdarService implements IScraper {
  private readonly logger = new Logger(MasdarService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Masdar',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Masdar: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MASDAR;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'masdar-');
      }
    }

    this.logger.log(`Masdar: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
