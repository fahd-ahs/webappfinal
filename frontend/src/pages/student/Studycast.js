import { useState, useEffect, useRef, useCallback } from 'react';
import api, { BACKEND_URL } from '../../lib/api';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import {
  Headphones, Play, Pause, SkipBack, SkipForward, Volume2,
  Search, ChevronRight, X
} from 'lucide-react';

const containerV = { animate: { transition: { staggerChildren: 0.06, delayChildren: 0.1 } } };
const cardV = { initial: { opacity: 0, y: 20 }, animate: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] } } };

export default function Studycast() {
  const [episodes, setEpisodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [subjectFilter, setSubjectFilter] = useState('');
  const [playing, setPlaying] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [volume, setVolume] = useState(0.8);
  const [waveformLevels, setWaveformLevels] = useState(null);

  const audioRef = useRef(null);
  const progressIntervalRef = useRef(null);
  const lastSavedRef = useRef(0);
  const playingRef = useRef(null);
  const currentTimeRef = useRef(0);
  const playbackRateRef = useRef(playbackRate);
  const volumeRef = useRef(volume);
  const pendingSeekRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const rafRef = useRef(null);
  const playRequestIdRef = useRef(0);
  const preparingIdRef = useRef(null);

  playingRef.current = playing;
  currentTimeRef.current = currentTime;
  playbackRateRef.current = playbackRate;
  volumeRef.current = volume;

  const persistProgress = useCallback((ep, time, dur) => {
    if (!ep) return;
    const safeDur = dur || ep.duration_seconds || 0;
    const safeTime = Math.max(0, Math.min(Number(time) || 0, safeDur || Number(time) || 0));
    const pct = safeDur > 0 ? Math.min(100, Math.round((safeTime / safeDur) * 1000) / 10) : 0;
    setEpisodes(prev =>
      prev.map(item =>
        item.id === ep.id
          ? { ...item, progress: { ...(item.progress || {}), current_time: safeTime, duration: safeDur, percentage: pct } }
          : item
      )
    );
    api.post(`/studycast/${ep.id}/progress`, { current_time: safeTime, duration: safeDur }).catch(() => {});
  }, []);

  const stopWaveformLoop = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setWaveformLevels(null);
  }, []);

  const ensureAudioContextRunning = useCallback(() => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioCtx();
      }
      if (audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {});
      }
      return audioCtxRef.current;
    } catch {
      return null;
    }
  }, []);

  const startWaveformLoop = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      const ctx = audioCtxRef.current;
      // Only route audio through Web Audio if AudioContext is actively running so a suspended context never mutes playback
      if (!ctx || ctx.state !== 'running') {
        return;
      }
      if (!sourceNodeRef.current) {
        sourceNodeRef.current = ctx.createMediaElementSource(audio);
        analyserRef.current = ctx.createAnalyser();
        analyserRef.current.fftSize = 64;
        analyserRef.current.smoothingTimeConstant = 0.75;
        sourceNodeRef.current.connect(analyserRef.current);
        analyserRef.current.connect(ctx.destination);
      }
      const analyser = analyserRef.current;
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(dataArray);
        const bands = [1, 3, 5, 8, 12].map(idx => {
          const val = dataArray[idx] || 0;
          return Math.max(22, Math.min(100, Math.round((val / 255) * 100)));
        });
        setWaveformLevels(bands);
        rafRef.current = requestAnimationFrame(tick);
      };
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      // Fallback to CSS waveform animation if Web Audio is restricted
    }
  }, []);

  useEffect(() => {
    const audioEl = audioRef.current;
    const fetchEpisodes = async () => {
      try {
        const { data } = await api.get('/studycast');
        setEpisodes(data);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    fetchEpisodes();
    return () => {
      if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
      stopWaveformLoop();
      if (audioEl) {
        const activeEp = playingRef.current;
        playingRef.current = null;
        if (activeEp) {
          persistProgress(activeEp, audioEl.currentTime || currentTimeRef.current, audioEl.duration || activeEp.duration_seconds);
        }
        audioEl.pause();
        audioEl.removeAttribute('src');
        audioEl.load();
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
      }
    };
  }, [persistProgress, stopWaveformLoop]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [volume]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;

    const handleLoadedMetadata = () => {
      const ep = playingRef.current;
      if (!ep) return;
      const realDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? Math.round(audio.duration) : ep.duration_seconds;
      if (realDuration && realDuration !== ep.duration_seconds) {
        const realLabel = `${Math.floor(realDuration / 60)}:${String(realDuration % 60).padStart(2, '0')}`;
        setPlaying(prev => (prev && prev.id === ep.id ? { ...prev, duration_seconds: realDuration, duration_label: realLabel } : prev));
        setEpisodes(prev => prev.map(item => (item.id === ep.id ? { ...item, duration_seconds: realDuration, duration_label: realLabel } : item)));
      }
      if (pendingSeekRef.current !== null && realDuration > 0) {
        const target = Math.max(0, Math.min(pendingSeekRef.current, Math.max(0, realDuration - 1)));
        audio.currentTime = target;
        setCurrentTime(target);
        pendingSeekRef.current = null;
      }
      audio.volume = volumeRef.current;
      audio.playbackRate = playbackRateRef.current;
    };

    const handleDurationChange = () => {
      const ep = playingRef.current;
      if (!ep || !ep.is_neural_podcast) return;
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        const realDuration = Math.round(audio.duration);
        if (realDuration !== ep.duration_seconds) {
          const realLabel = `${Math.floor(realDuration / 60)}:${String(realDuration % 60).padStart(2, '0')}`;
          setPlaying(prev => (prev && prev.id === ep.id ? { ...prev, duration_seconds: realDuration, duration_label: realLabel } : prev));
          setEpisodes(prev => prev.map(item => (item.id === ep.id ? { ...item, duration_seconds: realDuration, duration_label: realLabel } : item)));
        }
      }
    };

    const handleTimeUpdate = () => {
      const ep = playingRef.current;
      if (!ep || !ep.is_neural_podcast) return;
      const t = audio.currentTime || 0;
      setCurrentTime(t);
      const now = Date.now();
      if (now - lastSavedRef.current >= 5000) {
        lastSavedRef.current = now;
        persistProgress(ep, t, audio.duration || ep.duration_seconds);
      }
    };

    const handlePlay = () => {
      if (playingRef.current?.is_neural_podcast) {
        setIsPlaying(true);
        startWaveformLoop();
      }
    };

    const handlePause = () => {
      if (playingRef.current?.is_neural_podcast) {
        setIsPlaying(false);
        stopWaveformLoop();
      }
    };

    const handleEnded = () => {
      const ep = playingRef.current;
      if (!ep || !ep.is_neural_podcast) return;
      const dur = audio.duration || ep.duration_seconds || 0;
      setIsPlaying(false);
      setCurrentTime(dur);
      stopWaveformLoop();
      persistProgress(ep, dur, dur);
    };

    const handleError = () => {
      if (playingRef.current?.is_neural_podcast) {
        setIsPlaying(false);
        stopWaveformLoop();
        toast.error('Unable to play episode audio. Verify audio generation credentials are configured on the server.');
      }
    };

    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('durationchange', handleDurationChange);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', handleError);
    return () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('durationchange', handleDurationChange);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('error', handleError);
    };
  }, [persistProgress, startWaveformLoop, stopWaveformLoop]);

  const subjects = [...new Set(episodes.map(e => e.subject_name))];
  const filtered = episodes.filter(e => {
    if (subjectFilter && e.subject_name !== subjectFilter) return false;
    if (search && !e.title.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const continueListening = episodes.filter(e => e.progress && e.progress.percentage > 0 && e.progress.percentage < 100);

  const buildMediaSrc = (audioUrl) => {
    const token = localStorage.getItem('access_token');
    const base = `${BACKEND_URL}${audioUrl}`;
    if (!token) return base;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}token=${encodeURIComponent(token)}`;
  };

  const playEpisode = async (ep) => {
    if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);

    if (ep.is_neural_podcast && preparingIdRef.current === ep.id) {
      toast.info(`Preparing podcast audio for "${ep.title}"...`, { id: `studycast-prep-${ep.id}` });
      return;
    }

    const requestId = ++playRequestIdRef.current;

    // Save previous episode progress when switching
    if (playingRef.current && playingRef.current.id !== ep.id) {
      const prevTime = playingRef.current.is_neural_podcast && audioRef.current
        ? audioRef.current.currentTime
        : currentTimeRef.current;
      persistProgress(playingRef.current, prevTime, playingRef.current.duration_seconds);
    }

    if (ep.is_neural_podcast) {
      ensureAudioContextRunning();
      let targetEp = ep;
      if (!targetEp.has_audio || !targetEp.audio_url) {
        preparingIdRef.current = ep.id;
        toast.loading(`Preparing podcast audio for "${ep.title}"...`, { id: `studycast-prep-${ep.id}` });
        try {
          const { data } = await api.post(`/studycast/${ep.id}/audio/prepare`);
          if (!data || typeof data !== 'object' || !data.audio_url) {
            toast.error('Podcast audio is not ready yet. Verify server configuration.', { id: `studycast-prep-${ep.id}` });
            return;
          }
          toast.dismiss(`studycast-prep-${ep.id}`);
          targetEp = {
            ...ep,
            has_audio: true,
            audio_url: data.audio_url,
            duration_seconds: data.duration_seconds,
            duration_label: data.duration_label,
          };
          setEpisodes(prev => prev.map(item => (item.id === ep.id ? { ...item, ...targetEp } : item)));
        } catch (err) {
          const msg = err.response?.data?.detail || 'Podcast audio requires GEMINI_API_KEY configured on the server.';
          toast.error(msg, { id: `studycast-prep-${ep.id}` });
          return;
        } finally {
          if (preparingIdRef.current === ep.id) {
            preparingIdRef.current = null;
          }
        }
      }

      if (playRequestIdRef.current !== requestId) {
        return;
      }

      const resumeFrom =
        targetEp.progress?.current_time &&
        targetEp.duration_seconds &&
        targetEp.progress.current_time < targetEp.duration_seconds - 1
          ? targetEp.progress.current_time
          : 0;

      setPlaying(targetEp);
      setCurrentTime(resumeFrom);
      lastSavedRef.current = Date.now();

      const audio = audioRef.current;
      if (audio) {
        pendingSeekRef.current = resumeFrom;
        audio.pause();
        audio.src = buildMediaSrc(targetEp.audio_url);
        audio.load();
        audio.volume = volume;
        audio.playbackRate = playbackRate;
        try {
          await audio.play();
          setIsPlaying(true);
        } catch (err) {
          setIsPlaying(false);
          if (err?.name !== 'AbortError') {
            toast.error('Click Play in the player bar to start audio playback.');
          }
        }
      }
      return;
    }

    // Remaining 6 episodes keep existing behavior
    if (audioRef.current) {
      audioRef.current.pause();
      stopWaveformLoop();
    }
    setPlaying(ep);
    let time = ep.progress?.current_time || 0;
    setCurrentTime(time);
    setIsPlaying(true);
    progressIntervalRef.current = setInterval(() => {
      time += playbackRateRef.current;
      if (time >= ep.duration_seconds) {
        clearInterval(progressIntervalRef.current);
        setIsPlaying(false);
        time = ep.duration_seconds;
      }
      setCurrentTime(time);
    }, 1000);
  };

  const togglePlay = async () => {
    if (!playing) return;
    if (playing.is_neural_podcast && audioRef.current) {
      const audio = audioRef.current;
      if (isPlaying) {
        audio.pause();
        persistProgress(playing, audio.currentTime, audio.duration || playing.duration_seconds);
      } else {
        ensureAudioContextRunning();
        try {
          audio.volume = volume;
          audio.playbackRate = playbackRate;
          await audio.play();
        } catch (err) {
          if (err?.name !== 'AbortError') {
            toast.error('Unable to resume playback.');
          }
        }
      }
      return;
    }

    if (isPlaying) {
      clearInterval(progressIntervalRef.current);
      setIsPlaying(false);
      persistProgress(playing, currentTime, playing.duration_seconds);
    } else {
      let time = currentTime;
      progressIntervalRef.current = setInterval(() => {
        time += playbackRateRef.current;
        if (time >= playing.duration_seconds) {
          clearInterval(progressIntervalRef.current);
          setIsPlaying(false);
          time = playing.duration_seconds;
        }
        setCurrentTime(time);
      }, 1000);
      setIsPlaying(true);
    }
  };

  const skip = (seconds) => {
    if (!playing) return;
    const maxDur =
      playing.is_neural_podcast && audioRef.current && Number.isFinite(audioRef.current.duration) && audioRef.current.duration > 0
        ? audioRef.current.duration
        : playing.duration_seconds || 0;
    const baseTime = playing.is_neural_podcast && audioRef.current ? audioRef.current.currentTime : currentTime;
    const newTime = Math.max(0, Math.min(baseTime + seconds, maxDur));
    if (playing.is_neural_podcast && audioRef.current) {
      audioRef.current.currentTime = newTime;
      persistProgress(playing, newTime, maxDur);
    }
    setCurrentTime(newTime);
  };

  const seekTo = (e) => {
    if (!playing) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const maxDur =
      playing.is_neural_podcast && audioRef.current && Number.isFinite(audioRef.current.duration) && audioRef.current.duration > 0
        ? audioRef.current.duration
        : playing.duration_seconds || 0;
    const newTime = pct * maxDur;
    if (playing.is_neural_podcast && audioRef.current) {
      audioRef.current.currentTime = newTime;
      persistProgress(playing, newTime, maxDur);
    }
    setCurrentTime(newTime);
  };

  const closePlayer = () => {
    if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    if (playingRef.current) {
      const t =
        playingRef.current.is_neural_podcast && audioRef.current
          ? audioRef.current.currentTime
          : currentTimeRef.current;
      persistProgress(playingRef.current, t, playingRef.current.duration_seconds);
    }
    if (audioRef.current) {
      audioRef.current.pause();
    }
    stopWaveformLoop();
    setPlaying(null);
    setIsPlaying(false);
  };

  const formatTime = (s) => {
    const safe = Math.max(0, Number(s) || 0);
    const m = Math.floor(safe / 60);
    const sec = Math.floor(safe % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  if (loading) return <StudycastSkeleton />;

  return (
    <motion.div data-testid="studycast-page" variants={containerV} initial="initial" animate="animate" className="space-y-6">
      <audio
        ref={audioRef}
        preload="metadata"
        crossOrigin={BACKEND_URL ? 'anonymous' : undefined}
        className="hidden"
      />
      {/* Header */}
      <motion.div variants={cardV} className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-400 flex items-center justify-center">
            <Headphones className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold font-['Outfit']">Studycast</h1>
            <p className="text-[var(--text-muted)] text-sm">{episodes.length} episodes available</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
            <input
              data-testid="studycast-search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search episodes..."
              className="bg-[var(--surface-2)] border border-[var(--border-subtle)] rounded-xl pl-9 pr-4 py-2 text-sm text-white placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500/50 w-56"
            />
          </div>
          <select
            data-testid="studycast-filter"
            value={subjectFilter}
            onChange={e => setSubjectFilter(e.target.value)}
            className="bg-[var(--surface-2)] border border-[var(--border-subtle)] rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
          >
            <option value="">All Subjects</option>
            {subjects.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </motion.div>

      {/* Continue Listening */}
      {continueListening.length > 0 && (
        <motion.div variants={cardV}>
          <h2 className="text-sm font-semibold text-[var(--text-secondary)] mb-3 uppercase tracking-wider">Continue Listening</h2>
          {continueListening.map(ep => (
            <div
              key={ep.id}
              onClick={() => playEpisode(ep)}
              data-testid={`continue-${ep.id}`}
              className="glass-card p-4 flex items-center gap-4 cursor-pointer hover:border-indigo-500/20 transition-all group"
            >
              <div className="w-14 h-14 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: `${ep.thumbnail_color}20` }}>
                <Headphones className="w-6 h-6" style={{ color: ep.thumbnail_color }} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate group-hover:text-indigo-400 transition-colors">{ep.title}</p>
                <p className="text-xs text-[var(--text-muted)]">{ep.subject_name} · {ep.instructor} · {ep.duration_label}</p>
                <div className="h-1.5 bg-[var(--surface-3)] rounded-full mt-2 overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-indigo-500 to-cyan-400 rounded-full" style={{ width: `${ep.progress?.percentage || 0}%` }} />
                </div>
              </div>
              <div className="text-xs text-indigo-400 font-mono">{Math.round(ep.progress?.percentage || 0)}%</div>
              <ChevronRight className="w-4 h-4 text-[var(--text-muted)] group-hover:text-indigo-400 transition-colors" />
            </div>
          ))}
        </motion.div>
      )}

      {/* All Episodes Grid */}
      <motion.div variants={cardV}>
        <h2 className="text-sm font-semibold text-[var(--text-secondary)] mb-3 uppercase tracking-wider">All Episodes</h2>
        {filtered.length === 0 ? (
          <div className="text-center py-12">
            <Headphones className="w-10 h-10 text-[var(--text-muted)] mx-auto mb-3 opacity-30" />
            <p className="text-[var(--text-muted)]">No episodes found</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filtered.map((ep) => (
              <motion.div
                key={ep.id}
                variants={cardV}
                whileHover={{ y: -4, boxShadow: '0 8px 30px rgba(99,102,241,0.15)' }}
                onClick={() => playEpisode(ep)}
                data-testid={`episode-${ep.id}`}
                className="glass-card p-4 cursor-pointer hover:border-indigo-500/20 transition-all group"
              >
                <div className="w-full h-28 rounded-xl mb-3 flex items-center justify-center relative overflow-hidden" style={{ background: `linear-gradient(135deg, ${ep.thumbnail_color}15, ${ep.thumbnail_color}30)` }}>
                  <Headphones className="w-10 h-10 opacity-40" style={{ color: ep.thumbnail_color }} />
                  <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/30">
                    <div className="w-12 h-12 rounded-full bg-indigo-500 flex items-center justify-center shadow-lg">
                      <Play className="w-5 h-5 text-white ml-0.5" />
                    </div>
                  </div>
                </div>
                <p className="text-sm font-semibold truncate group-hover:text-indigo-400 transition-colors">{ep.title}</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">{ep.subject_name} · {ep.duration_label}</p>
                <p className="text-[11px] text-[var(--text-muted)] mt-0.5">{ep.instructor}</p>
              </motion.div>
            ))}
          </div>
        )}
      </motion.div>

      {/* Sticky Mini Player */}
      <AnimatePresence>
        {playing && (
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            data-testid="studycast-player"
            className="fixed bottom-0 left-0 right-0 z-50 border-t border-[var(--border-subtle)]"
            style={{ background: 'rgba(10, 14, 26, 0.95)', backdropFilter: 'blur(20px)' }}
          >
            <div className="max-w-screen-xl mx-auto px-6 py-3">
              {/* Progress bar */}
              <div className="h-1 bg-[var(--surface-3)] rounded-full mb-3 cursor-pointer group" onClick={seekTo} data-testid="player-progress">
                <motion.div
                  className="h-full bg-gradient-to-r from-indigo-500 to-cyan-400 rounded-full relative"
                  style={{ width: `${playing.duration_seconds > 0 ? (currentTime / playing.duration_seconds) * 100 : 0}%` }}
                >
                  <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white shadow-md opacity-0 group-hover:opacity-100 transition-opacity" />
                </motion.div>
              </div>
              <div className="flex items-center gap-4">
                {/* Track Info */}
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <div className="w-10 h-10 rounded-lg flex-shrink-0 flex items-center justify-center" style={{ background: `${playing.thumbnail_color}20` }}>
                    {isPlaying ? (
                      <div className="flex items-end gap-0.5 h-5">
                        {[1,2,3,4,5].map((barIdx, idx) => (
                          <div
                            key={barIdx}
                            className="waveform-bar"
                            style={
                              waveformLevels
                                ? { height: `${waveformLevels[idx]}%`, animation: 'none' }
                                : { animationDelay: `${barIdx * 0.1}s` }
                            }
                          />
                        ))}
                      </div>
                    ) : (
                      <Headphones className="w-4 h-4" style={{ color: playing.thumbnail_color }} />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{playing.title}</p>
                    <p className="text-[11px] text-[var(--text-muted)]">{playing.instructor}</p>
                  </div>
                </div>

                {/* Controls */}
                <div className="flex items-center gap-3">
                  <button onClick={() => skip(-10)} className="p-2 rounded-lg hover:bg-[var(--surface-2)] transition-colors" data-testid="player-rewind">
                    <SkipBack className="w-4 h-4 text-[var(--text-secondary)]" />
                  </button>
                  <button
                    onClick={togglePlay}
                    data-testid="player-play-pause"
                    className="w-10 h-10 rounded-full bg-indigo-500 hover:bg-indigo-400 flex items-center justify-center transition-colors shadow-lg shadow-indigo-500/25"
                  >
                    {isPlaying ? <Pause className="w-4 h-4 text-white" /> : <Play className="w-4 h-4 text-white ml-0.5" />}
                  </button>
                  <button onClick={() => skip(10)} className="p-2 rounded-lg hover:bg-[var(--surface-2)] transition-colors" data-testid="player-forward">
                    <SkipForward className="w-4 h-4 text-[var(--text-secondary)]" />
                  </button>
                </div>

                {/* Time + Speed */}
                <div className="hidden md:flex items-center gap-4">
                  <span className="text-xs font-mono text-[var(--text-muted)]">
                    {formatTime(currentTime)} / {formatTime(playing.duration_seconds)}
                  </span>
                  <select
                    value={playbackRate}
                    onChange={e => setPlaybackRate(Number(e.target.value))}
                    data-testid="player-speed"
                    className="bg-[var(--surface-2)] border border-[var(--border-subtle)] rounded-lg px-2 py-1 text-xs text-white focus:outline-none"
                  >
                    {[0.75, 1, 1.25, 1.5, 2].map(r => <option key={r} value={r}>{r}x</option>)}
                  </select>
                  <div className="flex items-center gap-2">
                    <Volume2 className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                    <input
                      type="range" min="0" max="1" step="0.1" value={volume}
                      onChange={e => setVolume(Number(e.target.value))}
                      className="w-16 accent-indigo-500"
                    />
                  </div>
                </div>

                <button onClick={closePlayer} className="p-2 rounded-lg hover:bg-[var(--surface-2)] transition-colors">
                  <X className="w-4 h-4 text-[var(--text-muted)]" />
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function StudycastSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-10 w-48 rounded-xl bg-[var(--surface-1)] shimmer-bg" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="glass-card shimmer-bg rounded-2xl" style={{ height: 220 }} />
        ))}
      </div>
    </div>
  );
}
