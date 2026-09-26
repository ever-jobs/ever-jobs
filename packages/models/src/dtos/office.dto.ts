import { LocationDto } from './location.dto';

/** A company office as the source declares it (e.g. Greenhouse `offices[]`) —
 *  a catalog entity, not a role-site: it may or may not be where the job sits.
 *  Geography fields mirror `LocationDto`; `name` holds the source's own office
 *  label verbatim and `text` the raw descriptive string when distinct. */
export class OfficeDto extends LocationDto {
  /** The source's own office identifier when it carries one. */
  id?: string | null;

  constructor(partial?: Partial<OfficeDto>) {
    super();
    Object.assign(this, partial);
  }
}
