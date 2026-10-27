import { v, ConvexError } from 'convex/values';
import { action, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { requireUserId } from './lib/auth';
import { HARMONIX_BASE, HARMONIX_SOURCE, HARMONIX_REVISION, fetchTempoText, parseHarmonixCatalog,
  searchTempoCatalog, validHarmonixId, type TempoCandidate } from './lib/tempoCatalog';

const candidateValidator = v.object({
  id: v.string(), title: v.string(), artist: v.string(), album: v.string(),
  source: v.literal('harmonix'), duration: v.number(), bpm: v.number(),
  meter: v.optional(v.object({ numerator: v.number(), denominator: v.number() })),
});

export const authorize = internalQuery({
  args: {}, returns: v.null(),
  handler: async ctx => { await requireUserId(ctx); return null; },
});

// A fixed catalog is shared only within the current isolate. Failed requests are
// never cached, and no user audio, library details or search text reach GitHub.
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
  returns: v.array(candidateValidator),
  handler: async (ctx, { query, duration }): Promise<TempoCandidate[]> => {
    await ctx.runQuery(internal.tempoSources.authorize, {});
    if (query.length > 300) throw new ConvexError('Use a shorter song or artist search.');
    if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0 || duration > 86400))
      throw new ConvexError('Invalid song duration.');
    if (query.trim().length < 2) return [];
    return searchTempoCatalog(await getCatalog(), query, duration);
  },
});

export const load = action({
  args: { id: v.string() },
  returns: v.object({ text: v.string(), sourceUrl: v.string() }),
  handler: async (ctx, { id }): Promise<{ text: string; sourceUrl: string }> => {
    await ctx.runQuery(internal.tempoSources.authorize, {});
    if (!validHarmonixId(id)) throw new ConvexError('Invalid tempo-map selection.');
    if (!(await getCatalog()).some(candidate => candidate.id === id))
      throw new ConvexError('This tempo map is unavailable. Try another match.');
    let text: string;
    try { text = await fetchTempoText(`${HARMONIX_BASE}/beats_and_downbeats/${id}.txt`); }
    catch { throw new ConvexError('This tempo map could not be downloaded. Try again or choose another match.'); }
    return { text, sourceUrl: `${HARMONIX_SOURCE}/blob/${HARMONIX_REVISION}/dataset/beats_and_downbeats/${id}.txt` };
  },
});
