import { useRef, useEffect, useCallback } from 'react'
import { useUserData } from '../contexts/UserDataContext'
import { movieKey, episodeKey } from '../lib/userData'

/**
 * useWatchTracker — real playback-time tracking on top of the player.
 *
 * Captures WALL-CLOCK seconds actually spent playing (pauses and tab-blur
 * don't inflate progress), converts them to percent via the known duration,
 * and saves in batched checkpoints so the DB is never written per second:
 *
 *   • every CHECKPOINT_INTERVAL seconds of accumulated play time
 *   • on pause (setPlaying(false)) / on leaving the page
 *   • when the tracked item changes (immediate final save)
 *
 * Completion: >= COMPLETION_THRESHOLD% marks the item watched automatically.
 * markWatched() allows manual "Mark as watched" without playback data.
 *
 * The embed player can't be probed for its real currentTime (cross-origin),
 * so position is wall-clock play time; duration comes from TMDB runtimes.
 */

const CHECKPOINT_INTERVAL = 20 // seconds of play time between DB writes
const COMPLETION_THRESHOLD = 90 // percent

const useWatchTracker = ({
  tmdbId,
  mediaType,          // 'movie' | 'tv'
  season = null,      // tv only
  episode = null,     // tv only
  title = '',         // show title (tv) or movie title
  initialPosition = 0,
  duration = null,    // seconds — from TMDB runtime
  enabled = true,
}) => {
  const { saveProgress } = useUserData()

  const positionRef = useRef(initialPosition) // last known playback position (s)
  const durationRef = useRef(duration)
  const percentRef = useRef(0)

  const accumRef = useRef(0)        // wall-clock play seconds since last save
  const lastTickRef = useRef(null)  // Date.now() of the previous playing tick
  const playingRef = useRef(false)

  // Keep the live duration without touching refs during render.
  useEffect(() => { durationRef.current = duration }, [duration])

  const key = mediaType === 'tv'
    ? episodeKey(tmdbId, season, episode)
    : movieKey(tmdbId)

  const computePercent = useCallback((position, dur) => {
    if (!dur || dur <= 0) return 0
    return Math.min(100, Math.round((position / dur) * 100))
  }, [])

  // ── persist now (batched writer in UserDataContext dedupes per key) ───────
  const persist = useCallback(() => {
    const percent = computePercent(positionRef.current, durationRef.current)
    percentRef.current = percent
    saveProgress(key, {
      media_type: mediaType,
      tmdb_id: tmdbId,
      season_number: mediaType === 'tv' ? season : null,
      episode_number: mediaType === 'tv' ? episode : null,
      title,
      position_seconds: Math.round(positionRef.current),
      duration_seconds: durationRef.current ?? null,
      progress_percent: percent,
      watched: percent >= COMPLETION_THRESHOLD,
    })
  }, [saveProgress, key, mediaType, tmdbId, season, episode, title, computePercent])

  // persist is recreated whenever saveProgress identity changes; effects below
  // must NOT depend on it — doing so re-fires persist on every state update
  // (an infinite persist→setState→persist loop that also starves React
  // Router's transition-based route renders: URL changes, page never swaps).
  // A ref keeps the effects stable while always calling the latest closure.
  const persistRef = useRef(persist)
  useEffect(() => { persistRef.current = persist }, [persist])

  // ── 1s clock: accumulate wall-clock play time, checkpoint every 20s ───────
  useEffect(() => {
    if (!enabled) return undefined
    const tick = () => {
      if (!playingRef.current) {
        lastTickRef.current = null
        return
      }
      // Don't count time while the tab is hidden.
      if (document.visibilityState === 'hidden') {
        lastTickRef.current = null
        return
      }
      const now = Date.now()
      if (lastTickRef.current != null) {
        accumRef.current += (now - lastTickRef.current) / 1000
        if (accumRef.current >= CHECKPOINT_INTERVAL) {
          accumRef.current = 0
          persistRef.current()
        }
      }
      lastTickRef.current = now
    }
    const t = setInterval(tick, 1000)
    const onVisibility = () => { if (document.visibilityState === 'hidden') persistRef.current() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled])

  // ── flush immediately when the tracked item changes or unmounts ───────────
  const keyRef = useRef(key)
  useEffect(() => {
    const prevKey = keyRef.current
    keyRef.current = key
    if (prevKey !== key) {
      accumRef.current = 0
      lastTickRef.current = null
      // persistRef already points at the newest render's closure (synced
      // above), so this saves under the NEW key — the row that matters
      // for resume. Identity-free deps: never re-fires on state updates.
      persistRef.current()
    }
  }, [key])

  // Flush on page leave (and once when the tracker unmounts).
  const enabledRef = useRef(enabled)
  useEffect(() => { enabledRef.current = enabled }, [enabled])
  useEffect(() => {
    const onLeave = () => { if (enabledRef.current) persistRef.current() }
    window.addEventListener('pagehide', onLeave)
    return () => {
      window.removeEventListener('pagehide', onLeave)
      if (enabledRef.current) persistRef.current()
    }
  }, [])

  // Playing state: cross-origin embeds can't report play/pause, so the
  // tracker treats "enabled" (player open & tab visible) as playing.
  useEffect(() => {
    playingRef.current = Boolean(enabled)
    if (!enabled) {
      lastTickRef.current = null
      persistRef.current()
    }
  }, [enabled])

  const setDuration = useCallback((seconds) => {
    if (!seconds || seconds <= 0) return
    durationRef.current = seconds
    percentRef.current = computePercent(positionRef.current, seconds)
  }, [computePercent])

  const setPosition = useCallback((seconds) => {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return
    positionRef.current = seconds
    percentRef.current = computePercent(seconds, durationRef.current)
  }, [computePercent])

  const markWatched = useCallback(() => {
    positionRef.current = durationRef.current ?? positionRef.current
    percentRef.current = 100
    saveProgress(key, {
      media_type: mediaType,
      tmdb_id: tmdbId,
      season_number: mediaType === 'tv' ? season : null,
      episode_number: mediaType === 'tv' ? episode : null,
      title,
      position_seconds: Math.round(positionRef.current),
      duration_seconds: durationRef.current ?? null,
      progress_percent: 100,
      watched: true,
    })
  }, [saveProgress, key, mediaType, tmdbId, season, episode, title])

  return { setDuration, setPosition, markWatched }
}

export default useWatchTracker
