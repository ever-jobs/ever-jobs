import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * LVMH Perfumes & Cosmetics — Perfumes and cosmetics division of luxury group LVMH, spanning multiple beauty brands.
 *
 * LVMH Perfumes & Cosmetics is the beauty division of the LVMH group,
 * encompassing perfume, makeup, and skincare houses. It develops and sells
 * consumer beauty products globally through retail, wholesale, and
 * e-commerce. The division includes several established fragrance and
 * cosmetics maisons.
 *
 * Sector: Beauty & cosmetics (consumer goods). HQ: Paris, France.
 *
 * Source: SmartRecruiters job board, company identifier `lvmhperfumescosmetics`
 * (`https://jobs.smartrecruiters.com/lvmhperfumescosmetics`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'lvmhperfumescosmetics';
const COMPANY_NAME = 'LVMH Perfumes & Cosmetics';

@SourcePlugin({
  site: Site.LVMH_PERFUMES_COSMETICS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LVMHPerfumesCosmeticsService implements IScraper {
  private readonly logger = new Logger(LVMHPerfumesCosmeticsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape LVMH Perfumes & Cosmetics',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `LVMH Perfumes & Cosmetics: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LVMH_PERFUMES_COSMETICS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'lvmhperfumescosmetics-');
      }
    }

    this.logger.log(`LVMH Perfumes & Cosmetics: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
