import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Rapid Micro Biosystems — Life-sciences company automating microbial contamination detection in manufacturing.
 *
 * Rapid Micro Biosystems develops and sells the Growth Direct system, which
 * automates the detection of microbial contamination in the manufacture of
 * pharmaceuticals, biologics, medical devices, and personal-care products.
 *
 * Sector: Biotech / Life Sciences. HQ: Lowell, Massachusetts, USA.
 *
 * Source: Lever job board, company slug `rapidmicrobio`
 * (`https://jobs.lever.co/rapidmicrobio`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'rapidmicrobio';
const COMPANY_NAME = 'Rapid Micro Biosystems';

@SourcePlugin({
  site: Site.RAPID_MICRO_BIOSYSTEMS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RapidMicroBiosystemsService implements IScraper {
  private readonly logger = new Logger(RapidMicroBiosystemsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Rapid Micro Biosystems',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Rapid Micro Biosystems: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.RAPID_MICRO_BIOSYSTEMS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'rapidmicrobio-');
      }
    }

    this.logger.log(`Rapid Micro Biosystems: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
