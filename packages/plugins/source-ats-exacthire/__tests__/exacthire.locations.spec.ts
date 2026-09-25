import 'reflect-metadata';
import { ExactHireService } from '../src/exacthire.service';
import type { ExactHireJob } from '../src/exacthire.types';

describe('ExactHireService locations', () => {
  const service = new ExactHireService() as any;

  it('maps every JSON-LD jobLocation node, including {name} countries', () => {
    const triples = service.jsonLdAddresses({
      jobLocation: [
        {
          address: {
            addressLocality: 'Atlanta',
            addressRegion: 'GA',
            addressCountry: { name: 'United States' },
          },
        },
        {
          address: {
            addressLocality: 'Dallas',
            addressRegion: 'TX',
            addressCountry: 'US',
          },
        },
      ],
    });
    expect(triples).toEqual([
      { city: 'Atlanta', state: 'GA', country: 'United States' },
      { city: 'Dallas', state: 'TX', country: 'US' },
    ]);
  });

  it('extractLocations emits one LocationDto per entry', () => {
    const job = {
      locationEntries: [
        { city: 'Atlanta', state: 'GA', country: 'United States' },
        { city: 'Dallas', state: 'TX', country: 'US' },
      ],
    } as ExactHireJob;
    const locations = service.extractLocations(job);
    expect(locations).toHaveLength(2);
    expect(locations[1].city).toBe('Dallas');
  });

  it('extractLocations falls back to the merged location', () => {
    const job = { city: 'Atlanta', state: 'GA', country: 'US' } as ExactHireJob;
    const locations = service.extractLocations(job);
    expect(locations).toHaveLength(1);
    expect(locations[0].city).toBe('Atlanta');
  });
});
