import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Genomics plc — Uses large-scale genetic and health data to advance drug discovery and preventative healthcare.
 *
 * Genomics plc is a TechBio company that combines large-scale genetic and
 * health data with proprietary analytics to support drug discovery and
 * predictive, preventative healthcare. It develops polygenic risk scores to
 * help assess individual disease risk. The company has offices in Oxford and
 * London.
 *
 * Sector: Biotech / TechBio (genomics). HQ: Oxford, England, UK.
 *
 * Source: Ashby job board, company slug `genomics`
 * (`https://jobs.ashbyhq.com/genomics`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'genomics';
const COMPANY_NAME = 'Genomics plc';

@SourcePlugin({
  site: Site.GENOMICS_PLC,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class GenomicsPlcService implements IScraper {
  private readonly logger = new Logger(GenomicsPlcService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Genomics plc',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Genomics plc: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.GENOMICS_PLC;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'genomicsplc-');
      }
    }

    this.logger.log(`Genomics plc: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
