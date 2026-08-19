import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Bruegger\'s Bagels — Bakery-cafe chain specializing in fresh-baked bagels.
 *
 * Bruegger's Bagels is a US bakery-cafe chain that bakes bagels in small
 * batches in stone-hearth ovens and serves bagel sandwiches, coffee, and
 * related items. It operates bakeries across many US states and hires for
 * restaurant management and crew roles.
 *
 * Sector: Restaurants (Bakery-Cafe / Quick-Service). HQ: Burlington, Vermont, USA.
 *
 * Source: SmartRecruiters job board, company identifier `BrueggersBagels`
 * (`https://jobs.smartrecruiters.com/BrueggersBagels`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'BrueggersBagels';
const COMPANY_NAME = 'Bruegger\'s Bagels';

@SourcePlugin({
  site: Site.BRUEGGER_S_BAGELS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class BrueggerSBagelsService implements IScraper {
  private readonly logger = new Logger(BrueggerSBagelsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Bruegger\'s Bagels',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Bruegger\'s Bagels: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.BRUEGGER_S_BAGELS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'brueggersbagels-');
      }
    }

    this.logger.log(`Bruegger\'s Bagels: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
