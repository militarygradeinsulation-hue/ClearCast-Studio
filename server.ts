import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  listenAndProfileVoice,
  listenAndTranscribeSegment,
  synthesizeMatchedVoiceLayer,
  type AiDspTuning,
  type AiSpeakerProfile,
  type AiUtterance,
  type AiVoiceProfile,
} from './src/server/geminiAudio.ts';

const PORT = 3000;
const MAX_DURATION_SECONDS = 4500; // 75 minutes hard limit
const MAX_UPLOAD_BYTES = 3.5 * 1024 * 1024 * 1024; // 3.5 GB (exact integer) for 75m video/WAV
const WORK_DIR = path.resolve('/tmp/clearcast-studio');
const UPLOAD_DIR = path.join(WORK_DIR, 'uploads');
const JOBS_DIR = path.join(WORK_DIR, 'jobs');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(JOBS_DIR, { recursive: true });

const MODELS_DIR = path.resolve(process.cwd(), 'models');
const RNNOISE_SH_MODEL = path.join(MODELS_DIR, 'rnnoise_sh.rnnn');
const RNNOISE_CB_MODEL = path.join(MODELS_DIR, 'rnnoise_cb.rnnn');

type AiVoiceBlendMode = 'clarity-blend' | 'balanced-hybrid' | 'full-revoice';

interface ProcessingSettings {
  presetId: string;
  presetName: string;
  noiseReduction: number;
  voiceClarity: number;
  voicePresenceLayer: number;
  leveling: number;
  targetLufs: number;
  highPassHz: number;
  neuralDenoise: boolean;
  aiVoiceListener: boolean;
  deEsser: boolean;
  deClick: boolean;
}

interface ExportOptions {
  format: 'wav' | 'mp3';
  mp3Bitrate: 128 | 192 | 256 | 320;
  wavBitDepth: 16 | 24 | 32;
  sampleRate: 44100 | 48000;
  channels: 'original' | 'stereo' | 'mono';
}

interface AudioTelemetry {
  inputLufs: number | null;
  outputLufs: number | null;
  inputTruePeak: number | null;
  outputTruePeak: number | null;
  inputLra: number | null;
  outputLra: number | null;
  noiseReductionDb: number;
}

interface AiVoiceClip {
  id: string;
  startSec: number;
  durationSec: number;
  detectedLanguage: string;
  speakerCount: number;
  speakers: AiSpeakerProfile[];
  utterances: AiUtterance[];
  muffledWordsNote: string;
  blendMode: AiVoiceBlendMode;
  blendAmount: number;
  hasSynthesizedVoice: boolean;
  appliedToMaster: boolean;
  updatedAt: string;
}

interface InternalJob {
  id: string;
  originalName: string;
  source: 'upload' | 'drive' | 'url';
  sourceDetail?: string;
  mimeType: string;
  fileSizeBytes: number;
  durationSeconds: number;
  inputCodec: string;
  inputSampleRate: number;
  inputChannels: number;
  hasVideo: boolean;
  status: 'queued' | 'analyzing' | 'cleaning' | 'normalizing' | 'ready' | 'error';
  progress: number;
  stageLabel: string;
  errorMessage?: string;
  createdAt: string;
  processedAt?: string;
  settingsUsed?: ProcessingSettings;
  telemetry?: AudioTelemetry;
  aiVoiceProfile?: AiVoiceProfile;
  aiVoiceProfileError?: string;
  aiVoiceClip?: AiVoiceClip;
  originalPeaks: number[];
  cleanedPeaks: number[];
  syncedDriveFileId?: string;
  syncedAt?: string;
  // Server-only file paths
  inputFilePath: string;
  jobDir: string;
  originalPreviewPath?: string;
  cleanedMasterPath?: string;
  cleanedPreviewPath?: string;
}

const jobs = new Map<string, InternalJob>();
const previewBuildLocks = new Map<string, Promise<string>>();
const MAX_STREAM_CHUNK = 2 * 1024 * 1024; // 2 MB max Range slice (prevents Cloud Run 32 MB proxy cutoff & speeds seeking)

function persistJob(job: InternalJob): void {
  try {
    if (!fs.existsSync(job.jobDir)) return;
    fs.writeFileSync(path.join(job.jobDir, 'job.json'), JSON.stringify(job, null, 2), 'utf8');
  } catch {
    // Non-fatal persistence error
  }
}

function getDirectPlayableAudioMime(job: InternalJob): string | null {
  if (job.hasVideo) return null;
  const ext = path.extname(job.inputFilePath).toLowerCase();
  const codec = (job.inputCodec || '').toLowerCase();
  if ((ext === '.mp3' || codec === 'mp3') && !job.hasVideo) return 'audio/mpeg';
  if ((ext === '.m4a' || ext === '.mp4') && (codec === 'aac' || codec === 'mp3')) return 'audio/mp4';
  if (ext === '.aac' && codec === 'aac') return 'audio/aac';
  if (ext === '.wav' && codec.startsWith('pcm_')) return 'audio/wav';
  if (ext === '.ogg' && (codec === 'vorbis' || codec === 'opus')) return 'audio/ogg';
  if (ext === '.webm' && (codec === 'opus' || codec === 'vorbis')) return 'audio/webm';
  if (ext === '.flac' && codec === 'flac') return 'audio/flac';
  return null;
}

async function ensureOriginalPreview(job: InternalJob): Promise<{ filePath: string; contentType: string }> {
  const directMime = getDirectPlayableAudioMime(job);
  if (directMime && fs.existsSync(job.inputFilePath)) {
    return { filePath: job.inputFilePath, contentType: directMime };
  }

  const origPreviewPath = path.join(job.jobDir, 'original_preview.mp3');
  if (job.originalPreviewPath && fs.existsSync(job.originalPreviewPath)) {
    return { filePath: job.originalPreviewPath, contentType: 'audio/mpeg' };
  }
  if (fs.existsSync(origPreviewPath) && !previewBuildLocks.has(job.id)) {
    job.originalPreviewPath = origPreviewPath;
    return { filePath: origPreviewPath, contentType: 'audio/mpeg' };
  }

  let lock = previewBuildLocks.get(job.id);
  if (!lock) {
    const tmpPath = path.join(job.jobDir, `original_preview_${Date.now()}.tmp.mp3`);
    lock = runFfmpegSimple([
      '-y',
      '-v',
      'error',
      '-i',
      job.inputFilePath,
      '-vn',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      '-ar',
      '44100',
      tmpPath,
    ])
      .then(() => {
        fs.renameSync(tmpPath, origPreviewPath);
        job.originalPreviewPath = origPreviewPath;
        persistJob(job);
        return origPreviewPath;
      })
      .catch((err) => {
        fs.rmSync(tmpPath, { force: true });
        throw err;
      })
      .finally(() => {
        previewBuildLocks.delete(job.id);
      });
    previewBuildLocks.set(job.id, lock);
  }

  const builtPath = await lock;
  return { filePath: builtPath, contentType: 'audio/mpeg' };
}

function serializeJob(job: InternalJob) {
  const {
    inputFilePath: _in,
    jobDir: _dir,
    originalPreviewPath: _origPrev,
    cleanedMasterPath: _cleanMaster,
    cleanedPreviewPath: _cleanPrev,
    ...publicFields
  } = job;
  return publicFields;
}

function sanitizeBaseName(name: string): string {
  const parsed = path.parse(name);
  const safe = parsed.name.replace(/[^a-zA-Z0-9._ -]/g, '_').trim();
  return safe || 'audio_track';
}

interface ProbeResult {
  durationSeconds: number;
  hasAudio: boolean;
  hasVideo: boolean;
  codec: string;
  sampleRate: number;
  channels: number;
}

function probeMediaFile(filePath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ];
    const proc = spawn('ffprobe', args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(stderr.trim() || 'Could not inspect media file with ffprobe.'));
      }
      try {
        const data = JSON.parse(stdout);
        const streams: Array<Record<string, unknown>> = Array.isArray(data.streams) ? data.streams : [];
        const audioStream = streams.find((s) => s.codec_type === 'audio');
        const videoStream = streams.find((s) => s.codec_type === 'video');
        const rawDuration =
          Number(data.format?.duration) ||
          Number(audioStream?.duration) ||
          Number(videoStream?.duration) ||
          0;
        resolve({
          durationSeconds: Number.isFinite(rawDuration) ? rawDuration : 0,
          hasAudio: Boolean(audioStream),
          hasVideo: Boolean(videoStream),
          codec: String(audioStream?.codec_name || 'unknown'),
          sampleRate: Number(audioStream?.sample_rate) || 48000,
          channels: Number(audioStream?.channels) || 2,
        });
      } catch (e) {
        reject(new Error('Failed to parse media stream metadata.'));
      }
    });
  });
}

function extractWaveformPeaks(filePath: string, durationSeconds: number, bins = 220): Promise<number[]> {
  return new Promise((resolve) => {
    // Decode at 4000 Hz mono (2 kHz Nyquist preserves full human voice spectrum) and stream directly into peak bins
    const sampleRate = 4000;
    const expectedSamples = Math.max(bins, Math.round(Math.max(1, durationSeconds) * sampleRate));
    const samplesPerBin = Math.max(1, Math.floor(expectedSamples / bins));
    const binPeaks = new Float32Array(bins);
    let sampleIndex = 0;
    let leftoverByte: number | null = null;

    const args = ['-v', 'error', '-i', filePath, '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', 'pipe:1'];
    const proc = spawn('ffmpeg', args);

    proc.stdout.on('data', (chunk: Buffer) => {
      let buf = chunk;
      if (leftoverByte !== null) {
        buf = Buffer.concat([Buffer.from([leftoverByte]), chunk]);
        leftoverByte = null;
      }
      const usableLen = buf.length - (buf.length % 2);
      if (usableLen < buf.length) {
        leftoverByte = buf[buf.length - 1];
      }

      for (let offset = 0; offset < usableLen; offset += 2) {
        const val = Math.abs(buf.readInt16LE(offset)) / 32768;
        const binIdx = Math.min(bins - 1, Math.floor(sampleIndex / samplesPerBin));
        if (val > binPeaks[binIdx]) {
          binPeaks[binIdx] = val;
        }
        sampleIndex++;
      }
    });

    proc.on('close', (code) => {
      if (code !== 0 || sampleIndex === 0) {
        return resolve(Array.from({ length: bins }, () => 0.15));
      }
      let maxPeak = 0.001;
      for (let i = 0; i < bins; i++) {
        if (binPeaks[i] > maxPeak) maxPeak = binPeaks[i];
      }
      const normBase = Math.max(maxPeak, 0.15);
      const normalized = Array.from(binPeaks, (p) => {
        const scaled = Math.pow(Math.min(1, p / normBase), 0.72);
        return Number(Math.max(0.05, Math.min(1, scaled)).toFixed(3));
      });
      resolve(normalized);
    });

    proc.on('error', () => {
      resolve(Array.from({ length: bins }, () => 0.15));
    });
  });
}

function runFfmpegSimple(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.slice(-600) || `ffmpeg exited with code ${code}`));
      } else {
        resolve(stderr);
      }
    });
  });
}

// Compatibility path for hosts that lack RNNoise or optional audio effects.
// Always keep denoising, speech EQ, compression and measured loudness normalization.
function buildCompatibleFilterChain(settings: ProcessingSettings): string {
  const strength = Math.max(0, Math.min(100, settings.noiseReduction));
  const clarity = Math.max(0, Math.min(100, settings.voiceClarity)) / 100;
  const level = Math.max(0, Math.min(100, settings.leveling)) / 100;
  const targetLufs = [-14, -16, -19, -23].includes(settings.targetLufs) ? settings.targetLufs : -16;
  const filters = ['aresample=48000'];
  if (settings.highPassHz > 0) filters.push(`highpass=f=${Math.round(settings.highPassHz)}`);
  if (strength > 0) filters.push(`afftdn=nr=${(6 + strength * 0.13).toFixed(1)}:nf=-38`);
  if (clarity > 0) {
    filters.push(`equalizer=f=260:t=q:w=1.2:g=${(-1 - clarity * 2).toFixed(1)}`);
    filters.push(`equalizer=f=3000:t=q:w=1.1:g=${(1 + clarity * 2.5).toFixed(1)}`);
  }
  if (level > 0) {
    filters.push(`acompressor=threshold=-21dB:ratio=${(1.8 + level * 2).toFixed(1)}:attack=10:release=140`);
  }
  filters.push(`loudnorm=I=${targetLufs}:TP=-1.5:LRA=7:print_format=json`);
  return filters.join(',');
}

function buildFilterChain(
  settings: ProcessingSettings,
  inputSampleRate = 48000,
  aiTuning?: AiDspTuning
): { filterGraph: string; isComplex: boolean; outputLabel?: string; nrDb: number } {
  const preFilters: string[] = [];

  // Stage 1: Normalize to 48 kHz upfront (required for RNNoise + full-band harmonic restoration)
  preFilters.push('aresample=48000');

  if (settings.highPassHz > 0) {
    preFilters.push(`highpass=f=${Math.round(settings.highPassHz)}:poles=2`);
  }

  if (settings.deClick) {
    preFilters.push('adeclip');
    preFilters.push('adeclick');
  }

  // Stage 2: Deep Neural Voice Isolation (RNNoise) + Residual Spectral Denoise + Downward Noise Gate
  const nrStrength = Math.max(0, Math.min(100, settings.noiseReduction));
  let nrDb = 0;
  if (nrStrength > 0) {
    const useNeural = settings.neuralDenoise !== false;
    const preferredModel = nrStrength >= 60 ? RNNOISE_SH_MODEL : RNNOISE_CB_MODEL;
    const fallbackModel = fs.existsSync(RNNOISE_SH_MODEL) ? RNNOISE_SH_MODEL : RNNOISE_CB_MODEL;
    const modelPath = fs.existsSync(preferredModel) ? preferredModel : fallbackModel;

    if (useNeural && fs.existsSync(modelPath)) {
      const escapedModel = modelPath.replace(/\\/g, '/').replace(/:/g, '\\:');
      const mix = Number(Math.min(1, 0.55 + (nrStrength / 100) * 0.45).toFixed(2));
      preFilters.push(`arnndn=m='${escapedModel}':mix=${mix}`);
      nrDb += Number((10 + (nrStrength / 100) * 14).toFixed(1));

      const fftNr = Number((4 + (nrStrength / 100) * 12).toFixed(1));
      const fftNf = Math.round(-44 + (nrStrength / 100) * 14);
      preFilters.push(`afftdn=nr=${fftNr}:nf=${fftNf}:tn=1`);
      nrDb = Number((nrDb + fftNr * 0.6).toFixed(1));
    } else {
      const fftNr = Number((6 + (nrStrength / 100) * 20).toFixed(1));
      const fftNf = Math.round(-44 + (nrStrength / 100) * 20);
      preFilters.push(`afftdn=nr=${fftNr}:nf=${fftNf}:tn=1`);
      nrDb = fftNr;
      if (nrStrength >= 75) {
        const nlmStrength = ((nrStrength - 70) / 30) * 0.0008 + 0.0002;
        preFilters.push(`anlmdn=s=${nlmStrength.toFixed(5)}:p=0.002:r=0.004`);
      }
    }

    if (nrStrength >= 25) {
      const gateFactor = (nrStrength - 25) / 75;
      const gateThreshold = Number((0.007 + gateFactor * 0.011).toFixed(4));
      const gateRatio = Number((2.2 + gateFactor * 2.8).toFixed(2));
      const gateRange = Number((0.18 - gateFactor * 0.145).toFixed(4));
      preFilters.push(
        `agate=threshold=${gateThreshold}:ratio=${gateRatio}:attack=6:release=160:range=${gateRange}:knee=4`
      );
    }
  }

  // Stage 3: Studio Voice Clarity — AI Speaker-Tuned De-Muddying EQ, Presence & Harmonic Restoration
  const clarity = Math.max(0, Math.min(100, Number.isFinite(settings.voiceClarity) ? settings.voiceClarity : 78));
  const isNarrowband = inputSampleRate > 0 && inputSampleRate < 24000;
  const warmthHz = aiTuning?.warmthHz ?? 135;
  const mudCutHz = aiTuning?.mudCutHz ?? 240;
  const boxyCutHz = aiTuning?.boxyCutHz ?? 520;
  const presenceHz = aiTuning?.presenceHz ?? 2650;
  const consonantHz = aiTuning?.consonantHz ?? 4250;

  if (clarity > 0) {
    const c = clarity / 100;
    const scale = 0.55 + c * 0.55; // scales AI recommendation gently by user's clarity slider
    const warmthDb = Number(
      (aiTuning ? aiTuning.warmthGainDb * scale : 0.8 + c * 1.0).toFixed(2)
    );
    const mudCutDb = Number(
      (aiTuning ? Math.max(-6.5, aiTuning.mudCutDb * scale) : -(1.5 + c * (isNarrowband ? 4.5 : 3.5))).toFixed(2)
    );
    const boxyCutDb = Number(
      (aiTuning ? Math.max(-4.2, aiTuning.boxyCutDb * scale) : -(0.8 + c * 1.8)).toFixed(2)
    );
    const presenceDb = Number(
      (aiTuning ? Math.min(6.4, aiTuning.presenceGainDb * scale) : 1.4 + c * (isNarrowband ? 4.4 : 3.4)).toFixed(2)
    );
    const articulationDb = Number(
      (aiTuning ? Math.min(5.6, aiTuning.consonantGainDb * scale) : 1.0 + c * (isNarrowband ? 3.8 : 2.8)).toFixed(2)
    );
    const airShelfDb = Number((1.0 + c * (isNarrowband ? 3.2 : 2.4)).toFixed(2));

    preFilters.push(`equalizer=f=${warmthHz}:t=q:w=1.2:g=${warmthDb}`);
    preFilters.push(`equalizer=f=${mudCutHz}:t=q:w=1.1:g=${mudCutDb}`);
    preFilters.push(`equalizer=f=${boxyCutHz}:t=q:w=1.3:g=${boxyCutDb}`);
    preFilters.push(`equalizer=f=${presenceHz}:t=q:w=1.1:g=${presenceDb}`);
    preFilters.push(`equalizer=f=${consonantHz}:t=q:w=1.2:g=${articulationDb}`);

    if (clarity >= 20) {
      const aiExcFactor = aiTuning ? aiTuning.exciterBoost / 100 : c;
      const effC = Math.min(1, c * 0.65 + aiExcFactor * 0.35);
      const exciterAmount = Number((1.1 + effC * (isNarrowband ? 2.9 : 2.0)).toFixed(2));
      const exciterDrive = Number((2.8 + effC * (isNarrowband ? 3.4 : 2.4)).toFixed(2));
      const exciterFreq = isNarrowband ? 2400 : 3200;
      preFilters.push(
        `aexciter=level_in=1:level_out=1:amount=${exciterAmount}:drive=${exciterDrive}:blend=0:freq=${exciterFreq}:ceil=14000`
      );
    }

    preFilters.push(`highshelf=f=6500:g=${airShelfDb}`);
    preFilters.push('lowpass=f=16000');
  }

  if (settings.deEsser) {
    const deessIntensity = isNarrowband ? '0.20' : '0.30';
    preFilters.push(`deesser=i=${deessIntensity}:m=0.45:f=0.55:s=o`);
  }

  // Stage 4: Noise-Safe Broadcast Leveling
  const postFilters: string[] = [];
  const lvl = Math.max(0, Math.min(100, settings.leveling));
  if (lvl > 0) {
    const l = lvl / 100;
    const ratio = (2.0 + l * 2.5).toFixed(2);
    const threshold = Math.round(-16 - l * 10);
    const makeup = Number((1.5 + l * 2.0).toFixed(1));
    postFilters.push(
      `acompressor=threshold=${threshold}dB:ratio=${ratio}:attack=8:release=130:knee=4:makeup=${makeup}`
    );

    const maxGain = Number((2.5 + l * 4.5).toFixed(1));
    const targetRms = Number((0.65 + l * 0.15).toFixed(2));
    postFilters.push(`dynaudnorm=f=200:g=15:p=0.92:m=${maxGain}:r=${targetRms}:t=0.022:c=1:b=1`);
  }

  const targetLufs = [-14, -16, -19, -23].includes(settings.targetLufs) ? settings.targetLufs : -16;
  postFilters.push(`loudnorm=I=${targetLufs}:TP=-1.5:LRA=7:print_format=json`);

  // Optional Stage 3.5: Parallel Vocal Articulation & Consonant Reinforcement Bus
  // Splits the cleaned voice, excites/compresses the crisp speech-wording band (1.35-7.6 kHz),
  // and gently mixes it back in-phase so every spoken word stands out cleanly without mud or drift.
  const presenceLayer = Math.max(
    0,
    Math.min(100, Number.isFinite(settings.voicePresenceLayer) ? settings.voicePresenceLayer : 55)
  );

  if (presenceLayer > 0) {
    const p = presenceLayer / 100;
    const clarGain = Number((0.08 + p * 0.28).toFixed(3)); // subtle -22 dB to -9 dB reinforcement
    const clarExc = Number((1.2 + p * 1.8).toFixed(2));
    const preChain = preFilters.join(',');
    const postChain = postFilters.join(',');
    const complexGraph =
      `[0:a]${preChain},asplit=2[vmain][vclar_in];` +
      `[vclar_in]highpass=f=1350:poles=2,lowpass=f=7600:poles=2,equalizer=f=${presenceHz}:t=q:w=1.2:g=2.4,equalizer=f=${consonantHz}:t=q:w=1.1:g=2.8,aexciter=level_in=1:level_out=1:amount=${clarExc}:drive=3.2:blend=0:freq=2500:ceil=12500,acompressor=threshold=-28dB:ratio=3.2:attack=5:release=95:knee=4:makeup=2,volume=${clarGain}[vclar];` +
      `[vmain][vclar]amix=inputs=2:normalize=0:dropout_transition=0,${postChain}[vout]`;

    return {
      filterGraph: complexGraph,
      isComplex: true,
      outputLabel: '[vout]',
      nrDb: Number(nrDb.toFixed(1)),
    };
  }

  return {
    filterGraph: [...preFilters, ...postFilters].join(','),
    isComplex: false,
    nrDb: Number(nrDb.toFixed(1)),
  };
}

async function extractSpeechSampleForAi(
  inputPath: string,
  durationSeconds: number,
  jobDir: string
): Promise<Buffer> {
  const samplePath = path.join(jobDir, `ai_listen_sample_${Date.now()}.mp3`);
  try {
    if (durationSeconds <= 35) {
      await runFfmpegSimple([
        '-y',
        '-v',
        'error',
        '-i',
        inputPath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '48k',
        samplePath,
      ]);
    } else {
      // Sample 3 representative 10-second windows across early/mid/late speech
      const t1 = Math.max(0, Math.min(durationSeconds - 10, Math.round(durationSeconds * 0.08)));
      const t2 = Math.max(0, Math.min(durationSeconds - 10, Math.round(durationSeconds * 0.36)));
      const t3 = Math.max(0, Math.min(durationSeconds - 10, Math.round(durationSeconds * 0.68)));
      await runFfmpegSimple([
        '-y',
        '-v',
        'error',
        '-ss',
        String(t1),
        '-t',
        '10',
        '-i',
        inputPath,
        '-ss',
        String(t2),
        '-t',
        '10',
        '-i',
        inputPath,
        '-ss',
        String(t3),
        '-t',
        '10',
        '-i',
        inputPath,
        '-filter_complex',
        '[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]',
        '-map',
        '[out]',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '48k',
        samplePath,
      ]);
    }
    return fs.readFileSync(samplePath);
  } finally {
    fs.rmSync(samplePath, { force: true });
  }
}

async function detectLeadingSilenceSec(wavPath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-v',
      'info',
      '-i',
      wavPath,
      '-af',
      'silencedetect=noise=-38dB:d=0.12',
      '-f',
      'null',
      '-',
    ]);
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', () => resolve(0));
    proc.on('close', () => {
      // Check if silence starts right near 0.0s
      const startMatch = stderr.match(/silence_start:\s*([0-9.]+)/);
      const endMatch = stderr.match(/silence_end:\s*([0-9.]+)/);
      if (startMatch && endMatch && Number(startMatch[1]) < 0.15) {
        const endVal = Number(endMatch[1]);
        if (Number.isFinite(endVal) && endVal > 0 && endVal < 6) {
          return resolve(Number(endVal.toFixed(3)));
        }
      }
      resolve(0);
    });
  });
}

function buildAtempoChain(ratio: number): string {
  // Clamp natural speaking tempo alignment so matched voice never sounds distorted
  const clamped = Math.max(0.84, Math.min(1.24, ratio));
  return `atempo=${clamped.toFixed(4)}`;
}

async function renderAiVoiceMixFiles(
  job: InternalJob,
  blendMode: AiVoiceBlendMode,
  blendAmount: number
): Promise<void> {
  const baseWavPath = path.join(job.jobDir, 'ai_seg_base.wav');
  const alignedVoicePath = path.join(job.jobDir, 'ai_voice_aligned.wav');
  const mixWavPath = path.join(job.jobDir, 'ai_voice_mix.wav');
  const mixMp3Tmp = path.join(job.jobDir, `ai_voice_mix_${Date.now()}.tmp.mp3`);
  const mixMp3Path = path.join(job.jobDir, 'ai_voice_mix.mp3');

  if (!fs.existsSync(baseWavPath) || !fs.existsSync(alignedVoicePath)) {
    throw new Error('Generate the matched AI voice layer before mixing.');
  }

  const targetLufs = job.settingsUsed?.targetLufs ?? -16;
  const masterChannels = job.inputChannels >= 2 ? 2 : 1;
  const amt = Math.max(0, Math.min(100, blendAmount)) / 100;

  let filterComplex: string;
  if (blendMode === 'full-revoice') {
    filterComplex =
      `[1:a]highpass=f=75:poles=2,equalizer=f=2800:t=q:w=1.1:g=1.6,loudnorm=I=${targetLufs}:TP=-1.5:LRA=7[out]`;
  } else if (blendMode === 'balanced-hybrid') {
    const aiVol = Number((0.28 + amt * 0.68).toFixed(3));
    const origVol = Number(Math.max(0.22, 1.0 - amt * 0.68).toFixed(3));
    filterComplex =
      `[0:a]volume=${origVol}[orig];` +
      `[1:a]highpass=f=210:poles=2,equalizer=f=2850:t=q:w=1.1:g=2.2,volume=${aiVol}[ai];` +
      `[orig][ai]amix=inputs=2:duration=first:normalize=0:dropout_transition=0,loudnorm=I=${targetLufs}:TP=-1.5:LRA=7[out]`;
  } else {
    // Subtle Word Clarity Layer ('clarity-blend'): adds matched upper-vocal articulation & consonants
    // over the speaker's real voice without doubling low-frequency chest resonance
    const aiVol = Number((0.12 + amt * 0.58).toFixed(3));
    const origVol = Number(Math.max(0.72, 1.0 - amt * 0.24).toFixed(3));
    filterComplex =
      `[0:a]volume=${origVol}[orig];` +
      `[1:a]highpass=f=820:poles=2,equalizer=f=2950:t=q:w=1.1:g=2.6,equalizer=f=4500:t=q:w=1.2:g=2.0,lowpass=f=12500,volume=${aiVol}[ai];` +
      `[orig][ai]amix=inputs=2:duration=first:normalize=0:dropout_transition=0,loudnorm=I=${targetLufs}:TP=-1.5:LRA=7[out]`;
  }

  await runFfmpegSimple([
    '-y',
    '-v',
    'error',
    '-i',
    baseWavPath,
    '-i',
    alignedVoicePath,
    '-filter_complex',
    filterComplex,
    '-map',
    '[out]',
    '-ar',
    '48000',
    '-ac',
    String(masterChannels),
    '-c:a',
    'pcm_s24le',
    mixWavPath,
  ]);

  await runFfmpegSimple([
    '-y',
    '-v',
    'error',
    '-i',
    mixWavPath,
    '-c:a',
    'libmp3lame',
    '-b:a',
    '160k',
    '-ar',
    '48000',
    mixMp3Tmp,
  ]);
  fs.renameSync(mixMp3Tmp, mixMp3Path);
}

function parseLoudnormJson(stderrText: string): Partial<{
  input_i: string;
  input_tp: string;
  input_lra: string;
  output_i: string;
  output_tp: string;
  output_lra: string;
}> | null {
  const matches = stderrText.match(/\{[\s\S]*?"input_i"[\s\S]*?"output_i"[\s\S]*?\}/g);
  if (!matches || matches.length === 0) return null;
  try {
    return JSON.parse(matches[matches.length - 1]);
  } catch {
    return null;
  }
}

async function createJobFromDiskFile(params: {
  filePath: string;
  originalName: string;
  mimeType: string;
  fileSizeBytes: number;
  source: 'upload' | 'drive' | 'url';
  sourceDetail?: string;
}): Promise<InternalJob> {
  const probe = await probeMediaFile(params.filePath);

  if (!probe.hasAudio) {
    fs.rmSync(params.filePath, { force: true });
    throw new Error(`"${params.originalName}" does not contain an audio track.`);
  }

  if (probe.durationSeconds <= 0) {
    fs.rmSync(params.filePath, { force: true });
    throw new Error(`Could not determine audio duration for "${params.originalName}".`);
  }

  if (probe.durationSeconds > MAX_DURATION_SECONDS) {
    fs.rmSync(params.filePath, { force: true });
    const mins = Math.round(probe.durationSeconds / 60);
    throw new Error(`"${params.originalName}" is ${mins} minutes long, exceeding the 75-minute limit.`);
  }

  const id = crypto.randomUUID();
  const jobDir = path.join(JOBS_DIR, id);
  fs.mkdirSync(jobDir, { recursive: true });

  const destInputPath = path.join(jobDir, `input${path.extname(params.originalName) || '.bin'}`);
  fs.renameSync(params.filePath, destInputPath);

  const originalPeaks = await extractWaveformPeaks(destInputPath, probe.durationSeconds, 220);

  const job: InternalJob = {
    id,
    originalName: params.originalName,
    source: params.source,
    sourceDetail: params.sourceDetail,
    mimeType: params.mimeType,
    fileSizeBytes: params.fileSizeBytes,
    durationSeconds: probe.durationSeconds,
    inputCodec: probe.codec,
    inputSampleRate: probe.sampleRate,
    inputChannels: probe.channels,
    hasVideo: probe.hasVideo,
    status: 'queued',
    progress: 0,
    stageLabel: 'Ready in queue',
    createdAt: new Date().toISOString(),
    originalPeaks,
    cleanedPeaks: [],
    inputFilePath: destInputPath,
    jobDir,
  };

  jobs.set(id, job);
  persistJob(job);

  return job;
}

async function processJobAudio(job: InternalJob, settings: ProcessingSettings): Promise<void> {
  job.status = 'analyzing';
  job.progress = 5;
  job.stageLabel = 'Preparing audio stream';
  job.errorMessage = undefined;
  persistJob(job);

  try {
    // The original preview is generated on demand by the stream endpoint.
    // Avoid duplicate transcoding while mastering the audio.

    // 1.5 Optional AI Voice Listener: Gemini listens to representative speech samples to tailor EQ & voice clarity
    job.aiVoiceProfileError = undefined;
    let activeAiTuning: AiDspTuning | undefined = job.aiVoiceProfile?.dspTuning;
    if (settings.aiVoiceListener) {
      job.status = 'analyzing';
      job.progress = 10;
      job.stageLabel = 'AI listening to speaker voice & tailoring clarity EQ';
      try {
        const sampleBuf = await extractSpeechSampleForAi(job.inputFilePath, job.durationSeconds, job.jobDir);
        const profile = await listenAndProfileVoice(sampleBuf);
        job.aiVoiceProfile = profile;
        activeAiTuning = profile.dspTuning;
        persistJob(job);
      } catch (aiErr) {
        job.aiVoiceProfileError =
          aiErr instanceof Error ? aiErr.message : 'AI voice listener could not analyze this file.';
        activeAiTuning = undefined;
      }
    }

    // 2. Clean & Normalize Master WAV (48kHz 24-bit PCM) with real progress tracking
    job.status = 'cleaning';
    job.progress = 16;
    job.stageLabel = activeAiTuning
      ? 'Applying AI speaker-tuned clarity EQ, RNNoise & vocal articulation bus'
      : 'Running neural noise reduction, clarity EQ & vocal articulation bus';

    const cleanedMasterPath = path.join(job.jobDir, 'cleaned_master.wav');
    const { filterGraph, isComplex, outputLabel, nrDb } = buildFilterChain(
      settings,
      job.inputSampleRate,
      activeAiTuning
    );
    const totalUs = Math.max(1, job.durationSeconds * 1_000_000);

    let fallbackUsed = false;
    let stderrOutput: string;
    try {
      stderrOutput = await new Promise<string>((resolve, reject) => {
      const args = [
        '-y',
        '-i',
        job.inputFilePath,
        '-vn',
        ...(isComplex && outputLabel
          ? ['-filter_complex', filterGraph, '-map', outputLabel]
          : ['-af', filterGraph]),
        '-ar',
        '48000',
        '-c:a',
        'pcm_s24le',
        '-progress',
        'pipe:1',
        cleanedMasterPath,
      ];

      const proc = spawn('ffmpeg', args);
      let stderr = '';
      let progressBuffer = '';

      proc.stdout.on('data', (chunk: Buffer) => {
        progressBuffer += chunk.toString();
        const lines = progressBuffer.split('\n');
        progressBuffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('out_time_us=')) {
            const us = Number(line.split('=')[1]);
            if (Number.isFinite(us) && us > 0) {
              const pct = Math.min(84, Math.max(15, Math.round(15 + (us / totalUs) * 69)));
              job.progress = pct;
              if (pct > 62) {
                job.status = 'normalizing';
                job.stageLabel = `Normalizing loudness to ${settings.targetLufs} LUFS`;
              }
            }
          }
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr.slice(-800) || `Processing failed with code ${code}`));
        } else {
          resolve(stderr);
        }
      });
      });
    } catch (primaryErr) {
      // A missing or unsupported optional FFmpeg filter should never leave Clean broken.
      fallbackUsed = true;
      job.status = 'cleaning';
      job.progress = 20;
      job.stageLabel = 'Using compatible speech cleanup filters';
      persistJob(job);
      try {
        stderrOutput = await runFfmpegSimple([
          '-y', '-hide_banner', '-i', job.inputFilePath, '-vn',
          '-af', buildCompatibleFilterChain(settings),
          '-ar', '48000', '-c:a', 'pcm_s24le', cleanedMasterPath,
        ]);
      } catch (fallbackErr) {
        const primary = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
        const fallback = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        throw new Error(`Audio engine failed. Primary: ${primary.slice(-320)}. Fallback: ${fallback.slice(-320)}`);
      }
    }

    job.cleanedMasterPath = cleanedMasterPath;

    // 3. Render streaming preview MP3 for fast A/B playback
    job.status = 'normalizing';
    job.progress = 88;
    job.stageLabel = 'Building waveform & streaming master preview';

    const cleanedPreviewTmp = path.join(job.jobDir, `cleaned_preview_${Date.now()}.tmp.mp3`);
    const cleanedPreviewPath = path.join(job.jobDir, 'cleaned_preview.mp3');
    await runFfmpegSimple([
      '-y',
      '-v',
      'error',
      '-i',
      cleanedMasterPath,
      '-c:a',
      'libmp3lame',
      '-b:a',
      '160k',
      '-ar',
      '48000',
      cleanedPreviewTmp,
    ]);
    fs.renameSync(cleanedPreviewTmp, cleanedPreviewPath);
    job.cleanedPreviewPath = cleanedPreviewPath;

    // 4. Extract cleaned waveform peaks
    job.progress = 95;
    job.cleanedPeaks = await extractWaveformPeaks(cleanedMasterPath, job.durationSeconds, 220);

    // Clear previously cached export files because master changed
    for (const entry of fs.readdirSync(job.jobDir)) {
      if (entry.startsWith('export_')) {
        fs.rmSync(path.join(job.jobDir, entry), { force: true });
      }
    }

    const parsedStats = parseLoudnormJson(stderrOutput);
    const numOrNull = (v?: string) => {
      if (!v) return null;
      const n = Number(v);
      return Number.isFinite(n) && Math.abs(n) < 90 ? Number(n.toFixed(1)) : null;
    };

    job.telemetry = {
      inputLufs: numOrNull(parsedStats?.input_i),
      outputLufs: numOrNull(parsedStats?.output_i) ?? settings.targetLufs,
      inputTruePeak: numOrNull(parsedStats?.input_tp),
      outputTruePeak: numOrNull(parsedStats?.output_tp) ?? -1.5,
      inputLra: numOrNull(parsedStats?.input_lra),
      outputLra: numOrNull(parsedStats?.output_lra),
      noiseReductionDb: nrDb,
    };

    job.settingsUsed = { ...settings };
    job.processedAt = new Date().toISOString();
    job.progress = 100;
    job.status = 'ready';
    job.stageLabel = fallbackUsed ? 'Master ready (compatible cleanup)' : 'Master ready';
    persistJob(job);
  } catch (err) {
    job.status = 'error';
    job.stageLabel = 'Processing failed';
    job.errorMessage = err instanceof Error ? err.message : 'Unexpected audio processing error';
    console.error(`[ClearCast] Job ${job.id} failed:`, job.errorMessage);
    persistJob(job);
  }
}

async function renderExportFile(job: InternalJob, opts: ExportOptions): Promise<{ filePath: string; fileName: string; mimeType: string }> {
  if (!job.cleanedMasterPath || !fs.existsSync(job.cleanedMasterPath)) {
    throw new Error('Processed master not available. Run noise cleanup first.');
  }

  const baseName = sanitizeBaseName(job.originalName);
  const ext = opts.format;
  const specKey =
    opts.format === 'mp3'
      ? `mp3_${opts.mp3Bitrate}_${opts.sampleRate}_${opts.channels}`
      : `wav_${opts.wavBitDepth}_${opts.sampleRate}_${opts.channels}`;

  const outPath = path.join(job.jobDir, `export_${specKey}.${ext}`);
  const outName = `${baseName}_clean_${opts.format === 'mp3' ? `${opts.mp3Bitrate}kbps` : `${opts.wavBitDepth}bit`}.${ext}`;
  const mimeType = opts.format === 'mp3' ? 'audio/mpeg' : 'audio/wav';

  if (fs.existsSync(outPath)) {
    return { filePath: outPath, fileName: outName, mimeType };
  }

  const args = ['-y', '-v', 'error', '-i', job.cleanedMasterPath, '-ar', String(opts.sampleRate)];

  if (opts.channels === 'mono') {
    args.push('-ac', '1');
  } else if (opts.channels === 'stereo') {
    args.push('-ac', '2');
  }

  if (opts.format === 'mp3') {
    args.push('-c:a', 'libmp3lame', '-b:a', `${opts.mp3Bitrate}k`);
  } else {
    const pcmCodec =
      opts.wavBitDepth === 32 ? 'pcm_f32le' : opts.wavBitDepth === 24 ? 'pcm_s24le' : 'pcm_s16le';
    args.push('-c:a', pcmCodec);
  }

  args.push(outPath);
  await runFfmpegSimple(args);
  return { filePath: outPath, fileName: outName, mimeType };
}

function parseExportOptions(source: Record<string, unknown>): ExportOptions {
  const format = source.format === 'wav' ? 'wav' : 'mp3';
  const rawMp3 = Number(source.mp3Bitrate ?? source.bitrate);
  const mp3Bitrate: 128 | 192 | 256 | 320 =
    rawMp3 === 128 || rawMp3 === 192 || rawMp3 === 256 || rawMp3 === 320 ? rawMp3 : 192;
  const rawWav = Number(source.wavBitDepth ?? source.bitDepth);
  const wavBitDepth: 16 | 24 | 32 = rawWav === 16 || rawWav === 24 || rawWav === 32 ? rawWav : 24;
  const rawSr = Number(source.sampleRate);
  const sampleRate: 44100 | 48000 = rawSr === 44100 ? 44100 : 48000;
  const rawCh = String(source.channels || 'original');
  const channels: 'original' | 'stereo' | 'mono' =
    rawCh === 'mono' || rawCh === 'stereo' ? rawCh : 'original';

  return { format, mp3Bitrate, wavBitDepth, sampleRate, channels };
}

function extractDriveFileIdFromUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (!parsed.hostname.includes('drive.google.com') && !parsed.hostname.includes('docs.google.com')) {
      return null;
    }
    const fileMatch = parsed.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (fileMatch) return fileMatch[1];
    const idParam = parsed.searchParams.get('id');
    if (idParam) return idParam;
    return null;
  } catch {
    return null;
  }
}

function extractFilenameFromHeaders(headers: Headers, fallbackUrl: string): string {
  const disp = headers.get('content-disposition');
  if (disp) {
    const utf8Match = disp.match(/filename\*=UTF-8''([^;\n]+)/i);
    if (utf8Match) return decodeURIComponent(utf8Match[1]);
    const asciiMatch = disp.match(/filename="?([^";\n]+)"?/i);
    if (asciiMatch) return asciiMatch[1];
  }
  try {
    const pathname = new URL(fallbackUrl).pathname;
    const base = path.basename(pathname);
    if (base && base.includes('.')) return decodeURIComponent(base);
  } catch {
    // ignore
  }
  return `remote_media_${Date.now()}.mp3`;
}

function streamAudioFileWithRange(req: Request, res: Response, filePath: string, contentType: string) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  if (fileSize <= 0) {
    res.status(404).json({ error: 'Audio stream file is empty.' });
    return;
  }

  const range = req.headers.range;
  const commonHeaders = {
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
    'Cache-Control': 'private, no-cache',
  };

  if (range && range.startsWith('bytes=')) {
    const [rawStart, rawEnd] = range.replace(/^bytes=/, '').split('-');
    let start: number;
    let requestedEnd: number;

    if (rawStart === '' && rawEnd) {
      // Suffix byte range (e.g. bytes=-1024)
      const suffix = parseInt(rawEnd, 10);
      start = Number.isNaN(suffix) ? 0 : Math.max(0, fileSize - suffix);
      requestedEnd = fileSize - 1;
    } else {
      start = parseInt(rawStart, 10);
      requestedEnd = rawEnd ? parseInt(rawEnd, 10) : fileSize - 1;
    }

    if (Number.isNaN(start) || start < 0 || start >= fileSize || Number.isNaN(requestedEnd) || requestedEnd < start) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    // Cap every 206 chunk to 2 MB so Cloud Run's 32 MB proxy limit is never tripped on 75-min files
    const end = Math.min(requestedEnd, start + MAX_STREAM_CHUNK - 1, fileSize - 1);
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      ...commonHeaders,
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': chunkSize,
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath, { start, end });
    res.on('close', () => stream.destroy());
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      ...commonHeaders,
      'Content-Length': fileSize,
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    res.on('close', () => stream.destroy());
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    stream.pipe(res);
  }
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname)}`;
    cb(null, unique);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 12,
  },
});

async function loadPersistedJobs(): Promise<void> {
  if (!fs.existsSync(JOBS_DIR)) return;
  const entries = fs.readdirSync(JOBS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobDir = path.join(JOBS_DIR, entry.name);
    const metaPath = path.join(jobDir, 'job.json');
    try {
      if (fs.existsSync(metaPath)) {
        const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as InternalJob;
        if (parsed.inputFilePath && fs.existsSync(parsed.inputFilePath)) {
          // Reset any interrupted processing state back to queued
          if (parsed.status === 'analyzing' || parsed.status === 'cleaning' || parsed.status === 'normalizing') {
            parsed.status = 'queued';
            parsed.progress = 0;
            parsed.stageLabel = 'Ready in queue';
          }
          jobs.set(parsed.id, parsed);
          continue;
        }
      }

      // Recover an existing job folder that has an input media file without job.json
      const inputFile = fs.readdirSync(jobDir).find((f) => f.startsWith('input.'));
      if (!inputFile) continue;
      const inputPath = path.join(jobDir, inputFile);
      const stat = fs.statSync(inputPath);
      const probe = await probeMediaFile(inputPath);
      if (!probe.hasAudio || probe.durationSeconds <= 0) continue;

      const peaks = await extractWaveformPeaks(inputPath, probe.durationSeconds, 220);
      const recovered: InternalJob = {
        id: entry.name,
        originalName: `Uploaded Audio${path.extname(inputFile)}`,
        source: 'upload',
        mimeType: 'application/octet-stream',
        fileSizeBytes: stat.size,
        durationSeconds: probe.durationSeconds,
        inputCodec: probe.codec,
        inputSampleRate: probe.sampleRate,
        inputChannels: probe.channels,
        hasVideo: probe.hasVideo,
        status: 'queued',
        progress: 0,
        stageLabel: 'Ready in queue',
        createdAt: stat.mtime.toISOString(),
        originalPeaks: peaks,
        cleanedPeaks: [],
        inputFilePath: inputPath,
        jobDir,
      };
      jobs.set(recovered.id, recovered);
      persistJob(recovered);
    } catch {
      // Skip corrupt directory
    }
  }
}

async function startServer() {
  await loadPersistedJobs();
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (_req, res) => {
    const ffmpeg = spawnSync('ffmpeg', ['-version'], { timeout: 5000, stdio: 'ignore' });
    const ffprobe = spawnSync('ffprobe', ['-version'], { timeout: 5000, stdio: 'ignore' });
    const available = ffmpeg.status === 0 && ffprobe.status === 0;
    res.status(available ? 200 : 503).json({
      ok: available,
      ffmpegAvailable: ffmpeg.status === 0,
      ffprobeAvailable: ffprobe.status === 0,
      maxDurationSeconds: MAX_DURATION_SECONDS,
    });
  });

  app.get('/api/jobs', (_req, res) => {
    const list = Array.from(jobs.values())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map(serializeJob);
    res.json({ jobs: list });
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ job: serializeJob(job) });
  });

  app.post('/api/upload', upload.array('files', 12), async (req, res) => {
    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No audio or video files were uploaded.' });
    }

    const created: ReturnType<typeof serializeJob>[] = [];
    const errors: Array<{ fileName: string; message: string }> = [];

    for (const file of files) {
      try {
        const job = await createJobFromDiskFile({
          filePath: file.path,
          originalName: file.originalname,
          mimeType: file.mimetype || 'application/octet-stream',
          fileSizeBytes: file.size,
          source: 'upload',
        });
        created.push(serializeJob(job));
      } catch (err) {
        fs.rmSync(file.path, { force: true });
        errors.push({
          fileName: file.originalname,
          message: err instanceof Error ? err.message : 'Failed to inspect media file.',
        });
      }
    }

    res.status(created.length > 0 ? 200 : 400).json({ jobs: created, errors });
  });

  app.post('/api/import/url', async (req, res) => {
    const rawUrl = String(req.body?.url || '').trim();
    if (!rawUrl) {
      return res.status(400).json({ error: 'Please provide a valid HTTP, HTTPS, or Google Drive URL.' });
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error('Invalid protocol');
      }
    } catch {
      return res.status(400).json({ error: 'URL must start with http:// or https://' });
    }

    const authHeader = req.headers.authorization;
    const driveFileId = extractDriveFileIdFromUrl(rawUrl);
    const tempPath = path.join(UPLOAD_DIR, `url_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`);

    try {
      let downloadUrl = rawUrl;
      const fetchHeaders: Record<string, string> = {};
      let originalName = '';
      let mimeType = 'application/octet-stream';

      if (driveFileId) {
        if (authHeader) {
          // Fetch metadata first for authentic file name
          const metaRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveFileId)}?fields=name,mimeType,size`,
            { headers: { Authorization: authHeader } }
          );
          if (!metaRes.ok) {
            const errTxt = await metaRes.text();
            throw new Error(`Google Drive file access failed (${metaRes.status}). Make sure you have access to this file.`);
          }
          const meta = (await metaRes.json()) as { name?: string; mimeType?: string };
          originalName = meta.name || `drive_${driveFileId}.mp3`;
          mimeType = meta.mimeType || mimeType;
          downloadUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveFileId)}?alt=media`;
          fetchHeaders.Authorization = authHeader;
        } else {
          downloadUrl = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(driveFileId)}`;
        }
      }

      const upstream = await fetch(downloadUrl, { headers: fetchHeaders, redirect: 'follow' });
      if (!upstream.ok || !upstream.body) {
        throw new Error(
          driveFileId && !authHeader
            ? 'Could not download Google Drive link anonymously. Sign in with Google to import private Drive files.'
            : `Remote server returned HTTP ${upstream.status}.`
        );
      }

      const contentType = upstream.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        throw new Error(
          driveFileId
            ? 'This Google Drive link points to a restricted page. Sign in with Google and use Drive Import or ensure direct access.'
            : 'The link returned an HTML webpage instead of a direct audio/video media stream.'
        );
      }

      const contentLength = Number(upstream.headers.get('content-length') || 0);
      if (contentLength > MAX_UPLOAD_BYTES) {
        throw new Error('Remote media file exceeds the 3.5 GB maximum transfer size.');
      }

      if (!originalName) {
        originalName = extractFilenameFromHeaders(upstream.headers, rawUrl);
      }
      if (contentType && !contentType.startsWith('text/')) {
        mimeType = contentType.split(';')[0].trim();
      }

      const writable = fs.createWriteStream(tempPath);
      await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), writable);

      const stat = fs.statSync(tempPath);
      const job = await createJobFromDiskFile({
        filePath: tempPath,
        originalName,
        mimeType,
        fileSizeBytes: stat.size,
        source: driveFileId ? 'drive' : 'url',
        sourceDetail: rawUrl,
      });

      res.json({ job: serializeJob(job) });
    } catch (err) {
      fs.rmSync(tempPath, { force: true });
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to import media from URL.' });
    }
  });

  app.post('/api/import/drive', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Google Drive authorization token required.' });
    }

    const files = Array.isArray(req.body?.files)
      ? (req.body.files as Array<{ id: string; name: string; mimeType?: string }>)
      : [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No Google Drive files specified.' });
    }

    const created: ReturnType<typeof serializeJob>[] = [];
    const errors: Array<{ fileName: string; message: string }> = [];

    for (const file of files) {
      const tempPath = path.join(UPLOAD_DIR, `gdrive_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`);
      try {
        const driveRes = await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`,
          { headers: { Authorization: authHeader } }
        );
        if (!driveRes.ok || !driveRes.body) {
          throw new Error(`Drive download returned HTTP ${driveRes.status}`);
        }
        const writable = fs.createWriteStream(tempPath);
        await pipeline(Readable.fromWeb(driveRes.body as Parameters<typeof Readable.fromWeb>[0]), writable);

        const stat = fs.statSync(tempPath);
        const job = await createJobFromDiskFile({
          filePath: tempPath,
          originalName: file.name,
          mimeType: file.mimeType || 'application/octet-stream',
          fileSizeBytes: stat.size,
          source: 'drive',
          sourceDetail: file.id,
        });
        created.push(serializeJob(job));
      } catch (err) {
        fs.rmSync(tempPath, { force: true });
        errors.push({
          fileName: file.name,
          message: err instanceof Error ? err.message : 'Failed to import from Google Drive',
        });
      }
    }

    res.status(created.length > 0 ? 200 : 400).json({ jobs: created, errors });
  });

  app.post('/api/jobs/:id/process', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (job.status === 'analyzing' || job.status === 'cleaning' || job.status === 'normalizing') {
      return res.status(409).json({ error: 'Job is already processing.' });
    }

    if (!fs.existsSync(job.inputFilePath)) {
      return res.status(410).json({ error: 'Original media is missing on the server. Upload the file again.' });
    }
    const engine = spawnSync('ffmpeg', ['-version'], { timeout: 5000, stdio: 'ignore' });
    if (engine.status !== 0) {
      return res.status(503).json({ error: 'Audio processing is unavailable: FFmpeg is not installed on this server.' });
    }

    const body = req.body?.settings || {};
    const settings: ProcessingSettings = {
      presetId: String(body.presetId || 'custom'),
      presetName: String(body.presetName || 'Custom Studio Chain'),
      noiseReduction: Number.isFinite(Number(body.noiseReduction)) ? Number(body.noiseReduction) : 82,
      voiceClarity: Number.isFinite(Number(body.voiceClarity)) ? Number(body.voiceClarity) : 78,
      voicePresenceLayer: Number.isFinite(Number(body.voicePresenceLayer)) ? Number(body.voicePresenceLayer) : 55,
      leveling: Number.isFinite(Number(body.leveling)) ? Number(body.leveling) : 72,
      targetLufs: Number.isFinite(Number(body.targetLufs)) ? Number(body.targetLufs) : -16,
      highPassHz: Number.isFinite(Number(body.highPassHz)) ? Number(body.highPassHz) : 80,
      neuralDenoise: Boolean(body.neuralDenoise ?? true),
      aiVoiceListener: Boolean(body.aiVoiceListener ?? true),
      deEsser: Boolean(body.deEsser ?? true),
      deClick: Boolean(body.deClick ?? false),
    };

    // Kick off async ffmpeg pipeline and return immediate status so UI polls live progress
    void processJobAudio(job, settings);
    res.json({ job: serializeJob(job) });
  });

  // ── AI Matched-Voice Clarity Layer Endpoints ────────────────────────────────

  app.post('/api/jobs/:id/ai-voice/analyze', async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const requestedStart = Math.max(0, Number(req.body?.startSec) || 0);
    const maxWindow = Math.min(60, job.durationSeconds);
    const requestedDuration = Math.max(
      4,
      Math.min(maxWindow, Number(req.body?.durationSec) || Math.min(30, job.durationSeconds))
    );
    const startSec = Math.max(0, Math.min(requestedStart, Math.max(0, job.durationSeconds - 4)));
    const durationSec = Number(Math.min(requestedDuration, job.durationSeconds - startSec).toFixed(2));

    const sourcePath =
      job.cleanedMasterPath && fs.existsSync(job.cleanedMasterPath)
        ? job.cleanedMasterPath
        : job.inputFilePath;

    const baseWavPath = path.join(job.jobDir, 'ai_seg_base.wav');
    const baseMp3Path = path.join(job.jobDir, 'ai_seg_base.mp3');
    const listenMp3Path = path.join(job.jobDir, 'ai_seg_listen.mp3');

    try {
      // Extract the exact segment for both Gemini listening and later phase-accurate blending
      await runFfmpegSimple([
        '-y',
        '-v',
        'error',
        '-ss',
        String(startSec),
        '-t',
        String(durationSec),
        '-i',
        sourcePath,
        '-vn',
        '-ar',
        '48000',
        '-ac',
        String(job.inputChannels >= 2 ? 2 : 1),
        '-c:a',
        'pcm_s24le',
        baseWavPath,
      ]);

      await runFfmpegSimple([
        '-y',
        '-v',
        'error',
        '-i',
        baseWavPath,
        '-c:a',
        'libmp3lame',
        '-b:a',
        '160k',
        '-ar',
        '48000',
        baseMp3Path,
      ]);

      await runFfmpegSimple([
        '-y',
        '-v',
        'error',
        '-i',
        baseWavPath,
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '64k',
        listenMp3Path,
      ]);

      const mp3Buffer = fs.readFileSync(listenMp3Path);
      const analysis = await listenAndTranscribeSegment(mp3Buffer, durationSec);

      const clip: AiVoiceClip = {
        id: crypto.randomUUID(),
        startSec: Number(startSec.toFixed(2)),
        durationSec,
        detectedLanguage: analysis.detectedLanguage,
        speakerCount: analysis.speakerCount,
        speakers: analysis.speakers,
        utterances: analysis.utterances,
        muffledWordsNote: analysis.muffledWordsNote,
        blendMode: 'clarity-blend',
        blendAmount: 30,
        hasSynthesizedVoice: false,
        appliedToMaster: false,
        updatedAt: new Date().toISOString(),
      };

      job.aiVoiceClip = clip;
      persistJob(job);
      res.json({ clip, job: serializeJob(job) });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to listen to audio segment.',
      });
    } finally {
      fs.rmSync(listenMp3Path, { force: true });
    }
  });

  app.post('/api/jobs/:id/ai-voice/synthesize', async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!job.aiVoiceClip) {
      return res.status(400).json({ error: 'Run AI Listen & Analyze on a passage first.' });
    }

    const baseWavPath = path.join(job.jobDir, 'ai_seg_base.wav');
    if (!fs.existsSync(baseWavPath)) {
      return res.status(400).json({ error: 'Extracted segment audio not found. Please re-analyze the passage.' });
    }

    const speakers: AiSpeakerProfile[] = Array.isArray(req.body?.speakers) && req.body.speakers.length > 0
      ? req.body.speakers
      : job.aiVoiceClip.speakers;
    const utterances: AiUtterance[] = Array.isArray(req.body?.utterances) && req.body.utterances.length > 0
      ? req.body.utterances
      : job.aiVoiceClip.utterances;
    const blendMode: AiVoiceBlendMode =
      req.body?.blendMode === 'balanced-hybrid' || req.body?.blendMode === 'full-revoice'
        ? req.body.blendMode
        : 'clarity-blend';
    const blendAmount = Number.isFinite(Number(req.body?.blendAmount))
      ? Math.max(0, Math.min(100, Number(req.body.blendAmount)))
      : job.aiVoiceClip.blendAmount;

    const rawTtsWavPath = path.join(job.jobDir, 'ai_voice_raw.wav');
    const trimmedTtsWavPath = path.join(job.jobDir, 'ai_voice_trimmed.wav');
    const alignedVoicePath = path.join(job.jobDir, 'ai_voice_aligned.wav');
    const isolatedMp3Tmp = path.join(job.jobDir, `ai_voice_iso_${Date.now()}.tmp.mp3`);
    const isolatedMp3Path = path.join(job.jobDir, 'ai_voice_isolated.mp3');

    try {
      const wavBuffer = await synthesizeMatchedVoiceLayer({ speakers, utterances });
      fs.writeFileSync(rawTtsWavPath, wavBuffer);

      // Trim leading/trailing dead air from synthesized clip so alignment matches original speech onset
      await runFfmpegSimple([
        '-y',
        '-v',
        'error',
        '-i',
        rawTtsWavPath,
        '-af',
        'silenceremove=start_periods=1:start_silence=0.04:start_threshold=-42dB:stop_periods=-1:stop_duration=0.3:stop_threshold=-42dB',
        '-ar',
        '48000',
        '-c:a',
        'pcm_s24le',
        trimmedTtsWavPath,
      ]);

      const baseProbe = await probeMediaFile(baseWavPath);
      const ttsProbe = await probeMediaFile(trimmedTtsWavPath);
      const leadingSilenceSec = await detectLeadingSilenceSec(baseWavPath);
      const targetSpeechSpan = Math.max(1, baseProbe.durationSeconds - leadingSilenceSec);
      const tempoRatio = ttsProbe.durationSeconds > 0.3 ? ttsProbe.durationSeconds / targetSpeechSpan : 1.0;
      const delayMs = Math.round(leadingSilenceSec * 1000);
      const masterChannels = job.inputChannels >= 2 ? 2 : 1;

      const alignFilters = [
        buildAtempoChain(tempoRatio),
        ...(delayMs > 10 ? [`adelay=${delayMs}|${delayMs}`] : []),
        `apad=whole_dur=${baseProbe.durationSeconds.toFixed(3)}`,
        `atrim=0:${baseProbe.durationSeconds.toFixed(3)}`,
      ].join(',');

      await runFfmpegSimple([
        '-y',
        '-v',
        'error',
        '-i',
        trimmedTtsWavPath,
        '-af',
        alignFilters,
        '-ar',
        '48000',
        '-ac',
        String(masterChannels),
        '-c:a',
        'pcm_s24le',
        alignedVoicePath,
      ]);

      await runFfmpegSimple([
        '-y',
        '-v',
        'error',
        '-i',
        alignedVoicePath,
        '-c:a',
        'libmp3lame',
        '-b:a',
        '160k',
        '-ar',
        '48000',
        isolatedMp3Tmp,
      ]);
      fs.renameSync(isolatedMp3Tmp, isolatedMp3Path);

      await renderAiVoiceMixFiles(job, blendMode, blendAmount);

      job.aiVoiceClip = {
        ...job.aiVoiceClip,
        speakers,
        utterances,
        blendMode,
        blendAmount,
        hasSynthesizedVoice: true,
        appliedToMaster: false,
        updatedAt: new Date().toISOString(),
      };
      persistJob(job);

      res.json({ clip: job.aiVoiceClip, job: serializeJob(job) });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to synthesize matched AI voice layer.',
      });
    } finally {
      fs.rmSync(rawTtsWavPath, { force: true });
      fs.rmSync(trimmedTtsWavPath, { force: true });
    }
  });

  app.post('/api/jobs/:id/ai-voice/remix', async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || !job.aiVoiceClip?.hasSynthesizedVoice) {
      return res.status(400).json({ error: 'Generate the AI voice layer before adjusting blend.' });
    }

    const blendMode: AiVoiceBlendMode =
      req.body?.blendMode === 'balanced-hybrid' || req.body?.blendMode === 'full-revoice'
        ? req.body.blendMode
        : 'clarity-blend';
    const blendAmount = Number.isFinite(Number(req.body?.blendAmount))
      ? Math.max(0, Math.min(100, Number(req.body.blendAmount)))
      : job.aiVoiceClip.blendAmount;

    try {
      await renderAiVoiceMixFiles(job, blendMode, blendAmount);
      job.aiVoiceClip = {
        ...job.aiVoiceClip,
        blendMode,
        blendAmount,
        appliedToMaster: false,
        updatedAt: new Date().toISOString(),
      };
      persistJob(job);
      res.json({ clip: job.aiVoiceClip, job: serializeJob(job) });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to update AI voice blend.',
      });
    }
  });

  app.get('/api/jobs/:id/ai-voice/stream', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const layer = String(req.query.layer || 'mix');
    const fileMap: Record<string, string> = {
      mix: path.join(job.jobDir, 'ai_voice_mix.mp3'),
      voice: path.join(job.jobDir, 'ai_voice_isolated.mp3'),
      base: path.join(job.jobDir, 'ai_seg_base.mp3'),
    };
    const targetPath = fileMap[layer] || fileMap.mix;
    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({ error: 'AI voice preview audio not generated yet.' });
    }
    return streamAudioFileWithRange(req, res, targetPath, 'audio/mpeg');
  });

  app.post('/api/jobs/:id/ai-voice/apply', async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || !job.aiVoiceClip?.hasSynthesizedVoice) {
      return res.status(400).json({ error: 'Generate an AI matched-voice layer before applying to the master.' });
    }

    const mixWavPath = path.join(job.jobDir, 'ai_voice_mix.wav');
    if (!fs.existsSync(mixWavPath)) {
      return res.status(400).json({ error: 'Blended AI audio segment is missing.' });
    }

    const masterPath = job.cleanedMasterPath && fs.existsSync(job.cleanedMasterPath)
      ? job.cleanedMasterPath
      : null;
    if (!masterPath) {
      return res.status(400).json({ error: 'Run Clean & Level Audio on this track before applying the AI voice layer to the master.' });
    }

    const { startSec, durationSec } = job.aiVoiceClip;
    const endSec = Math.min(job.durationSeconds, startSec + durationSec);
    const updatedMasterTmp = path.join(job.jobDir, `cleaned_master_ai_${Date.now()}.tmp.wav`);
    const cleanedPreviewTmp = path.join(job.jobDir, `cleaned_preview_${Date.now()}.tmp.mp3`);
    const cleanedPreviewPath = path.join(job.jobDir, 'cleaned_preview.mp3');

    try {
      const fadeSec = Math.min(0.04, durationSec / 8);
      const hasBefore = startSec > 0.05;
      const hasAfter = endSec < job.durationSeconds - 0.05;

      if (!hasBefore && !hasAfter) {
        fs.copyFileSync(mixWavPath, updatedMasterTmp);
      } else {
        const inputs: string[] = [];
        const chains: string[] = [];
        const concatLabels: string[] = [];
        let inputIdx = 0;

        if (hasBefore) {
          inputs.push('-ss', '0', '-t', startSec.toFixed(3), '-i', masterPath);
          chains.push(`[${inputIdx}:a]afade=t=out:st=${Math.max(0, startSec - fadeSec).toFixed(3)}:d=${fadeSec.toFixed(3)}[seg_pre]`);
          concatLabels.push('[seg_pre]');
          inputIdx++;
        }

        inputs.push('-i', mixWavPath);
        const mixFades: string[] = [];
        if (hasBefore) mixFades.push(`afade=t=in:st=0:d=${fadeSec.toFixed(3)}`);
        if (hasAfter) mixFades.push(`afade=t=out:st=${Math.max(0, durationSec - fadeSec).toFixed(3)}:d=${fadeSec.toFixed(3)}`);
        chains.push(
          mixFades.length > 0
            ? `[${inputIdx}:a]${mixFades.join(',')}[seg_ai]`
            : `[${inputIdx}:a]anull[seg_ai]`
        );
        concatLabels.push('[seg_ai]');
        inputIdx++;

        if (hasAfter) {
          inputs.push('-ss', endSec.toFixed(3), '-i', masterPath);
          chains.push(`[${inputIdx}:a]afade=t=in:st=0:d=${fadeSec.toFixed(3)}[seg_post]`);
          concatLabels.push('[seg_post]');
        }

        const graph = `${chains.join(';')};${concatLabels.join('')}concat=n=${concatLabels.length}:v=0:a=1[out]`;
        await runFfmpegSimple([
          '-y',
          '-v',
          'error',
          ...inputs,
          '-filter_complex',
          graph,
          '-map',
          '[out]',
          '-ar',
          '48000',
          '-c:a',
          'pcm_s24le',
          updatedMasterTmp,
        ]);
      }

      fs.renameSync(updatedMasterTmp, masterPath);

      await runFfmpegSimple([
        '-y',
        '-v',
        'error',
        '-i',
        masterPath,
        '-c:a',
        'libmp3lame',
        '-b:a',
        '160k',
        '-ar',
        '48000',
        cleanedPreviewTmp,
      ]);
      fs.renameSync(cleanedPreviewTmp, cleanedPreviewPath);
      job.cleanedPreviewPath = cleanedPreviewPath;
      job.cleanedPeaks = await extractWaveformPeaks(masterPath, job.durationSeconds, 220);

      // Clear cached exports so next download includes the AI-enhanced passage
      for (const entry of fs.readdirSync(job.jobDir)) {
        if (entry.startsWith('export_')) {
          fs.rmSync(path.join(job.jobDir, entry), { force: true });
        }
      }

      job.processedAt = new Date().toISOString();
      job.aiVoiceClip = {
        ...job.aiVoiceClip,
        appliedToMaster: true,
        updatedAt: job.processedAt,
      };
      persistJob(job);

      res.json({ job: serializeJob(job) });
    } catch (err) {
      fs.rmSync(updatedMasterTmp, { force: true });
      fs.rmSync(cleanedPreviewTmp, { force: true });
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to apply AI voice layer to cleaned master.',
      });
    }
  });

  app.get('/api/jobs/:id/stream', async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const variant = req.query.variant === 'cleaned' ? 'cleaned' : 'original';

    if (variant === 'cleaned') {
      if (!job.cleanedPreviewPath || !fs.existsSync(job.cleanedPreviewPath)) {
        return res.status(404).json({ error: 'Cleaned preview not generated yet.' });
      }
      return streamAudioFileWithRange(req, res, job.cleanedPreviewPath, 'audio/mpeg');
    }

    try {
      const { filePath, contentType } = await ensureOriginalPreview(job);
      return streamAudioFileWithRange(req, res, filePath, contentType);
    } catch {
      return res.status(500).json({ error: 'Could not prepare original audio stream.' });
    }
  });

  app.get('/api/jobs/:id/export', async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    try {
      const opts = parseExportOptions(req.query as Record<string, unknown>);
      const { filePath, fileName, mimeType } = await renderExportFile(job, opts);
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
      res.sendFile(filePath);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Export failed.' });
    }
  });

  app.post('/api/jobs/:id/sync-drive', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Google Drive sign-in required for cloud sync.' });
    }

    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const folderId = String(req.body?.folderId || '').trim();
    if (!folderId) {
      return res.status(400).json({ error: 'Target Google Drive sync folder ID is required.' });
    }

    try {
      const opts = parseExportOptions(req.body?.exportSettings || {});
      const { filePath, fileName, mimeType } = await renderExportFile(job, opts);
      const stat = fs.statSync(filePath);

      const metadata = {
        name: fileName,
        parents: [folderId],
        description: `ClearCast Studio master (${job.settingsUsed?.presetName || 'Custom'}, ${job.telemetry?.outputLufs ?? -16} LUFS)`,
        appProperties: {
          clearcastMaster: 'true',
          originalName: job.originalName.slice(0, 110),
          durationSeconds: String(Math.round(job.durationSeconds)),
          inputLufs: String(job.telemetry?.inputLufs ?? ''),
          outputLufs: String(job.telemetry?.outputLufs ?? ''),
          format: opts.format,
          bitrate: opts.format === 'mp3' ? `${opts.mp3Bitrate}kbps` : `${opts.wavBitDepth}-bit`,
          sampleRate: String(opts.sampleRate),
          presetName: (job.settingsUsed?.presetName || 'Custom').slice(0, 110),
        },
      };

      // Initiate Google Drive resumable upload session
      const initRes = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,size,modifiedTime,webViewLink,appProperties,description',
        {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': mimeType,
            'X-Upload-Content-Length': String(stat.size),
          },
          body: JSON.stringify(metadata),
        }
      );

      if (!initRes.ok) {
        const errBody = await initRes.text();
        throw new Error(`Drive upload initiation failed (${initRes.status}): ${errBody}`);
      }

      const uploadLocation = initRes.headers.get('location');
      if (!uploadLocation) {
        throw new Error('Google Drive did not return a resumable upload session URI.');
      }

      // Stream file directly from disk to Drive resumable session
      const fileStream = fs.createReadStream(filePath);
      const webStream = Readable.toWeb(fileStream) as unknown as BodyInit;
      const uploadInit: RequestInit & { duplex: 'half' } = {
        method: 'PUT',
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(stat.size),
        },
        duplex: 'half',
        body: webStream,
      };
      const uploadRes = await fetch(uploadLocation, uploadInit);

      if (!uploadRes.ok) {
        const errBody = await uploadRes.text();
        throw new Error(`Drive file upload failed (${uploadRes.status}): ${errBody}`);
      }

      const uploadedFile = (await uploadRes.json()) as { id: string; modifiedTime?: string };
      job.syncedDriveFileId = uploadedFile.id;
      job.syncedAt = uploadedFile.modifiedTime || new Date().toISOString();
      persistJob(job);

      res.json({ driveFile: uploadedFile, job: serializeJob(job) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Google Drive sync failed.' });
    }
  });

  app.delete('/api/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    jobs.delete(req.params.id);
    fs.rmSync(job.jobDir, { recursive: true, force: true });
    res.json({ ok: true });
  });

  // Multer error handler
  app.use((err: unknown, _req: Request, res: Response, next: express.NextFunction) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.message });
    }
    if (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' });
    }
    next();
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: 'spa',
    });
    app.get('/@vite/client', async (_req, res, next) => {
      try {
        const result = await vite.transformRequest('/@vite/client');
        if (!result) return next();
        const patched = result.code.replace(
          'transport.connect(createHMRHandler(handleMessage));',
          '/* HMR disabled in preview environment */'
        );
        res.setHeader('Content-Type', 'application/javascript');
        res.send(patched);
      } catch (err) {
        next(err);
      }
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ClearCast Studio server listening on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
