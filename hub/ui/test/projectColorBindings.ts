import {projectColorsReady,type BoardState} from '../lib/board';
import type {ProjectColorPins} from '../../server/domain/projectColors';
import {resolveProjectColors} from '../lib/projectColors';

/** Extracted renderers read the fixture's real metadata through the production readiness rule. */
export function projectColorBindings(page?:{get():{board:BoardState|null}}) {
  const empty:ProjectColorPins=[];
  return {resolveProjectColors,useProjectColorPins:()=>page?.get().board?.projectColors?.pins??empty,
    useProjectColorsReady:()=>page?projectColorsReady(page.get().board):true};
}
