import { supabase } from './supabase'

// ── Row shapes ↔ DB ──────────────────────────────────────────────────────────
// watch_progress: movies use season -1 / episode -1 sentinels (see migration).
// Client-side keys: movies are `m:<tmdbId>`, episodes are `t:<tmdbId>:<s>:<e>`.

export const movieKey   = (tmdbId) => `m:${tmdbId}`
export const episodeKey = (tmdbId, season, episode) => `t:${tmdbId}:${season}:${episode}`

export const MOVIE_SENTINEL = -1

export const progressRowToKeyed = (row) => {
  if (row.media_type === 'movie') {
    return { key: movieKey(row.tmdb_id), ...row }
  }
  return { key: episodeKey(row.tmdb_id, row.season_number, row.episode_number), ...row }
}

export const buildMovieProgressRow = (user, { tmdbId, title }) => ({
  user_id: user.id,
  media_type: 'movie',
  tmdb_id: tmdbId,
  season_number: MOVIE_SENTINEL,
  episode_number: MOVIE_SENTINEL,
  show_tmdb_id: null,
  title: title ?? '',
})

export const buildEpisodeProgressRow = (user, { tmdbId, season, episode, showTitle }) => ({
  user_id: user.id,
  media_type: 'tv',
  tmdb_id: tmdbId,
  season_number: season,
  episode_number: episode,
  show_tmdb_id: tmdbId,
  // The show title is the stable display field for TV rows; episode names
  // change/too long — the UI looks those up from TMDB episode lists.
  title: showTitle ?? '',
})

// Map a full client row (string `key` form or numeric sentinel form) to the
// exact DB column set. Used before every upsert — PostgREST rejects any
// payload field that isn't a real table column (PGRST204 → HTTP 400).
export const toDbRow = (row) => {
  const isTv = row.media_type === 'tv'
  const season = isTv
    ? Number(row.season_number)
    : (typeof row.season_number === 'number' ? row.season_number : MOVIE_SENTINEL)
  const episode = isTv
    ? Number(row.episode_number)
    : (typeof row.episode_number === 'number' ? row.episode_number : MOVIE_SENTINEL)
  return {
    user_id: row.user_id,
    media_type: isTv ? 'tv' : 'movie',
    tmdb_id: Number(row.tmdb_id),
    season_number: season,
    episode_number: episode,
    // TV rows must carry their own id (DB CHECK: show_id_matches).
    show_tmdb_id: isTv ? Number(row.show_tmdb_id ?? row.tmdb_id) : null,
    title: row.title ?? '',
    poster_path: row.poster_path ?? null,
    position_seconds: row.position_seconds ?? 0,
    duration_seconds: row.duration_seconds ?? null,
    progress_percent: row.progress_percent ?? 0,
    watched: Boolean(row.watched),
    // Never send the client-only `key` field (nor stale id/created_at) to PostgREST.
  }
}

// ── Fetch helpers (all RLS-scoped to the signed-in user) ────────────────────
export const fetchAllProgress = async () => {
  const { data, error } = await supabase
    .from('watch_progress')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(1000)
  if (error) throw error
  return (data ?? []).map(progressRowToKeyed)
}

export const fetchLists = async () => {
  const { data, error } = await supabase
    .from('user_media_lists')
    .select('*')
    .limit(2000)
  if (error) throw error
  return data ?? []
}

// ── Writes ───────────────────────────────────────────────────────────────────
export const upsertProgress = async (row) => {
  const { error } = await supabase
    .from('watch_progress')
    .upsert(toDbRow(row), {
      onConflict: 'user_id,media_type,tmdb_id,season_number,episode_number',
    })
  if (error) throw error
}

export const deleteProgress = async (id) => {
  const { error } = await supabase.from('watch_progress').delete().eq('id', id)
  if (error) throw error
}

export const addToList = async (row) => {
  const { error } = await supabase.from('user_media_lists').insert(row)
  // Ignore "already in list" races gracefully.
  if (error && error.code !== '23505') throw error
}

export const removeFromList = async (userId, listType, mediaType, tmdbId) => {
  const { error } = await supabase
    .from('user_media_lists')
    .delete()
    .match({ user_id: userId, list_type: listType, media_type: mediaType, tmdb_id: tmdbId })
  if (error) throw error
}

// ── Guest → account migration (RPC) ─────────────────────────────────────────
export const importGuestData = async (progressRows, listRows) => {
  const { data, error } = await supabase.rpc('import_guest_data', {
    p_progress: progressRows,
    p_lists: listRows,
  })
  if (error) throw error
  return data
}

// ── Guest (localStorage) mirror ─────────────────────────────────────────────
// Guests get a light version of the same tracking: "Continue watching" for
// the last few items, so the feature exists but stays local-only.
const GUEST_PROGRESS_KEY = 'bingetime.guest.progress'

export const readGuestProgress = () => {
  try {
    const raw = localStorage.getItem(GUEST_PROGRESS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export const writeGuestProgress = (rows) => {
  try {
    // Keep the last 20 items, newest first.
    const next = rows.slice(0, 20)
    localStorage.setItem(GUEST_PROGRESS_KEY, JSON.stringify(next))
  } catch {
    /* storage full/blocked — ignore */
  }
}
