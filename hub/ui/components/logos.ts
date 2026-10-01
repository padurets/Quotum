import {providerOf} from '../../server/domain/providers';

const assets = import.meta.glob<string>('../icons/*.svg', {eager: true, query: '?url', import: 'default'});

/** Resolve the catalogue's asset, with a neutral icon for a provider this build lacks. */
export const logoOf = (provider: string) => assets[`../icons/${providerOf(provider)?.logoAsset ?? 'unknown'}.svg`] ?? assets['../icons/unknown.svg'];
