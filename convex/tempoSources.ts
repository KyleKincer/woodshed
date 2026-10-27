import { v, ConvexError } from 'convex/values';
import { action, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { requireUserId } from './lib/auth';
import { HARMONIX_BASE, HARMONIX_SOURCE, HARMONIX_REVISION, fetchTempoText, parseHarmonixCatalog,
  searchTempoCatalog, validHarmonixId, type TempoCandidate } from './lib/tempoCatalog';
import { chorusHash, CHORUS_FILES, CHORUS_SITE, searchChorus } from './lib/chorusCatalog';
import { extractSngChart } from '../shared/sng';

const candidateValidator = v.object({
  id: v.string(), title: v.string(), artist: v.string(), album: v.string(),
  source: v.union(v.literal('harmonix'), v.literal('chorus')), duration: v.number(), bpm: v.optional(v.number()),
  meter: v.optional(v.object({ numerator: v.number(), denominator: v.number() })),
  charter: v.optional(v.string()), hasDrums: v.optional(v.boolean()), sourceUrl: v.optional(v.string()),
});

export const authorize = internalQuery({
  args: {}, returns: v.null(),
  handler: async ctx => { await requireUserId(ctx); return null; },
});

// A fixed catalog is shared only within the current isolate. Failed requests are
// never cached. No user audio is sent to either provider; Chorus receives only
// the requested song/artist search, and GitHub receives fixed dataset paths.
let catalog: Promise<TempoCandidate[]> | undefined;
function getCatalog(): Promise<TempoCandidate[]> {
  if (!catalog) {
    catalog = fetchTempoText(`${HARMONIX_BASE}/metadata.csv`)
      .then(parseHarmonixCatalog)
      .catch(() => {
        catalog = undefined;
        throw new ConvexError('The tempo catalog is temporarily unavailable. Try again or import a file.');
      });
  }
  return catalog;
}

export const search = action({
  args: { query: v.string(), duration: v.optional(v.number()) },
  returns: v.object({ candidates: v.array(candidateValidator), warnings: v.array(v.string()) }),
  handler: async (ctx, { query, duration }): Promise<{ candidates: TempoCandidate[]; warnings: string[] }> => {
    await ctx.runQuery(internal.tempoSources.authorize, {});
    if (query.length > 300) throw new ConvexError('Use a shorter song or artist search.');
    if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0 || duration > 86400))
      throw new ConvexError('Invalid song duration.');
    if (query.trim().length < 2) return { candidates: [], warnings: [] };
    const [harmonix, chorus] = await Promise.allSettled([
      getCatalog().then(catalog => searchTempoCatalog(catalog, query, duration)),
      searchChorus(query.trim(), duration),
    ]);
    const candidates: TempoCandidate[] = [], warnings: string[] = [];
    if (harmonix.status === 'fulfilled') candidates.push(...harmonix.value);
    else warnings.push('Harmonix Set could not be searched. Its matches may be missing.');
    if (chorus.status === 'fulfilled') candidates.push(...chorus.value);
    else warnings.push('Chorus Encore could not be searched. Its matches may be missing.');
    return { candidates: candidates.slice(0, 40), warnings };
  },
});

export const load = action({
  args: { id: v.string() },
  returns: v.union(
    v.object({ format: v.literal('beats'), text: v.string(), sourceUrl: v.string() }),
    v.object({ format: v.union(v.literal('chart'), v.literal('midi')), data: v.bytes(), sourceUrl: v.string(), metadata: v.optional(v.record(v.string(), v.string())) }),
  ),
  handler: async (ctx, { id }): Promise<{ format: 'beats'; text: string; sourceUrl: string }
    | { format: 'chart' | 'midi'; data: ArrayBuffer; sourceUrl: string; metadata?: Record<string, string> }> => {
    await ctx.runQuery(internal.tempoSources.authorize, {});
    const hash = chorusHash(id);
    if (hash) {
      try {
        const result = await extractSngChart(`${CHORUS_FILES}/${hash}.sng`);
        if (result.bytes.byteLength > 900 * 1024)
          throw new ConvexError('This chart is too large for online import. Download it from Chorus Encore and import its MIDI or chart file.');
        // Preserve only timing/kit modifiers; the same frontend helper applies
        // these for local archives and online charts, avoiding double offsets.
        const metadata: Record<string, string> = {};
        for (const key of ['delay', 'chart_offset', 'pro_drums', 'five_lane_drums'])
          if (typeof result.metadata[key] === 'string') metadata[key] = result.metadata[key].slice(0, 100);
        return { format: result.name.toLowerCase().endsWith('.mid') ? 'midi' : 'chart',
          data: Uint8Array.from(result.bytes).buffer, sourceUrl: `${CHORUS_SITE}/?hash=${hash}`,
          ...(Object.keys(metadata).length ? { metadata } : {}) };
      } catch (error) {
        if (error instanceof ConvexError) throw error;
        throw new ConvexError('This Chorus chart could not be downloaded. Try again or choose another match.');
      }
    }
    if (!validHarmonixId(id)) throw new ConvexError('Invalid tempo-map selection.');
    if (!(await getCatalog()).some(candidate => candidate.id === id))
      throw new ConvexError('This tempo map is unavailable. Try another match.');
    let text: string;
    try { text = await fetchTempoText(`${HARMONIX_BASE}/beats_and_downbeats/${id}.txt`); }
    catch { throw new ConvexError('This tempo map could not be downloaded. Try again or choose another match.'); }
    return { format: 'beats', text, sourceUrl: `${HARMONIX_SOURCE}/blob/${HARMONIX_REVISION}/dataset/beats_and_downbeats/${id}.txt` };
  },
});
