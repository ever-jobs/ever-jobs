import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Zenith Talent — Staffing firm placing professionals across technology and business functions.
 *
 * Zenith Talent is a staffing and recruiting firm that places professionals
 * in information technology, engineering, marketing, sales, finance, HR and
 * operations roles for client organizations.
 *
 * Sector: Staffing and recruiting. HQ: Fremont, California, United States.
 *
 * Source: SmartRecruiters job board, company identifier `ZenithTalentCorporation`
 * (`https://jobs.smartrecruiters.com/ZenithTalentCorporation`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'ZenithTalentCorporation';
const COMPANY_NAME = 'Zenith Talent';

@SourcePlugin({
  site: Site.ZENITH_TALENT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ZenithTalentService implements IScraper {
  private readonly logger = new Logger(ZenithTalentService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Zenith Talent',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Zenith Talent: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ZENITH_TALENT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'zenithtalent-');
      }
    }

    this.logger.log(`Zenith Talent: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
