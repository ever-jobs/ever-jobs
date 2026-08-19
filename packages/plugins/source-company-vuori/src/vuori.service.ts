import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Vuori — Performance apparel brand selling activewear and athleisure through its own stores and e-commerce.
 *
 * Vuori is a California-based apparel company that designs and sells
 * activewear and athleisure for men and women. It operates a
 * direct-to-consumer e-commerce channel alongside a growing fleet of
 * physical retail stores in the US and internationally. Product lines span
 * training, running, and everyday casual wear.
 *
 * Sector: Apparel & activewear (retail/e-commerce). HQ: Carlsbad, California, USA.
 *
 * Source: SmartRecruiters job board, company identifier `VuoriInc`
 * (`https://jobs.smartrecruiters.com/VuoriInc`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'VuoriInc';
const COMPANY_NAME = 'Vuori';

@SourcePlugin({
  site: Site.VUORI,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class VuoriService implements IScraper {
  private readonly logger = new Logger(VuoriService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Vuori',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Vuori: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.VUORI;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'vuori-');
      }
    }

    this.logger.log(`Vuori: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
