import 'reflect-metadata';
import { HReasilyService } from '../src/hreasily.service';
import type { HReasilyJob } from '../src/hreasily.types';

describe('HReasilyService locations', () => {
  const service = new HReasilyService() as any;

  it('resolves every jobLocation Place to a triple', () => {
    const triples = service.resolveLocations([
      {
        address: {
          addressLocality: 'Singapore',
          addressRegion: null,
          addressCountry: { name: 'Singapore' },
        },
      },
      { address: 'Ho Chi Minh City, Vietnam' },
    ]);
    expect(triples).toEqual([
      { city: 'Singapore', state: null, country: 'Singapore' },
      { city: 'Ho Chi Minh City', state: null, country: 'Vietnam' },
    ]);
  });

  it('a single Place resolves to a one-entry list', () => {
    const triples = service.resolveLocations({
      address: { addressLocality: 'Singapore', addressCountry: 'Singapore' },
    });
    expect(triples).toHaveLength(1);
  });

  it('extractLocations emits one LocationDto per entry', () => {
    const job = {
      locationEntries: [
        { city: 'Singapore', state: null, country: 'Singapore' },
        { city: 'Ho Chi Minh City', state: null, country: 'Vietnam' },
      ],
    } as HReasilyJob;
    const locations = service.extractLocations(job);
    expect(locations).toHaveLength(2);
    expect(locations[1].country).toBe('Vietnam');
  });
});
