// Songs (convex/songs.ts, architecture §6.3). One-line wrappers over
// src/api/client.js: every call takes the Convex function's own argument object
// and rejects with an ApiError (§2.1). The subscriptions return `off()`.
//
//   list()                                   → {songs: ListRow[]}   the slim Library rows (B1)
//   get({id})                                → SongFull | null       no practice (D52); tempoRev, tempoSaveId, …
//   getPractice({id})                        → stored practice | null (any version; upgrade with shared/practice.ts)
//   getMany({ids})                           → SongFull[]            1–100 ids, the caller's only (G9)
//   savePractice({id, practice, final?})     → null                  ApiError 'practice_too_large' over 32,768 (B2)
//   saveTempo({id, tempo, baseRev?, saveId?}) → {tempoRev, conflict, tempo?}
//   remove({id}) · confirmRecording({id}) · dismissSectionSuggestion({id})
//   exportPage({paginationOpts})             → a page of SongFull with `practice`
import {mutation, query, subscribe} from './client.js';

export const list = () => query('songs:list', {});
export const get = args => query('songs:get', args);
export const getPractice = args => query('songs:getPractice', args);
export const getMany = args => query('songs:getMany', args);
export const exportPage = args => query('songs:exportPage', args);

export const savePractice = args => mutation('songs:savePractice', args);
export const saveTempo = args => mutation('songs:saveTempo', args);
export const remove = args => mutation('songs:remove', args);
export const confirmRecording = args => mutation('songs:confirmRecording', args);
export const dismissSectionSuggestion = args => mutation('songs:dismissSectionSuggestion', args);

/** The library (store.library, S1 data.js). */
export const subscribeList = (onValue, onError) => subscribe('songs:list', {}, onValue, onError);
/** One song for the session (§2.14.1 open order step 1). */
export const subscribeSong = (args, onValue, onError) => subscribe('songs:get', args, onValue, onError);
/** The song's practice, separately, so a practice save re-runs only this query (D52). */
export const subscribePractice = (args, onValue, onError) => subscribe('songs:getPractice', args, onValue, onError);
