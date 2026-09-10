import type { Asset } from '../types';

/**
 * The list the photo viewer is paging through.
 *
 * The viewer is addressed by a single asset id, which is what makes it
 * deep-linkable, but swiping needs to know what comes next. Passing the whole
 * list through route params would serialise hundreds of assets into a URL on
 * every tap, and refetching in the viewer would guess wrong — "next" means
 * something different in an album, a person, and a set of search results.
 *
 * So whichever grid opened the viewer hands over the list it is already
 * showing. Module state is enough: both live in the same JS context, and a
 * cold deep link simply finds nothing here and falls back to a single asset.
 */
let assets: Asset[] = [];

export function setViewerAssets(list: Asset[]): void {
  assets = list;
}

export function getViewerAssets(): Asset[] {
  return assets;
}

/** Position of an asset in the current list, or -1 when it is not present. */
export function indexOfAsset(id: string): number {
  return assets.findIndex((asset) => asset.id === id);
}
