import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Cornerstone Building Brands — Manufacturer of exterior building products including windows, siding, and metal building systems.
 *
 * Cornerstone Building Brands is a manufacturer of exterior building
 * products for residential and commercial construction, including vinyl
 * windows, vinyl siding, stone veneer, metal roofing, and metal wall and
 * building systems.
 *
 * Sector: Building products manufacturing. HQ: Cary, North Carolina, USA.
 *
 * Source: SmartRecruiters job board, company identifier `cornerstonebuildingbrandscareers`
 * (`https://jobs.smartrecruiters.com/cornerstonebuildingbrandscareers`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'cornerstonebuildingbrandscareers';
const COMPANY_NAME = 'Cornerstone Building Brands';

@SourcePlugin({
  site: Site.CORNERSTONE_BUILDING_BRANDS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CornerstoneBuildingBrandsService implements IScraper {
  private readonly logger = new Logger(CornerstoneBuildingBrandsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Cornerstone Building Brands',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Cornerstone Building Brands: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CORNERSTONE_BUILDING_BRANDS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'cornerstonebuildingbrands-');
      }
    }

    this.logger.log(`Cornerstone Building Brands: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
