import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Ulbrich Stainless Steels & Special Metals — Manufacturer of precision-rolled stainless steel strip, special metals, and shaped wire.
 *
 * Ulbrich Stainless Steels & Special Metals, Inc. is a family-owned
 * manufacturer of precision-rolled stainless steel and special metals strip,
 * foil, and shaped wire. It operates production facilities in the US,
 * Mexico, and Austria.
 *
 * Sector: Metals / Precision materials manufacturing. HQ: Wallingford, Connecticut, USA.
 *
 * Source: SmartRecruiters job board, company identifier `UlbrichSteel`
 * (`https://jobs.smartrecruiters.com/UlbrichSteel`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'UlbrichSteel';
const COMPANY_NAME = 'Ulbrich Stainless Steels & Special Metals';

@SourcePlugin({
  site: Site.ULBRICH_STAINLESS_STEELS_SPECIAL_METALS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class UlbrichStainlessSteelsSpecialMetalsService implements IScraper {
  private readonly logger = new Logger(UlbrichStainlessSteelsSpecialMetalsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Ulbrich Stainless Steels & Special Metals',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Ulbrich Stainless Steels & Special Metals: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ULBRICH_STAINLESS_STEELS_SPECIAL_METALS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'ulbrichstainlesssteelsspecialmetals-');
      }
    }

    this.logger.log(`Ulbrich Stainless Steels & Special Metals: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
