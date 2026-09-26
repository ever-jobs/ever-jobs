import 'reflect-metadata';
import { EightfoldService } from '../src/eightfold.service';
import type { EightfoldPosition } from '../src/eightfold.types';

describe('EightfoldService locations', () => {
  const service = new EightfoldService() as any;

  it('maps every standardizedLocations string (Country, State, City order)', () => {
    const position = {
      standardizedLocations: ['United States, California, San Francisco', 'United States, Texas, Austin'],
    } as unknown as EightfoldPosition;
    const locations = service.extractLocations(position);
    expect(locations).toHaveLength(2);
    expect(locations[0]).toMatchObject({
      city: 'San Francisco',
      state: 'California',
      country: 'United States',
    });
    expect(locations[1]).toMatchObject({ city: 'Austin', state: 'Texas', country: 'United States' });
  });

  it('maps location objects via structured fields', () => {
    const position = {
      locations: [{ city: 'Austin', state: 'TX', country: 'US' }],
    } as unknown as EightfoldPosition;
    const locations = service.extractLocations(position);
    expect(locations[0]).toMatchObject({ city: 'Austin', state: 'TX', country: 'US' });
  });

  it('parses a string primaryLocation through the shared parser', () => {
    const position = {
      primaryLocation: 'Austin, TX, US',
    } as unknown as EightfoldPosition;
    const locations = service.extractLocations(position);
    expect(locations).toHaveLength(1);
    expect(locations[0].city).toBe('Austin');
    expect(locations[0].state).toBe('TX');
  });
});
