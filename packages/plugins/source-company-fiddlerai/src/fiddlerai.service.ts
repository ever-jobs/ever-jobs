import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Fiddler AI — AI observability and model monitoring platform.
 *
 * Fiddler AI builds an AI observability platform for monitoring, explaining,
 * and analyzing machine learning models and AI systems. The company hires
 * across Marketing, Engineering, and Customer Success, including remote
 * roles in the US.
 *
 * Sector: AI Observability. HQ: Palo Alto, California, USA.
 *
 * Source: Ashby job board, company slug `fiddler-ai`
 * (`https://jobs.ashbyhq.com/fiddler-ai`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'fiddler-ai';
const COMPANY_NAME = 'Fiddler AI';

@SourcePlugin({
  site: Site.FIDDLER_AI,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FiddlerAIService implements IScraper {
  private readonly logger = new Logger(FiddlerAIService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Fiddler AI',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Fiddler AI: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FIDDLER_AI;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'fiddlerai-');
      }
    }

    this.logger.log(`Fiddler AI: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
