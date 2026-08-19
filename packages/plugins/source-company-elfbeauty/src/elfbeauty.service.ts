import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * e.l.f. Beauty — Multi-brand cosmetics and skincare company selling online and through retailers.
 *
 * e.l.f. Beauty is a cosmetics and skincare company whose portfolio includes
 * e.l.f. Cosmetics, e.l.f. SKIN, Well People, Keys Soulcare, Naturium, and
 * rhode. It sells through its own e-commerce channels, Amazon, and retail
 * partners internationally.
 *
 * Sector: Consumer / Beauty e-commerce. HQ: Oakland, California, USA.
 *
 * Source: Lever job board, company slug `elfbeauty`
 * (`https://jobs.lever.co/elfbeauty`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'elfbeauty';
const COMPANY_NAME = 'e.l.f. Beauty';

@SourcePlugin({
  site: Site.E_L_F_BEAUTY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ELFBeautyService implements IScraper {
  private readonly logger = new Logger(ELFBeautyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape e.l.f. Beauty',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `e.l.f. Beauty: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.E_L_F_BEAUTY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'elfbeauty-');
      }
    }

    this.logger.log(`e.l.f. Beauty: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
