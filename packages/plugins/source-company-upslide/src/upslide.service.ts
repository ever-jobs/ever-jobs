import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * UpSlide — Productivity and document-automation software for Microsoft Office used by financial-services firms.
 *
 * UpSlide is a French SaaS company providing a productivity add-in for
 * Microsoft Office (PowerPoint, Word, Excel) aimed at financial-services and
 * professional-services firms. It has offices in Paris, London, New York,
 * Singapore and Berlin, with its headquarters in Paris. Careers are hosted
 * on Recruitee at upslide.recruitee.com.
 *
 * Sector: B2B SaaS / Productivity software. HQ: Paris, France.
 *
 * Source: Recruitee careers board, subdomain `upslide`
 * (`https://upslide.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'upslide';
const COMPANY_NAME = 'UpSlide';

@SourcePlugin({
  site: Site.UPSLIDE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class UpSlideService implements IScraper {
  private readonly logger = new Logger(UpSlideService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape UpSlide',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `UpSlide: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.UPSLIDE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'upslide-');
      }
    }

    this.logger.log(`UpSlide: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
