import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * BCforward — IT and business solutions staffing firm founded in 1998.
 *
 * BCforward is an IT and business process staffing firm that provides
 * personnel and workforce solutions to commercial and government clients.
 * Founded in 1998, it offers staff augmentation, project services and
 * managed staffing.
 *
 * Sector: IT staffing and workforce solutions. HQ: Indianapolis, Indiana, United States.
 *
 * Source: SmartRecruiters job board, company identifier `BCforward3`
 * (`https://jobs.smartrecruiters.com/BCforward3`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'BCforward3';
const COMPANY_NAME = 'BCforward';

@SourcePlugin({
  site: Site.BCFORWARD,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class BCforwardService implements IScraper {
  private readonly logger = new Logger(BCforwardService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape BCforward',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `BCforward: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.BCFORWARD;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'bcforward-');
      }
    }

    this.logger.log(`BCforward: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
