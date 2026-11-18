import { useEffect, useRef, useState } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  Download,
  CloudUpload,
  Check,
  Loader2,
  SlidersHorizontal,
  Volume2,
  VolumeX,
  AlertCircle,
} from 'lucide-react';
import type {
  AudioJob,
  ChannelMode,
  ExportFormat,
  ExportSettings,
  Mp3Bitrate,
  SampleRate,
  WavBitDepth,
} from '../types/audio';
import { formatDuration, formatBytes } from '../lib/formatters';
import { AiVoiceClarityPanel } from './AiVoiceClarityPanel';

interface WaveformDeckProps {
  job: AudioJob | null;
  exportSettings: ExportSettings;
  onExportSettingsChange: (next: ExportSettings) => void;
  onDownload: (job: AudioJob, settings: ExportSettings) => void;
  onSyncToDrive: (job: AudioJob, settings: ExportSettings) => Promise<void>;
  onProcessJob: (job: AudioJob) => void;
  onJobUpdated: (updated: AudioJob) => void;
  isGoogleConnected: boolean;
  isSyncing: boolean;
}

export function WaveformDeck({
  job,
  exportSettings,
  onExportSettingsChange,
  onDownload,
  onSyncToDrive,
  onProcessJob,
  onJobUpdated,
  isGoogleConnected,
  isSyncing,
}: WaveformDeckProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [variant, setVariant] = useState<'original' | 'cleaned'>('cleaned');
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);

  const isCleanedAvailable = job?.status === 'ready' && job.cleanedPeaks.length > 0;
  const effectiveVariant: 'original' | 'cleaned' =
    variant === 'cleaned' && isCleanedAvailable ? 'cleaned' : 'original';

  const streamUrl = job
    ? `/api/jobs/${job.id}/stream?variant=${effectiveVariant}${
        effectiveVariant === 'cleaned' && job.processedAt
          ? `&v=${encodeURIComponent(job.processedAt)}`
          : ''
      }`
    : '';

  // Reset playback state when switching selected job
  useEffect(() => {
    setIsPlaying(false);
    setIsBuffering(false);
    setPlaybackError(null);
    setCurrentTime(0);
    if (job?.status === 'ready') {
      setVariant('cleaned');
    } else {
      setVariant('original');
    }
  }, [job?.id]);

  // Switch to cleaned preview automatically once processing finishes
  useEffect(() => {
    if (job?.status === 'ready') {
      setVariant('cleaned');
    }
  }, [job?.status]);

  // Keep volume & mute synchronized with <audio>
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = volume;
    audio.muted = isMuted;
  }, [volume, isMuted, job?.id]);

  // Keep <audio> src synced to selected job & A/B variant while preserving playhead
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !job || !streamUrl) return;

    if (audio.getAttribute('data-stream-url') === streamUrl) return;

    const prevJobId = audio.getAttribute('data-job-id');
    const isSameJob = prevJobId === job.id;
    const savedTime = isSameJob ? audio.currentTime || currentTime : 0;
    const wasPlaying = isSameJob && !audio.paused;

    setPlaybackError(null);
    setIsBuffering(wasPlaying);

    audio.setAttribute('data-stream-url', streamUrl);
    audio.setAttribute('data-job-id', job.id);
    audio.src = streamUrl;
    audio.volume = volume;
    audio.muted = isMuted;
    audio.load();

    const handleLoadedMetadata = () => {
      if (savedTime > 0 && savedTime < (audio.duration || job.durationSeconds)) {
        try {
          audio.currentTime = savedTime;
        } catch {
          // Ignore seek error before buffer ready
        }
      }
      if (wasPlaying) {
        void audio.play().catch((err) => {
          setIsPlaying(false);
          setIsBuffering(false);
          setPlaybackError(
            err instanceof Error ? err.message : 'Unable to resume audio playback.'
          );
        });
      }
    };

    audio.addEventListener('loadedmetadata', handleLoadedMetadata, { once: true });
    return () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
    };
  }, [job?.id, streamUrl]);

  // Draw crisp dual-layer waveform on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !job) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(300, Math.floor(rect.width));
    const height = Math.max(100, Math.floor(rect.height));

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // Subtle horizontal centerline
    const midY = height / 2;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();

    const primaryPeaks =
      effectiveVariant === 'cleaned' && job.cleanedPeaks.length > 0
        ? job.cleanedPeaks
        : job.originalPeaks;
    const ghostPeaks =
      effectiveVariant === 'cleaned' && job.originalPeaks.length > 0 ? job.originalPeaks : null;

    const count = primaryPeaks.length || 1;
    const barGap = 2;
    const barWidth = Math.max(1.5, (width - barGap * (count - 1)) / count);
    const progressRatio =
      job.durationSeconds > 0 ? Math.min(1, Math.max(0, currentTime / job.durationSeconds)) : 0;
    const playheadX = progressRatio * width;

    for (let i = 0; i < count; i++) {
      const x = i * (barWidth + barGap);
      const isPlayed = x <= playheadX;

      if (ghostPeaks && ghostPeaks[i] !== undefined) {
        const ghostH = Math.max(3, ghostPeaks[i] * (height * 0.84));
        ctx.fillStyle = 'rgba(148, 163, 184, 0.16)';
        ctx.fillRect(x, midY - ghostH / 2, barWidth, ghostH);
      }

      const amp = primaryPeaks[i] ?? 0.1;
      const barH = Math.max(4, amp * (height * 0.86));

      if (effectiveVariant === 'cleaned') {
        ctx.fillStyle = isPlayed ? '#3b82f6' : 'rgba(96, 165, 250, 0.45)';
      } else {
        ctx.fillStyle = isPlayed ? '#f59e0b' : 'rgba(251, 191, 36, 0.42)';
      }

      ctx.fillRect(x, midY - barH / 2, barWidth, barH);
    }

    // Playhead cursor
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(Math.max(0, Math.min(width - 2, playheadX)), 4, 2, height - 8);

    ctx.restore();
  }, [job, job?.originalPeaks, job?.cleanedPeaks, effectiveVariant, currentTime]);

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio || !job || !streamUrl) return;

    if (!audio.paused) {
      audio.pause();
      setIsPlaying(false);
      setIsBuffering(false);
      return;
    }

    setPlaybackError(null);
    setIsBuffering(true);

    // Recover immediately if stream had errored or was not loaded yet
    if (audio.error || audio.getAttribute('data-stream-url') !== streamUrl || !audio.src) {
      const resumeAt = currentTime;
      audio.setAttribute('data-stream-url', streamUrl);
      audio.setAttribute('data-job-id', job.id);
      audio.src = streamUrl;
      audio.load();
      if (resumeAt > 0) {
        audio.addEventListener(
          'loadedmetadata',
          () => {
            try {
              audio.currentTime = resumeAt;
            } catch {
              // ignore
            }
          },
          { once: true }
        );
      }
    }

    audio.volume = volume;
    audio.muted = isMuted;

    try {
      await audio.play();
      setIsPlaying(true);
      setIsBuffering(false);
    } catch (err) {
      setIsPlaying(false);
      setIsBuffering(false);
      const msg =
        err instanceof Error
          ? err.message
          : 'Browser blocked audio playback or stream failed to load.';
      setPlaybackError(msg);
    }
  };

  const skipSeconds = (delta: number) => {
    const audio = audioRef.current;
    if (!audio || !job) return;
    const maxDur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : job.durationSeconds;
    const next = Math.max(0, Math.min(maxDur, audio.currentTime + delta));
    audio.currentTime = next;
    setCurrentTime(next);
  };

  const seekFromClientX = (clientX: number) => {
    const canvas = canvasRef.current;
    const audio = audioRef.current;
    if (!canvas || !audio || !job || job.durationSeconds <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const maxDur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : job.durationSeconds;
    const targetTime = ratio * maxDur;
    try {
      audio.currentTime = targetTime;
    } catch {
      // Ignore if metadata not loaded yet
    }
    setCurrentTime(targetTime);
  };

  if (!job) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-8 text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
          <SlidersHorizontal className="h-5 w-5" />
        </div>
        <h3 className="mt-4 text-base font-semibold text-slate-900">
          Select a track to inspect waveform and A/B audio
        </h3>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-slate-500">
          Upload an audio or video file, paste a media link, or import from Google Drive above to
          preview before-and-after noise reduction and customize your WAV or MP3 export.
        </p>
      </section>
    );
  }

  const updateFormat = (format: ExportFormat) =>
    onExportSettingsChange({ ...exportSettings, format });
  const updateMp3Bitrate = (mp3Bitrate: Mp3Bitrate) =>
    onExportSettingsChange({ ...exportSettings, mp3Bitrate });
  const updateWavBitDepth = (wavBitDepth: WavBitDepth) =>
    onExportSettingsChange({ ...exportSettings, wavBitDepth });
  const updateSampleRate = (sampleRate: SampleRate) =>
    onExportSettingsChange({ ...exportSettings, sampleRate });
  const updateChannels = (channels: ChannelMode) =>
    onExportSettingsChange({ ...exportSettings, channels });

  return (
    <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950 text-slate-100">
      <audio
        ref={audioRef}
        preload="metadata"
        onTimeUpdate={(e) => {
          if (!isDragging) setCurrentTime(e.currentTarget.currentTime);
        }}
        onWaiting={() => setIsBuffering(true)}
        onCanPlay={() => setIsBuffering(false)}
        onPlaying={() => {
          setIsPlaying(true);
          setIsBuffering(false);
          setPlaybackError(null);
        }}
        onPause={() => {
          setIsPlaying(false);
          setIsBuffering(false);
        }}
        onEnded={() => {
          setIsPlaying(false);
          setIsBuffering(false);
        }}
        onError={(e) => {
          const mediaErr = e.currentTarget.error;
          setIsPlaying(false);
          setIsBuffering(false);
          if (mediaErr) {
            const detail =
              mediaErr.code === 2
                ? 'Network interrupted while loading audio stream.'
                : mediaErr.code === 3
                ? 'Audio decoding error in browser.'
                : mediaErr.code === 4
                ? 'Audio stream could not be loaded or format is unsupported.'
                : 'Audio playback error.';
            setPlaybackError(detail);
          }
        }}
      />

      {/* Deck Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800/80 px-6 py-4">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-white">{job.originalName}</h3>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="font-mono tabular-nums">{formatDuration(job.durationSeconds)}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">{formatBytes(job.fileSizeBytes)}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono uppercase">{job.inputCodec}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">{(job.inputSampleRate / 1000).toFixed(1)} kHz</span>
            {job.settingsUsed && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-slate-300">{job.settingsUsed.presetName}</span>
              </>
            )}
          </div>
        </div>

        {/* Instant A/B Switcher */}
        <div className="flex items-center gap-3 shrink-0">
          <div
            className="inline-flex items-center rounded-lg border border-slate-800 bg-slate-900 p-1"
            role="group"
            aria-label="Audio comparison toggle"
          >
            <button
              type="button"
              onClick={() => setVariant('original')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                effectiveVariant === 'original'
                  ? 'bg-amber-500 text-slate-950'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Original Audio
            </button>
            <button
              type="button"
              disabled={!isCleanedAvailable}
              onClick={() => setVariant('cleaned')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 disabled:cursor-not-allowed disabled:opacity-40 ${
                effectiveVariant === 'cleaned'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Cleaned Master
            </button>
          </div>

          {job.status === 'queued' || job.status === 'error' ? (
            <button
              type="button"
              onClick={() => onProcessJob(job)}
              className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-500 whitespace-nowrap shrink-0"
            >
              Clean &amp; Level Audio
            </button>
          ) : job.status === 'ready' ? (
            <button
              type="button"
              onClick={() => onProcessJob(job)}
              title="Re-run cleanup with your current sidebar settings"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-800 hover:text-white whitespace-nowrap shrink-0"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Re-clean
            </button>
          ) : (
            <div className="flex items-center gap-2 text-xs font-medium text-blue-400 whitespace-nowrap shrink-0">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="font-mono tabular-nums">{job.progress}%</span>
            </div>
          )}
        </div>
      </div>

      {/* Interactive Waveform Canvas */}
      <div className="px-6 pt-5 pb-4">
        <div className="relative h-28 w-full overflow-hidden rounded-lg border border-slate-800 bg-slate-900/70">
          <canvas
            ref={canvasRef}
            onMouseDown={(e) => {
              setIsDragging(true);
              seekFromClientX(e.clientX);
            }}
            onMouseMove={(e) => {
              if (isDragging) seekFromClientX(e.clientX);
            }}
            onMouseUp={() => setIsDragging(false)}
            onMouseLeave={() => setIsDragging(false)}
            onClick={(e) => seekFromClientX(e.clientX)}
            className="h-full w-full cursor-pointer"
          />
          {effectiveVariant === 'cleaned' && isCleanedAvailable && (
            <div className="pointer-events-none absolute top-2 right-3 text-[11px] font-medium text-slate-400">
              Blue: Cleaned Master · Dimmed: Original Signal
            </div>
          )}
        </div>

        {playbackError && (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-red-900/80 bg-red-950/60 px-3.5 py-2.5 text-xs text-red-200">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
              <span>{playbackError}</span>
            </div>
            <button
              type="button"
              onClick={() => void togglePlay()}
              className="rounded-md bg-red-900 px-2.5 py-1 font-medium text-white hover:bg-red-800 whitespace-nowrap shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        {/* Transport Controls, Volume & Timecode */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => skipSeconds(-15)}
              className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-800 bg-slate-900 text-slate-300 transition-colors hover:border-slate-700 hover:text-white"
              title="Back 15 seconds"
              aria-label="Back 15 seconds"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => void togglePlay()}
              className="flex h-10 items-center gap-2 rounded-lg bg-white px-5 text-sm font-semibold text-slate-950 transition-colors hover:bg-slate-200 whitespace-nowrap shrink-0"
            >
              {isBuffering ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : isPlaying ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              <span>{isBuffering ? 'Loading...' : isPlaying ? 'Pause' : 'Play'}</span>
            </button>
            <button
              type="button"
              onClick={() => skipSeconds(15)}
              className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-800 bg-slate-900 text-slate-300 transition-colors hover:border-slate-700 hover:text-white"
              title="Forward 15 seconds"
              aria-label="Forward 15 seconds"
            >
              <RotateCw className="h-4 w-4" />
            </button>

            {/* Volume & Mute */}
            <div className="ml-2 flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2">
              <button
                type="button"
                onClick={() => setIsMuted((m) => !m)}
                className="text-slate-300 transition-colors hover:text-white"
                aria-label={isMuted ? 'Unmute audio' : 'Mute audio'}
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted || volume === 0 ? (
                  <VolumeX className="h-4 w-4 text-amber-400" />
                ) : (
                  <Volume2 className="h-4 w-4" />
                )}
              </button>
              <input
                type="range"
                aria-label="Playback volume"
                min={0}
                max={1}
                step={0.05}
                value={isMuted ? 0 : volume}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setVolume(next);
                  if (next > 0 && isMuted) setIsMuted(false);
                }}
                className="w-20 accent-blue-500"
              />
            </div>
          </div>

          <div className="font-mono text-sm tabular-nums text-slate-300">
            <span className="text-white">{formatDuration(currentTime)}</span>
            <span className="mx-1.5 text-slate-600">/</span>
            <span>{formatDuration(job.durationSeconds)}</span>
          </div>
        </div>
      </div>

      {/* Measured Broadcast Telemetry */}
      <div className="grid grid-cols-2 divide-y divide-slate-800 border-t border-slate-800 bg-slate-900/40 sm:grid-cols-5 sm:divide-x sm:divide-y-0">
        <div className="px-5 py-3">
          <div className="text-xs text-slate-400">Input Loudness</div>
          <div className="mt-0.5 font-mono text-sm font-medium tabular-nums text-slate-200">
            {job.telemetry?.inputLufs !== null && job.telemetry?.inputLufs !== undefined
              ? `${job.telemetry.inputLufs} LUFS`
              : 'Pending'}
          </div>
        </div>
        <div className="px-5 py-3">
          <div className="text-xs text-slate-400">Master Loudness</div>
          <div className="mt-0.5 font-mono text-sm font-medium tabular-nums text-emerald-400">
            {job.telemetry?.outputLufs !== null && job.telemetry?.outputLufs !== undefined
              ? `${job.telemetry.outputLufs} LUFS`
              : 'Pending'}
          </div>
        </div>
        <div className="px-5 py-3">
          <div className="text-xs text-slate-400">True Peak Ceiling</div>
          <div className="mt-0.5 font-mono text-sm font-medium tabular-nums text-slate-200">
            {job.telemetry?.outputTruePeak !== null && job.telemetry?.outputTruePeak !== undefined
              ? `${job.telemetry.outputTruePeak} dBTP`
              : 'Pending'}
          </div>
        </div>
        <div className="px-5 py-3">
          <div className="text-xs text-slate-400">Noise Attenuation</div>
          <div className="mt-0.5 font-mono text-sm font-medium tabular-nums text-blue-400">
            {job.telemetry ? `-${job.telemetry.noiseReductionDb} dB` : 'Pending'}
          </div>
        </div>
        <div className="px-5 py-3">
          <div className="text-xs text-slate-400">Loudness Range</div>
          <div className="mt-0.5 font-mono text-sm font-medium tabular-nums text-slate-200">
            {job.telemetry?.outputLra !== null && job.telemetry?.outputLra !== undefined
              ? `${job.telemetry.outputLra} LU`
              : 'Pending'}
          </div>
        </div>
      </div>

      {/* Customizable Export & Cloud Sync Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-800 bg-slate-900/80 px-6 py-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* Format */}
          <div className="inline-flex rounded-lg border border-slate-700 bg-slate-950 p-0.5">
            {(['wav', 'mp3'] as ExportFormat[]).map((fmt) => (
              <button
                key={fmt}
                type="button"
                onClick={() => updateFormat(fmt)}
                className={`rounded-md px-3 py-1.5 font-mono text-xs font-semibold uppercase transition-colors whitespace-nowrap shrink-0 ${
                  exportSettings.format === fmt
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {fmt}
              </button>
            ))}
          </div>

          {/* Bitrate or Bit Depth */}
          {exportSettings.format === 'mp3' ? (
            <select
              aria-label="MP3 Bitrate"
              value={exportSettings.mp3Bitrate}
              onChange={(e) => updateMp3Bitrate(Number(e.target.value) as Mp3Bitrate)}
              className="h-9 rounded-lg border border-slate-700 bg-slate-950 px-3 font-mono text-xs text-slate-200 focus-visible:outline-2 focus-visible:outline-blue-500"
            >
              <option value={128}>128 kbps CBR</option>
              <option value={192}>192 kbps CBR</option>
              <option value={256}>256 kbps CBR</option>
              <option value={320}>320 kbps CBR</option>
            </select>
          ) : (
            <select
              aria-label="WAV Bit Depth"
              value={exportSettings.wavBitDepth}
              onChange={(e) => updateWavBitDepth(Number(e.target.value) as WavBitDepth)}
              className="h-9 rounded-lg border border-slate-700 bg-slate-950 px-3 font-mono text-xs text-slate-200 focus-visible:outline-2 focus-visible:outline-blue-500"
            >
              <option value={16}>16-bit PCM</option>
              <option value={24}>24-bit PCM</option>
              <option value={32}>32-bit Float</option>
            </select>
          )}

          {/* Sample Rate */}
          <select
            aria-label="Sample Rate"
            value={exportSettings.sampleRate}
            onChange={(e) => updateSampleRate(Number(e.target.value) as SampleRate)}
            className="h-9 rounded-lg border border-slate-700 bg-slate-950 px-3 font-mono text-xs text-slate-200 focus-visible:outline-2 focus-visible:outline-blue-500"
          >
            <option value={44100}>44.1 kHz</option>
            <option value={48000}>48.0 kHz</option>
          </select>

          {/* Channels */}
          <select
            aria-label="Audio Channels"
            value={exportSettings.channels}
            onChange={(e) => updateChannels(e.target.value as ChannelMode)}
            className="h-9 rounded-lg border border-slate-700 bg-slate-950 px-3 text-xs text-slate-200 focus-visible:outline-2 focus-visible:outline-blue-500"
          >
            <option value="original">Original Channels</option>
            <option value="stereo">Stereo</option>
            <option value="mono">Mono (Spoken)</option>
          </select>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            disabled={job.status !== 'ready' || isSyncing}
            onClick={() => void onSyncToDrive(job, exportSettings)}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-4 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45 whitespace-nowrap shrink-0"
            title={
              isGoogleConnected
                ? 'Save this rendered master to your Google Drive sync folder'
                : 'Sign in with Google to sync across devices'
            }
          >
            {isSyncing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : job.syncedDriveFileId ? (
              <Check className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <CloudUpload className="h-3.5 w-3.5" />
            )}
            <span>{job.syncedDriveFileId ? 'Synced to Drive' : 'Sync to Drive'}</span>
          </button>

          <button
            type="button"
            disabled={job.status !== 'ready'}
            onClick={() => onDownload(job, exportSettings)}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-45 whitespace-nowrap shrink-0"
          >
            <Download className="h-3.5 w-3.5" />
            <span>
              Download {exportSettings.format.toUpperCase()}
            </span>
          </button>
        </div>
      </div>

      {/* AI Voice Listener Diagnosis & Matched-Voice Clarity Layer */}
      <AiVoiceClarityPanel
        job={job}
        currentPlayheadSec={currentTime}
        onJobUpdated={onJobUpdated}
      />
    </section>
  );
}
