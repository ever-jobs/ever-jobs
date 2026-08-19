import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Fortune Brands Innovations — Consumer products company for home, water, and security brands.
 *
 * Fortune Brands Innovations is a US consumer products company that
 * manufactures and markets home, water, and security products. Its portfolio
 * includes plumbing, cabinetry, outdoor living, and security brands sold
 * through retail and wholesale channels. The company is publicly traded and
 * headquartered in Illinois.
 *
 * Sector: Consumer home & security products. HQ: Deerfield, Illinois, USA.
 *
 * Source: SmartRecruiters job board, company identifier `FortuneBrands`
 * (`https://jobs.smartrecruiters.com/FortuneBrands`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'FortuneBrands';
const COMPANY_NAME = 'Fortune Brands Innovations';

@SourcePlugin({
  site: Site.FORTUNE_BRANDS_INNOVATIONS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FortuneBrandsInnovationsService implements IScraper {
  private readonly logger = new Logger(FortuneBrandsInnovationsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Fortune Brands Innovations',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Fortune Brands Innovations: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FORTUNE_BRANDS_INNOVATIONS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'fortunebrandsinnovations-');
      }
    }

    this.logger.log(`Fortune Brands Innovations: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
