import 'reflect-metadata';
import { PrescreenService } from '../src/prescreen.service';
import type { PrescreenJob } from '../src/prescreen.types';

describe('PrescreenService locations', () => {
  const service = new PrescreenService() as any;

  it('maps every JSON-LD jobLocation Place', () => {
    const job = {
      ld: {
        jobLocation: [
          { address: { addressLocality: 'Berlin', addressCountry: 'Germany' } },
          { address: { addressLocality: 'Munich', addressRegion: 'Bavaria', addressCountry: 'Germany' } },
        ],
      },
    } as unknown as PrescreenJob;
    const locations = service.extractLocations(job);
    expect(locations).toHaveLength(2);
    expect(locations[0]).toMatchObject({ city: 'Berlin', country: 'Germany' });
    expect(locations[1]).toMatchObject({ city: 'Munich', state: 'Bavaria', country: 'Germany' });
  });

  it('falls back to the listing label via the shared parser', () => {
    const job = { listingLocation: 'Berlin, Germany' } as PrescreenJob;
    const locations = service.extractLocations(job);
    expect(locations).toHaveLength(1);
    expect(locations[0].city).toBe('Berlin');
    expect(locations[0].country).toBe('Germany');
  });
});
