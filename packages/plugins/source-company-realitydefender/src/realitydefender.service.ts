import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Reality Defender — Multi-modal AI-generated media and deepfake detection platform.
 *
 * Reality Defender provides multi-modal detection of AI-generated media to
 * help enterprises and governments identify deepfakes and prevent related
 * fraud and disinformation in real time. It is a Y Combinator graduate
 * backed by DCVC.
 *
 * Sector: Deepfake Detection & Fraud. HQ: New York, New York, United States.
 *
 * Source: Ashby job board, company slug `realitydefender`
 * (`https://jobs.ashbyhq.com/realitydefender`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'realitydefender';
const COMPANY_NAME = 'Reality Defender';

@SourcePlugin({
  site: Site.REALITY_DEFENDER,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RealityDefenderService implements IScraper {
  private readonly logger = new Logger(RealityDefenderService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Reality Defender',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Reality Defender: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.REALITY_DEFENDER;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'realitydefender-');
      }
    }

    this.logger.log(`Reality Defender: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
