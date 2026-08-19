import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * WindRanger Labs — Web3 development organization building blockchain ecosystem products.
 *
 * WindRanger Labs is a Web3 development organization that builds products
 * and contributes to blockchain ecosystems. It works across business
 * development and engineering for onchain projects. The team operates in the
 * decentralized technology space.
 *
 * Sector: Web3 / blockchain development. HQ: Remote.
 *
 * Source: Ashby job board, company slug `windranger`
 * (`https://jobs.ashbyhq.com/windranger`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'windranger';
const COMPANY_NAME = 'WindRanger Labs';

@SourcePlugin({
  site: Site.WINDRANGER_LABS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class WindRangerLabsService implements IScraper {
  private readonly logger = new Logger(WindRangerLabsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape WindRanger Labs',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `WindRanger Labs: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.WINDRANGER_LABS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'windrangerlabs-');
      }
    }

    this.logger.log(`WindRanger Labs: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
