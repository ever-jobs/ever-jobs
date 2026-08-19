import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * CROSSMARK — Sales and retail merchandising services provider for consumer goods brands and retailers.
 *
 * CROSSMARK is a US sales and marketing services company serving consumer
 * goods manufacturers and retailers. It provides in-store merchandising,
 * product demonstrations, and retail execution across grocery and
 * mass-market stores. The company staffs merchandising and
 * brand-representation roles nationwide.
 *
 * Sector: Retail sales & merchandising services (consumer goods). HQ: Plano, Texas, USA.
 *
 * Source: SmartRecruiters job board, company identifier `CROSSMARK1`
 * (`https://jobs.smartrecruiters.com/CROSSMARK1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'CROSSMARK1';
const COMPANY_NAME = 'CROSSMARK';

@SourcePlugin({
  site: Site.CROSSMARK,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CROSSMARKService implements IScraper {
  private readonly logger = new Logger(CROSSMARKService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape CROSSMARK',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `CROSSMARK: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CROSSMARK;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'crossmark-');
      }
    }

    this.logger.log(`CROSSMARK: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
