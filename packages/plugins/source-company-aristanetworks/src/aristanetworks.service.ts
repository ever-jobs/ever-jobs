import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Arista Networks — Provider of cloud and data-center networking solutions.
 *
 * Arista Networks provides data-driven, client-to-cloud networking for data
 * center, campus, and routing environments. Its products combine
 * high-performance switches with the EOS network operating system. It serves
 * large enterprise and cloud customers.
 *
 * Sector: Networking technology / software-driven networking. HQ: Santa Clara, California, USA.
 *
 * Source: SmartRecruiters job board, company identifier `aristanetworks`
 * (`https://jobs.smartrecruiters.com/aristanetworks`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'aristanetworks';
const COMPANY_NAME = 'Arista Networks';

@SourcePlugin({
  site: Site.ARISTA_NETWORKS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AristaNetworksService implements IScraper {
  private readonly logger = new Logger(AristaNetworksService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Arista Networks',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Arista Networks: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ARISTA_NETWORKS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'aristanetworks-');
      }
    }

    this.logger.log(`Arista Networks: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
