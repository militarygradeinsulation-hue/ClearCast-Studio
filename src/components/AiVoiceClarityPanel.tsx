import { useEffect, useRef, useState } from 'react';
import {
  Sparkles,
  Ear,
  Play,
  Pause,
  Check,
  Loader2,
  Sliders,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  AudioWaveform,
} from 'lucide-react';
import type {
  AiSpeakerProfile,
  AiUtterance,
  AiVoiceBlendMode,
  AudioJob,
  GeminiVoiceName,
} from '../types/audio';
import { formatDuration } from '../lib/formatters';

interface AiVoiceClarityPanelProps {
  job: AudioJob;
  currentPlayheadSec: number;
  onJobUpdated: (updatedJob: AudioJob) => void;
}

const VOICE_OPTIONS: { value: GeminiVoiceName; label: string }[] = [
  { value: 'Charon', label: 'Charon — Deep Warm Male' },
  { value: 'Fenrir', label: 'Fenrir — Resonant Clear Male' },
  { value: 'Puck', label: 'Puck — Lighter Mid Male' },
  { value: 'Kore', label: 'Kore — Warm Clear Female' },
  { value: 'Zephyr', label: 'Zephyr — Bright Airy Female' },
];

const BLEND_MODES: { value: AiVoiceBlendMode; label: string; hint: string }[] = [
  {
    value: 'clarity-blend',
    label: 'Subtle Clarity Layer',
    hint: 'Blends crisp consonants & word articulation over your real voice',
  },
  {
    value: 'balanced-hybrid',
    label: 'Balanced Hybrid',
    hint: 'Stronger matched-voice support for heavily muffled recordings',
  },
  {
    value: 'full-revoice',
    label: 'Full Studio Re-Voice',
    hint: 'Replaces the passage with the 100% matched studio AI voice',
  },
];

export function AiVoiceClarityPanel({
  job,
  currentPlayheadSec,
  onJobUpdated,
}: AiVoiceClarityPanelProps) {
  const isShortFile = job.durationSeconds <= 60;
  const [isOpen, setIsOpen] = useState(true);
  const [startSec, setStartSec] = useState<number>(0);
  const [windowSec, setWindowSec] = useState<number>(isShortFile ? Math.max(4, Math.ceil(job.durationSeconds)) : 25);

  const [speakers, setSpeakers] = useState<AiSpeakerProfile[]>(job.aiVoiceClip?.speakers ?? []);
  const [utterances, setUtterances] = useState<AiUtterance[]>(job.aiVoiceClip?.utterances ?? []);
  const [blendMode, setBlendMode] = useState<AiVoiceBlendMode>(
    job.aiVoiceClip?.blendMode ?? 'clarity-blend'
  );
  const [blendAmount, setBlendAmount] = useState<number>(job.aiVoiceClip?.blendAmount ?? 30);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [isRemixing, setIsRemixing] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);

  // Inline A/B/C audition audio player
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [previewLayer, setPreviewLayer] = useState<'base' | 'mix' | 'voice'>('mix');
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);

  // Sync local form state when switching selected job or receiving updated clip
  useEffect(() => {
    const short = job.durationSeconds <= 60;
    if (job.aiVoiceClip) {
      setStartSec(job.aiVoiceClip.startSec);
      setWindowSec(Math.round(job.aiVoiceClip.durationSec));
      setSpeakers(job.aiVoiceClip.speakers);
      setUtterances(job.aiVoiceClip.utterances);
      setBlendMode(job.aiVoiceClip.blendMode);
      setBlendAmount(job.aiVoiceClip.blendAmount);
    } else {
      setStartSec(0);
      setWindowSec(short ? Math.max(4, Math.ceil(job.durationSeconds)) : 25);
      setSpeakers([]);
      setUtterances([]);
      setBlendMode('clarity-blend');
      setBlendAmount(30);
    }
    setErrorMsg(null);
    setStatusNote(null);
    setIsPreviewPlaying(false);
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
    }
  }, [job.id, job.aiVoiceClip?.id]);

  const clip = job.aiVoiceClip;
  const blendDirty =
    Boolean(clip?.hasSynthesizedVoice) &&
    (blendMode !== clip?.blendMode || blendAmount !== clip?.blendAmount);

  const handleAnalyzeSegment = async () => {
    setErrorMsg(null);
    setStatusNote(null);
    setIsAnalyzing(true);
    try {
      const effectiveStart = isShortFile ? 0 : startSec;
      const effectiveDuration = isShortFile ? job.durationSeconds : windowSec;
      const res = await fetch(`/api/jobs/${job.id}/ai-voice/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startSec: effectiveStart,
          durationSec: effectiveDuration,
        }),
      });
      const data = (await res.json()) as { job?: AudioJob; error?: string };
      if (!res.ok || !data.job) {
        throw new Error(data.error || 'AI voice listening failed.');
      }
      onJobUpdated(data.job);
      if (data.job.aiVoiceClip) {
        setSpeakers(data.job.aiVoiceClip.speakers);
        setUtterances(data.job.aiVoiceClip.utterances);
        setBlendMode(data.job.aiVoiceClip.blendMode);
        setBlendAmount(data.job.aiVoiceClip.blendAmount);
      }
      setStatusNote('AI listened to the passage and matched the speaker voice profile. Review wording below and generate the clarity layer.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'AI voice listening failed.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleSynthesizeLayer = async () => {
    setErrorMsg(null);
    setStatusNote(null);
    setIsSynthesizing(true);
    try {
      const res = await fetch(`/api/jobs/${job.id}/ai-voice/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          speakers,
          utterances,
          blendMode,
          blendAmount,
        }),
      });
      const data = (await res.json()) as { job?: AudioJob; error?: string };
      if (!res.ok || !data.job) {
        throw new Error(data.error || 'Failed to synthesize matched clarity voice.');
      }
      onJobUpdated(data.job);
      setPreviewLayer('mix');
      setStatusNote('Matched AI voice layer generated and aligned. Audition the mix below or adjust blend strength.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to generate matched clarity voice.');
    } finally {
      setIsSynthesizing(false);
    }
  };

  const handleRemixLayer = async () => {
    setErrorMsg(null);
    setStatusNote(null);
    setIsRemixing(true);
    try {
      const res = await fetch(`/api/jobs/${job.id}/ai-voice/remix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blendMode, blendAmount }),
      });
      const data = (await res.json()) as { job?: AudioJob; error?: string };
      if (!res.ok || !data.job) {
        throw new Error(data.error || 'Failed to update AI voice mix.');
      }
      onJobUpdated(data.job);
      setStatusNote('Updated AI voice clarity blend.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to remix AI voice layer.');
    } finally {
      setIsRemixing(false);
    }
  };

  const handleApplyToMaster = async () => {
    setErrorMsg(null);
    setStatusNote(null);
    setIsApplying(true);
    try {
      const res = await fetch(`/api/jobs/${job.id}/ai-voice/apply`, {
        method: 'POST',
      });
      const data = (await res.json()) as { job?: AudioJob; error?: string };
      if (!res.ok || !data.job) {
        throw new Error(data.error || 'Failed to apply enhanced passage to master.');
      }
      onJobUpdated(data.job);
      setStatusNote('Applied AI-clarified passage directly into your Cleaned Master and exports.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to apply enhanced passage.');
    } finally {
      setIsApplying(false);
    }
  };

  const playPreviewLayer = (layer: 'base' | 'mix' | 'voice') => {
    const audio = previewAudioRef.current;
    if (!audio || !clip) return;

    const url = `/api/jobs/${job.id}/ai-voice/stream?layer=${layer}&v=${encodeURIComponent(clip.updatedAt)}`;
    const isSameLayer = previewLayer === layer && audio.getAttribute('data-preview-url') === url;

    if (isSameLayer && !audio.paused) {
      audio.pause();
      setIsPreviewPlaying(false);
      return;
    }

    setPreviewLayer(layer);
    if (audio.getAttribute('data-preview-url') !== url) {
      audio.setAttribute('data-preview-url', url);
      audio.src = url;
      audio.load();
    }
    void audio
      .play()
      .then(() => setIsPreviewPlaying(true))
      .catch((err) => {
        setIsPreviewPlaying(false);
        setErrorMsg(err instanceof Error ? err.message : 'Could not start preview audio.');
      });
  };

  const profile = job.aiVoiceProfile;

  return (
    <div className="border-t border-slate-800 bg-slate-950/90">
      {/* Whole-Track AI Voice Listener Diagnosis (when available) */}
      {profile && (
        <div className="border-b border-slate-800/80 px-6 py-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-blue-400">
                <Ear className="h-3.5 w-3.5" />
                AI Voice Listener Profile
              </div>
              <p className="text-xs leading-relaxed text-slate-300">{profile.summary}</p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-[11px] text-slate-400 font-mono tabular-nums">
                {profile.speakers.map((sp, i) => (
                  <span key={`${sp.label}-${i}`} className="text-slate-300">
                    {sp.label}: {sp.genderRegister} (Match: {sp.matchedVoice})
                  </span>
                ))}
                <span>
                  Mud {profile.dspTuning.mudCutDb} dB @ {profile.dspTuning.mudCutHz} Hz
                </span>
                <span>
                  Presence +{profile.dspTuning.presenceGainDb} dB @ {(profile.dspTuning.presenceHz / 1000).toFixed(1)} kHz
                </span>
                <span>
                  Consonants +{profile.dspTuning.consonantGainDb} dB @ {(profile.dspTuning.consonantHz / 1000).toFixed(1)} kHz
                </span>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3 shrink-0 text-right font-mono tabular-nums">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500">Muffling</div>
                <div className="text-xs font-semibold text-amber-400">{profile.acoustics.mufflingScore}%</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500">Noise</div>
                <div className="text-xs font-semibold text-slate-200">{profile.acoustics.noiseScore}%</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500">Diction Loss</div>
                <div className="text-xs font-semibold text-blue-400">{profile.acoustics.consonantLossScore}%</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {job.aiVoiceProfileError && !profile && (
        <div className="border-b border-slate-800/80 px-6 py-3 flex items-center gap-2 text-xs text-amber-300 bg-amber-950/20">
          <AlertCircle className="h-4 w-4 shrink-0 text-amber-400" />
          <span>AI Voice Listener note: {job.aiVoiceProfileError}</span>
        </div>
      )}

      {/* AI Matched-Voice Clarity Layer Studio */}
      <div className="px-6 py-4">
        <button
          type="button"
          onClick={() => setIsOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-4 text-left"
        >
          <div className="flex items-center gap-2.5">
            <Sparkles className="h-4 w-4 text-blue-400 shrink-0" />
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-white">
                AI Matched-Voice Clarity Layer
              </div>
              <p className="text-xs text-slate-400">
                Listens to the voice, matches the speaker tone, and gently layers clear articulation so muffled words are easy to hear.
              </p>
            </div>
          </div>
          {isOpen ? (
            <ChevronUp className="h-4 w-4 text-slate-400 shrink-0" />
          ) : (
            <ChevronDown className="h-4 w-4 text-slate-400 shrink-0" />
          )}
        </button>

        {isOpen && (
          <div className="mt-4 space-y-4">
            {/* Step 1: Passage Selector & Listen Trigger */}
            <div className="flex flex-wrap items-end justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/70 p-3.5">
              <div className="flex flex-wrap items-end gap-3">
                {!isShortFile ? (
                  <>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-400 mb-1">
                        Passage Start
                      </label>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          min={0}
                          max={Math.max(0, Math.floor(job.durationSeconds - 4))}
                          step={1}
                          value={Math.floor(startSec)}
                          onChange={(e) =>
                            setStartSec(
                              Math.max(0, Math.min(job.durationSeconds - 4, Number(e.target.value) || 0))
                            )
                          }
                          className="w-20 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs font-mono tabular-nums text-white focus:border-blue-500 focus:outline-none"
                        />
                        <span className="text-[11px] font-mono text-slate-400">
                          ({formatDuration(startSec)})
                        </span>
                        <button
                          type="button"
                          onClick={() => setStartSec(Math.floor(currentPlayheadSec))}
                          className="rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-[11px] font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap shrink-0"
                        >
                          Use Playhead ({formatDuration(currentPlayheadSec)})
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-400 mb-1">
                        Window Length
                      </label>
                      <div className="inline-flex rounded-md border border-slate-700 bg-slate-950 p-0.5">
                        {[15, 25, 45].map((sec) => (
                          <button
                            key={sec}
                            type="button"
                            onClick={() => setWindowSec(Math.min(sec, Math.floor(job.durationSeconds)))}
                            className={`rounded px-2.5 py-1 text-[11px] font-mono transition-colors ${
                              windowSec === sec
                                ? 'bg-blue-600 text-white'
                                : 'text-slate-400 hover:text-white'
                            }`}
                          >
                            {sec}s
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-slate-300">
                    Full track selected ({formatDuration(job.durationSeconds)}) — ready for AI listening and matched-voice enhancement.
                  </div>
                )}
              </div>

              <button
                type="button"
                disabled={isAnalyzing}
                onClick={handleAnalyzeSegment}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                {isAnalyzing ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Listening to Voice...
                  </>
                ) : (
                  <>
                    <Ear className="h-3.5 w-3.5" />
                    {clip ? 'Re-Listen Passage' : 'Listen & Match Voice'}
                  </>
                )}
              </button>
            </div>

            {errorMsg && (
              <div className="flex items-start gap-2 rounded-lg border border-red-900/70 bg-red-950/50 px-3.5 py-2.5 text-xs text-red-200">
                <AlertCircle className="h-4 w-4 shrink-0 text-red-400 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}

            {statusNote && !errorMsg && (
              <div className="flex items-center gap-2 rounded-lg border border-blue-900/60 bg-blue-950/30 px-3.5 py-2 text-xs text-blue-200">
                <Check className="h-3.5 w-3.5 shrink-0 text-blue-400" />
                <span>{statusNote}</span>
              </div>
            )}

            {/* Step 2: Matched Speaker Profile, Heard Wording & Blend Controls */}
            {clip && (
              <div className="space-y-4 rounded-lg border border-slate-800 bg-slate-900/50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
                  <div className="text-xs text-slate-300">
                    <span className="font-semibold text-white">Heard Passage:</span>{' '}
                    <span className="font-mono tabular-nums text-blue-400">
                      {formatDuration(clip.startSec)} – {formatDuration(clip.startSec + clip.durationSec)}
                    </span>
                    <span className="mx-2 text-slate-600">·</span>
                    <span>{clip.detectedLanguage}</span>
                  </div>
                  <div className="text-[11px] text-slate-400">{clip.muffledWordsNote}</div>
                </div>

                {/* Matched Speaker Voice Personas */}
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {speakers.map((sp, idx) => (
                    <div
                      key={`${sp.label}-${idx}`}
                      className="rounded-md border border-slate-800 bg-slate-950/80 p-3 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-white">{sp.label}</span>
                        <span className="text-[11px] text-slate-400">{sp.genderRegister}</span>
                      </div>
                      <select
                        value={sp.matchedVoice}
                        onChange={(e) => {
                          const next = [...speakers];
                          next[idx] = { ...sp, matchedVoice: e.target.value as GeminiVoiceName };
                          setSpeakers(next);
                        }}
                        className="w-full rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200 focus:border-blue-500 focus:outline-none"
                      >
                        {VOICE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={sp.stylePrompt}
                        onChange={(e) => {
                          const next = [...speakers];
                          next[idx] = { ...sp, stylePrompt: e.target.value };
                          setSpeakers(next);
                        }}
                        placeholder="Voice tone & pacing description"
                        className="w-full rounded-md border border-slate-800 bg-slate-900/80 px-2.5 py-1.5 text-[11px] text-slate-300 focus:border-blue-500 focus:outline-none"
                      />
                    </div>
                  ))}
                </div>

                {/* Editable Spoken Wording */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-slate-300">
                      Detected Wording (edit any muffled words before generating)
                    </label>
                    <span className="text-[11px] text-slate-500 font-mono">
                      {utterances.length} {utterances.length === 1 ? 'line' : 'lines'}
                    </span>
                  </div>
                  <div className="max-h-40 space-y-2 overflow-y-auto pr-1">
                    {utterances.map((u, idx) => (
                      <div key={idx} className="flex items-start gap-2">
                        {speakers.length > 1 && (
                          <span className="mt-1.5 w-20 shrink-0 truncate text-[11px] font-medium text-blue-400">
                            {u.speaker}
                          </span>
                        )}
                        <textarea
                          rows={2}
                          value={u.clarifiedText}
                          onChange={(e) => {
                            const next = [...utterances];
                            next[idx] = { ...u, clarifiedText: e.target.value };
                            setUtterances(next);
                          }}
                          className="w-full rounded-md border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-xs leading-relaxed text-slate-200 focus:border-blue-500 focus:outline-none"
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {/* Blend Mode & Strength */}
                <div className="grid grid-cols-1 gap-3 border-t border-slate-800 pt-3 md:grid-cols-12 md:items-center">
                  <div className="md:col-span-7 space-y-1.5">
                    <div className="text-[11px] font-medium text-slate-400">Enhancement Blend Mode</div>
                    <div className="grid grid-cols-3 gap-1.5">
                      {BLEND_MODES.map((m) => (
                        <button
                          key={m.value}
                          type="button"
                          onClick={() => setBlendMode(m.value)}
                          title={m.hint}
                          className={`rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors whitespace-nowrap ${
                            blendMode === m.value
                              ? 'border-blue-500 bg-blue-600/20 text-blue-200'
                              : 'border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="md:col-span-5 space-y-1.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-medium text-slate-400">Added Voice Blend</span>
                      <span className="font-mono tabular-nums text-blue-400">
                        {blendMode === 'full-revoice' ? '100%' : `${blendAmount}%`}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={10}
                      max={90}
                      step={2}
                      disabled={blendMode === 'full-revoice'}
                      value={blendMode === 'full-revoice' ? 90 : blendAmount}
                      onChange={(e) => setBlendAmount(Number(e.target.value))}
                      className="h-1.5 w-full cursor-pointer accent-blue-500 disabled:opacity-40"
                    />
                    <div className="text-[10px] text-slate-500">
                      {BLEND_MODES.find((m) => m.value === blendMode)?.hint}
                    </div>
                  </div>
                </div>

                {/* Action Bar: Generate / Remix / Audition / Apply */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={isSynthesizing}
                      onClick={handleSynthesizeLayer}
                      className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50 whitespace-nowrap shrink-0"
                    >
                      {isSynthesizing ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Generating Matched Voice...
                        </>
                      ) : (
                        <>
                          <AudioWaveform className="h-3.5 w-3.5" />
                          {clip.hasSynthesizedVoice ? 'Regenerate Voice Layer' : 'Generate Matched Voice Layer'}
                        </>
                      )}
                    </button>

                    {blendDirty && (
                      <button
                        type="button"
                        disabled={isRemixing}
                        onClick={handleRemixLayer}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50 whitespace-nowrap shrink-0"
                      >
                        {isRemixing ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Sliders className="h-3.5 w-3.5" />
                        )}
                        Update Blend
                      </button>
                    )}
                  </div>

                  {/* A/B/C Audition & Apply */}
                  {clip.hasSynthesizedVoice && (
                    <div className="flex flex-wrap items-center gap-2">
                      <audio
                        ref={previewAudioRef}
                        preload="none"
                        onEnded={() => setIsPreviewPlaying(false)}
                        onPause={() => setIsPreviewPlaying(false)}
                        onPlay={() => setIsPreviewPlaying(true)}
                      />

                      <div className="inline-flex items-center rounded-lg border border-slate-800 bg-slate-950 p-0.5">
                        {(
                          [
                            { id: 'base', label: 'Before' },
                            { id: 'mix', label: 'AI Clarity Mix' },
                            { id: 'voice', label: 'AI Voice Only' },
                          ] as const
                        ).map((opt) => {
                          const active = previewLayer === opt.id && isPreviewPlaying;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() => playPreviewLayer(opt.id)}
                              className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors whitespace-nowrap ${
                                active
                                  ? 'bg-blue-600 text-white'
                                  : 'text-slate-300 hover:text-white'
                              }`}
                            >
                              {active ? (
                                <Pause className="h-3 w-3" />
                              ) : (
                                <Play className="h-3 w-3" />
                              )}
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>

                      <button
                        type="button"
                        disabled={isApplying || job.status !== 'ready'}
                        onClick={handleApplyToMaster}
                        title={
                          job.status !== 'ready'
                            ? 'Run Clean & Level Audio on the full track first'
                            : 'Splice this AI-enhanced passage into your Cleaned Master and exports'
                        }
                        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-45 whitespace-nowrap shrink-0"
                      >
                        {isApplying ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Applying...
                          </>
                        ) : clip.appliedToMaster ? (
                          <>
                            <Check className="h-3.5 w-3.5" />
                            Applied to Master
                          </>
                        ) : (
                          <>
                            <Check className="h-3.5 w-3.5" />
                            Apply to Master
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
