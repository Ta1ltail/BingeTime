import { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useAuth } from './AuthContext'
import {
  fetchAllProgress, fetchLists,
  upsertProgress, addToList, removeFromList,
  importGuestData, readGuestProgress, writeGuestProgress,
  MOVIE_SENTINEL,
} from '../lib/userData'

/* eslint-disable react-refresh/only-export-components */

/**
 * UserDataContext — the auth-aware data layer for watch tracking.
 *
 * Signed in  → the DATABASE is the source of truth. All progress and list
 *              data is loaded once on login and written through on change
 *              (cross-device sync for free).
 * Signed out → guests keep the untouched BingeTime experience; only a small
 *              localStorage "continue watching" mirror is maintained so the
 *              guest → account migration has data to import.
 *
 * If Supabase is unreachable or auth expires mid-session, everything
 * degrades to guest behavior — the app never crashes on auth failures.
 *
 * Progress keys (client-side, built in lib/userData):
 *   movies   "m:<tmdbId>"
 *   episodes "t:<tmdbId>:<season>:<episode>"
 */

const UserDataContext = createContext(null)

const GUEST_IMPORT_DISMISS_KEY = 'bingetime.guest.importDismissed'

// ── helpers ──────────────────────────────────────────────────────────────────
const percentOf = (row) => Math.min(100, Math.round(row?.progress_percent ?? 0))

export const isRowWatched = (row) => Boolean(row?.watched) || percentOf(row) >= 90

// "Continue watching" = has real progress but is NOT finished (>= 90%).
export const isContinueCandidate = (row) => {
  if (!row) return false
  if (isRowWatched(row)) return false
  return percentOf(row) > 0
}

const buildListSets = (rows) => {
  const sets = { favorite: new Set(), like: new Set(), mylist: new Set() }
  for (const r of rows) {
    sets[r.list_type]?.add(`${r.media_type}:${r.tmdb_id}`)
  }
  return sets
}

const parseKey = (key) => {
  // "m:123" | "t:456:2:7"
  const parts = String(key).split(':')
  if (parts[0] === 'm') return { media_type: 'movie', tmdb_id: Number(parts[1]), season_number: null, episode_number: null }
  return { media_type: 'tv', tmdb_id: Number(parts[1]), season_number: Number(parts[2]), episode_number: Number(parts[3]) }
}

const byNewest = (a, b) => new Date(b.updated_at) - new Date(a.updated_at)

export const UserDataProvider = ({ children }) => {
  const { user, authReady } = useAuth()
  const [progressByKey, setProgressByKey] = useState(new Map())
  const [lists, setLists] = useState(() => buildListSets([]))
  const [listRows, setListRows] = useState([])
  const [dbError, setDbError] = useState(false)
  const [importBanner, setImportBanner] = useState({ open: false, counts: null })
  const userRef = useRef(null)
  useEffect(() => { userRef.current = user }, [user])

  // ── Load everything on sign-in; clear on sign-out ─────────────────────────
  // Syncs React state with the external system (Supabase); the setState calls
  // here are async callbacks from promises, not synchronous effect-body calls.
  useEffect(() => {
    if (!user?.id) {
      // Defer guest-reset so it never runs synchronously inside the effect.
      const t = setTimeout(() => {
        setProgressByKey(new Map())
        setLists(buildListSets([]))
        setListRows([])
        setDbError(false)
      }, 0)
      return () => clearTimeout(t)
    }
    let cancelled = false
    ;(async () => {
      try {
        const [progressRows, listRowsResult] = await Promise.all([fetchAllProgress(), fetchLists()])
        if (cancelled) return
        setProgressByKey(new Map(progressRows.map(r => [r.key, r])))
        setLists(buildListSets(listRowsResult))
        setListRows(listRowsResult)
        setDbError(false)
      } catch {
        if (!cancelled) setDbError(true)
      }
    })()
    return () => { cancelled = true }
  }, [user])

  // ── Guest import banner after signup/login (once per browser) ─────────────
  useEffect(() => {
    if (!user || !authReady) return
    const t = setTimeout(() => {
      if (localStorage.getItem(GUEST_IMPORT_DISMISS_KEY) === '1') return
      try {
        const guest = readGuestProgress()
        if (guest.length > 0) setImportBanner({ open: true, counts: { progress: guest.length } })
      } catch { /* ignore */ }
    }, 0)
    return () => clearTimeout(t)
  }, [user, authReady])

  // ── Progress writer (batched, deduped, retried with a hard cap) ───────────
  const inflightRef = useRef(new Map())   // key → promise currently on the wire
  const pendingRef  = useRef(new Map())   // key → newest row payload to write
  const attemptsRef = useRef(new Map())   // key → failed flush attempts
  const MAX_FLUSH_ATTEMPTS = 5

  const flushKey = useCallback(async (key) => {
    if (inflightRef.current.has(key)) return           // already writing; newest payload stays queued
    const row = pendingRef.current.get(key)
    if (!row) return
    pendingRef.current.delete(key)
    const promise = upsertProgress(row)
      .then(() => { attemptsRef.current.delete(key) })
      .catch((err) => {
        const code = String(err?.code ?? '')
        // Permanent failures (bad payload PGRST*, RLS 42501, schema 42xxx,
        // constraint 235xx…) can never succeed by retrying. Retrying them
        // forever is what spammed thousands of 400s — drop them instead.
        if (code.startsWith('PGRST') || /^[0-9]{5}$/.test(code)) {
          attemptsRef.current.delete(key)
          if (import.meta.env.DEV) {
            console.warn('[userdata] dropped non-retryable write:', err?.message, key)
          }
          return
        }
        // Transient failure: re-queue the newest payload, but only up to a cap
        // so a dead connection can never produce an infinite retry loop.
        const attempts = (attemptsRef.current.get(key) ?? 0) + 1
        attemptsRef.current.set(key, attempts)
        if (attempts >= MAX_FLUSH_ATTEMPTS) {
          attemptsRef.current.delete(key)
          if (import.meta.env.DEV) {
            console.warn('[userdata] gave up after retries:', key)
          }
          return
        }
        setDbError(true)
        const newest = pendingRef.current.get(key) ?? row
        pendingRef.current.set(key, newest)
      })
      .finally(() => { inflightRef.current.delete(key) })
    inflightRef.current.set(key, promise)
    await promise
  }, [])

  const flushAllPending = useCallback(() => {
    for (const key of [...pendingRef.current.keys()]) void flushKey(key)
  }, [flushKey])

  // Retry pending writes shortly after they fail (e.g. connection blips).
  useEffect(() => {
    if (dbError) {
      const t = setTimeout(() => { setDbError(false); flushAllPending() }, 15_000)
      return () => clearTimeout(t)
    }
    return undefined
  }, [dbError, flushAllPending])

  // Save important state when the user leaves the player/page.
  useEffect(() => {
    const onLeave = () => {
      if (!userRef.current) return
      for (const row of pendingRef.current.values()) {
        void upsertProgress(row).catch(() => {})
      }
      pendingRef.current.clear()
    }
    window.addEventListener('pagehide', onLeave)
    return () => window.removeEventListener('pagehide', onLeave)
  }, [])

  // ── Guest localStorage mirror (guests only) ───────────────────────────────
  const mirrorGuest = useCallback((row) => {
    const existing = readGuestProgress().filter(r => r.key !== row.key)
    writeGuestProgress([{ ...row, updated_at: new Date().toISOString() }, ...existing])
  }, [])

  // ── saveProgress — merge partial { position, duration, percent, watched } ─
  const saveProgress = useCallback((key, partial) => {
    const u = userRef.current
    if (!u) {
      // Guest: keep the localStorage mirror warm for later import.
      mirrorGuest({ key, ...partial })
      return
    }
    const prev = progressByKey.get(key) ?? {}
    const parsed = parseKey(key)
    // Numeric sentinels for movies (NOT NULL in the DB — never null).
    const season_number = partial.season_number ?? prev.season_number ?? parsed.season_number
    const episode_number = partial.episode_number ?? prev.episode_number ?? parsed.episode_number
    const merged = {
      ...prev,
      ...partial,
      user_id: u.id,
      key,
      media_type: parsed.media_type,
      tmdb_id: Number(parsed.tmdb_id),
      // Movies must carry the -1 sentinel; never null/undefined.
      season_number: season_number ?? (parsed.media_type === 'movie' ? MOVIE_SENTINEL : season_number),
      episode_number: episode_number ?? (parsed.media_type === 'movie' ? MOVIE_SENTINEL : episode_number),
      show_tmdb_id: parsed.media_type === 'tv' ? Number(parsed.tmdb_id) : null,
      poster_path: partial.poster_path ?? prev.poster_path ?? null,
      updated_at: new Date().toISOString(),
      // normalize for the DB writer
      position_seconds: partial.position_seconds ?? prev.position_seconds ?? 0,
      duration_seconds: partial.duration_seconds ?? prev.duration_seconds ?? null,
      progress_percent: partial.progress_percent ?? prev.progress_percent ?? 0,
      watched: Boolean(partial.watched ?? prev.watched),
    }
    // Optimistic state update — UI reacts instantly.
    setProgressByKey(prevMap => {
      const next = new Map(prevMap)
      next.set(key, merged)
      return next
    })
    // Queue the full row for the DB; flushKey dedupes per key.
    pendingRef.current.set(key, merged)
    void flushKey(key)
  }, [progressByKey, flushKey, mirrorGuest])

  // ── Lists (favorites / likes / mylist) — optimistic with rollback ─────────
  const toggleList = useCallback(async (listType, mediaType, tmdbId, meta = {}) => {
    const u = userRef.current
    if (!u) return
    const idStr = `${mediaType}:${tmdbId}`
    const inSet = lists[listType]?.has(idStr)
    const nextSets = { ...lists, [listType]: new Set(lists[listType]) }
    if (inSet) nextSets[listType].delete(idStr)
    else nextSets[listType].add(idStr)
    setLists(nextSets)
    const nextRows = inSet
      ? listRows.filter(r => !(r.list_type === listType && r.media_type === mediaType && r.tmdb_id === tmdbId))
      : [...listRows, {
        id: `optimistic-${Date.now()}`, user_id: u.id, list_type: listType,
        media_type: mediaType, tmdb_id: tmdbId,
        title: meta.title ?? '', poster_path: meta.poster_path ?? null,
        created_at: new Date().toISOString(),
      }]
    setListRows(nextRows)
    try {
      if (inSet) {
        await removeFromList(u.id, listType, mediaType, tmdbId)
      } else {
        await addToList({
          user_id: u.id,
          list_type: listType,
          media_type: mediaType,
          tmdb_id: tmdbId,
          title: meta.title ?? '',
          poster_path: meta.poster_path ?? null,
        })
      }
    } catch {
      setLists(lists) // roll back
      setListRows(listRows)
      setDbError(true)
    }
  }, [lists, listRows])

  // ── Derived collections (newest first) ────────────────────────────────────
  const continueWatching = useMemo(
    () => [...progressByKey.values()].filter(isContinueCandidate).sort(byNewest).slice(0, 12),
    [progressByKey]
  )

  const recentlyWatched = useMemo(
    () => [...progressByKey.values()].filter(r => percentOf(r) > 0).sort(byNewest).slice(0, 12),
    [progressByKey]
  )

  // ── Guest → account import ────────────────────────────────────────────────
  const startImport = useCallback(async () => {
    const u = userRef.current
    if (!u) return
    const guest = readGuestProgress()
    if (guest.length === 0) {
      setImportBanner({ open: false, counts: null })
      return
    }
    const progressPayload = guest.map(r => {
      const parsed = parseKey(r.key ?? '')
      return {
        media_type: parsed.media_type,
        tmdb_id: parsed.tmdb_id,
        season_number: parsed.season_number,
        episode_number: parsed.episode_number,
        // TV rows must reference their parent show (show_id_matches CHECK).
        show_tmdb_id: parsed.media_type === 'tv' ? parsed.tmdb_id : null,
        title: r.title ?? '',
        position_seconds: r.position_seconds ?? 0,
        duration_seconds: r.duration_seconds ?? null,
        progress_percent: r.progress_percent ?? 0,
        watched: r.watched ?? false,
      }
    }).filter(r => r.tmdb_id > 0)
    try {
      await importGuestData(progressPayload, [])
      localStorage.setItem(GUEST_IMPORT_DISMISS_KEY, '1')
      setImportBanner({ open: false, counts: null })
      // Reload the freshly merged data.
      const [progressRows, listRows] = await Promise.all([fetchAllProgress(), fetchLists()])
      setProgressByKey(new Map(progressRows.map(r => [r.key, r])))
      setLists(buildListSets(listRows))
      setListRows(listRows)
    } catch {
      setDbError(true)
    }
  }, [])

  const dismissImport = useCallback(() => {
    setImportBanner({ open: false, counts: null })
    localStorage.setItem(GUEST_IMPORT_DISMISS_KEY, '1')
  }, [])

  const value = useMemo(() => ({
    user, authReady,
    isAuthed: Boolean(user),
    progressByKey, lists, listRows, dbError,
    importBanner,
    saveProgress, toggleList,
    isWatched: (key) => isRowWatched(progressByKey.get(key)),
    getProgress: (key) => progressByKey.get(key),
    getShowProgress: (showTmdbId) =>
      [...progressByKey.values()].filter(r => r.media_type === 'tv' && r.tmdb_id === Number(showTmdbId)),
    isInList: (listType, mediaType, tmdbId) => Boolean(lists[listType]?.has(`${mediaType}:${tmdbId}`)),
    continueWatching, recentlyWatched,
    startImport, dismissImport,
  }), [user, authReady, progressByKey, lists, listRows, dbError, importBanner, saveProgress, toggleList, continueWatching, recentlyWatched, startImport, dismissImport])

  return (
    <UserDataContext.Provider value={value}>
      {children}
    </UserDataContext.Provider>
  )
}

export const useUserData = () => useContext(UserDataContext)
