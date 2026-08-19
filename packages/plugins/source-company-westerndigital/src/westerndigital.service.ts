import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Western Digital — Manufacturer of data storage devices and solutions.
 *
 * Western Digital designs and manufactures data storage technology,
 * including hard disk drives, flash storage, and SSDs for consumer,
 * enterprise, and data center markets. It develops both storage hardware and
 * supporting firmware and software. The company is publicly traded.
 *
 * Sector: Data storage technology / hardware. HQ: San Jose, California, USA.
 *
 * Source: SmartRecruiters job board, company identifier `WesternDigital`
 * (`https://jobs.smartrecruiters.com/WesternDigital`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'WesternDigital';
const COMPANY_NAME = 'Western Digital';

@SourcePlugin({
  site: Site.WESTERN_DIGITAL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class WesternDigitalService implements IScraper {
  private readonly logger = new Logger(WesternDigitalService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Western Digital',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Western Digital: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.WESTERN_DIGITAL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'westerndigital-');
      }
    }

    this.logger.log(`Western Digital: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
