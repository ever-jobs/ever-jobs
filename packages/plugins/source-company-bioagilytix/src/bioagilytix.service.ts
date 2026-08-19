import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * BioAgilytix — Bioanalytical contract research laboratory supporting drug development.
 *
 * BioAgilytix is a bioanalytical laboratory providing large-molecule
 * bioanalysis, pharmacokinetics, immunogenicity, and biomarker services to
 * pharmaceutical and biotech companies developing new therapeutics.
 *
 * Sector: Biotech / CRO. HQ: Durham, North Carolina, USA.
 *
 * Source: Lever job board, company slug `bioagilytix`
 * (`https://jobs.lever.co/bioagilytix`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'bioagilytix';
const COMPANY_NAME = 'BioAgilytix';

@SourcePlugin({
  site: Site.BIOAGILYTIX,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class BioAgilytixService implements IScraper {
  private readonly logger = new Logger(BioAgilytixService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape BioAgilytix',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `BioAgilytix: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.BIOAGILYTIX;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'bioagilytix-');
      }
    }

    this.logger.log(`BioAgilytix: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
