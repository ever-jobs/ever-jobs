import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Perplexity — AI-powered answer engine that responds to queries with cited sources.
 *
 * Perplexity operates a conversational answer engine that uses large
 * language models to respond to user questions with citations to web
 * sources. It offers consumer and enterprise products and a developer API.
 *
 * Sector: Applied AI / search. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `perplexity`
 * (`https://jobs.ashbyhq.com/perplexity`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'perplexity';
const COMPANY_NAME = 'Perplexity';

@SourcePlugin({
  site: Site.PERPLEXITY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PerplexityService implements IScraper {
  private readonly logger = new Logger(PerplexityService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Perplexity',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Perplexity: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PERPLEXITY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'perplexity-');
      }
    }

    this.logger.log(`Perplexity: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
