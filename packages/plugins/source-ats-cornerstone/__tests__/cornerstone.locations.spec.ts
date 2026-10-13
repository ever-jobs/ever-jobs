import 'reflect-metadata';
import { CornerstoneService } from '../src/cornerstone.service';
import type { CornerstoneRequisition } from '../src/cornerstone.types';

describe('CornerstoneService locations', () => {
  const service = new CornerstoneService() as any;

  it('maps every requisition.locations entry', () => {
    const req = {
      locations: [
        { city: 'Atlanta', state: 'GA', country: 'US' },
        { city: 'Dallas', state: 'TX', country: 'US' },
      ],
    } as unknown as CornerstoneRequisition;
    const locations = service.extractLocations(req);
    expect(locations).toHaveLength(2);
    expect(locations[0]).toMatchObject({ city: 'Atlanta', state: 'GA', country: 'US' });
    expect(locations[1]).toMatchObject({ city: 'Dallas', state: 'TX', country: 'US' });
  });

  it('maps a single location object to a one-entry list', () => {
    const req = {
      location: { city: 'Atlanta', state: 'GA', country: 'US' },
    } as unknown as CornerstoneRequisition;
    expect(service.extractLocations(req)).toHaveLength(1);
  });

  it('splits displayName-only objects and parses display strings', () => {
    const byName = service.extractLocations({
      locations: [{ displayName: 'Atlanta, GA, US' }],
    } as unknown as CornerstoneRequisition);
    expect(byName[0]).toMatchObject({ city: 'Atlanta', state: 'GA', country: 'United States' });

    const byDisplay = service.extractLocations({
      displayLocation: 'Austin, TX, US',
    } as unknown as CornerstoneRequisition);
    expect(byDisplay).toHaveLength(1);
    expect(byDisplay[0].city).toBe('Austin');
    expect(byDisplay[0].state).toBe('TX');
  });

  it('parses a bare-string requisition.location through the mapper', () => {
    const req = {
      location: 'Denver, CO, US',
    } as unknown as CornerstoneRequisition;
    const locations = service.extractLocations(req);
    expect(locations).toHaveLength(1);
    expect(locations[0]).toMatchObject({
      city: 'Denver',
      state: 'CO',
      country: 'United States',
      text: 'Denver, CO, US',
    });
  });

  it('claims displayName as text when it is the sole text source', () => {
    const locations = service.extractLocations({
      locations: [
        {
          displayName: 'Atlanta, GA, US',
        },
      ],
    } as unknown as CornerstoneRequisition);
    expect(locations[0].text).toBe('Atlanta, GA, US');
    expect(locations[0].city).toBe('Atlanta');
  });

  it('falls back to displayLocation when locations/location map empty', () => {
    const locations = service.extractLocations({
      locations: [{ city: null }],
      displayLocation: 'Austin, TX, US',
    } as unknown as CornerstoneRequisition);
    expect(locations).toHaveLength(1);
    expect(locations[0].city).toBe('Austin');
  });
});
