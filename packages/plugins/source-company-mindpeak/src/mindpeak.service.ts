import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Mindpeak — AI software for cancer diagnostics in pathology.
 *
 * Mindpeak develops AI-based software to support pathologists in analyzing
 * tissue samples for cancer diagnostics. Its tools aim to improve speed and
 * consistency of diagnostic assessment. The company is based in Germany.
 *
 * Sector: Healthtech (AI pathology / diagnostics). HQ: Hamburg, Germany.
 *
 * Source: Ashby job board, company slug `mindpeak`
 * (`https://jobs.ashbyhq.com/mindpeak`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'mindpeak';
const COMPANY_NAME = 'Mindpeak';

@SourcePlugin({
  site: Site.MINDPEAK,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MindpeakService implements IScraper {
  private readonly logger = new Logger(MindpeakService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Mindpeak',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Mindpeak: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MINDPEAK;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'mindpeak-');
      }
    }

    this.logger.log(`Mindpeak: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
