import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * N-Power Medicine — Reinvents clinical trials with data science and large language model operations.
 *
 * N-Power Medicine aims to transform clinical trials by integrating them
 * with clinical practice, using data science and LLM operations, with
 * clinical data science and LLM operations roles.
 *
 * Sector: Applied AI / clinical research. HQ: Redwood City, California, USA.
 *
 * Source: Lever job board, company slug `npowermedicine`
 * (`https://jobs.lever.co/npowermedicine`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'npowermedicine';
const COMPANY_NAME = 'N-Power Medicine';

@SourcePlugin({
  site: Site.N_POWER_MEDICINE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class NPowerMedicineService implements IScraper {
  private readonly logger = new Logger(NPowerMedicineService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape N-Power Medicine',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `N-Power Medicine: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.N_POWER_MEDICINE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'npowermedicine-');
      }
    }

    this.logger.log(`N-Power Medicine: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
