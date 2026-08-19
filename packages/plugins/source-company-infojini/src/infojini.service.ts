import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Infojini — IT consulting, services and staffing firm serving government and commercial clients.
 *
 * Infojini is a full-service IT consulting, services and staffing firm that
 * serves government agencies and commercial clients, including state and
 * federal agencies and large enterprises. It provides technology talent and
 * project services.
 *
 * Sector: IT consulting and staffing. HQ: Secaucus, New Jersey, United States.
 *
 * Source: SmartRecruiters job board, company identifier `InfojiniInc1`
 * (`https://jobs.smartrecruiters.com/InfojiniInc1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'InfojiniInc1';
const COMPANY_NAME = 'Infojini';

@SourcePlugin({
  site: Site.INFOJINI,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class InfojiniService implements IScraper {
  private readonly logger = new Logger(InfojiniService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Infojini',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Infojini: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.INFOJINI;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'infojini-');
      }
    }

    this.logger.log(`Infojini: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
