export type ExportFormat = 'wav' | 'mp3';
export type Mp3Bitrate = 128 | 192 | 256 | 320;
export type WavBitDepth = 16 | 24 | 32;
export type SampleRate = 44100 | 48000;
export type ChannelMode = 'original' | 'stereo' | 'mono';
export type TargetLufs = -14 | -16 | -19 | -23;
export type HighPassHz = 0 | 60 | 80 | 110;
export type GeminiVoiceName = 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr';
export type AiVoiceBlendMode = 'clarity-blend' | 'balanced-hybrid' | 'full-revoice';

export interface ProcessingSettings {
  presetId: string;
  presetName: string;
  noiseReduction: number; // 0 - 100
  voiceClarity: number; // 0 - 100 (de-muddle EQ + vocal presence + harmonic exciter)
  voicePresenceLayer: number; // 0 - 100 (parallel vocal consonant & formant reinforcement bus)
  leveling: number; // 0 - 100
  targetLufs: TargetLufs;
  highPassHz: HighPassHz;
  neuralDenoise: boolean; // RNNoise deep neural speech isolation
  aiVoiceListener: boolean; // Gemini listens to the speaker to tailor EQ & voice articulation
  deEsser: boolean;
  deClick: boolean;
}

export interface ExportSettings {
  format: ExportFormat;
  mp3Bitrate: Mp3Bitrate;
  wavBitDepth: WavBitDepth;
  sampleRate: SampleRate;
  channels: ChannelMode;
}

export interface AudioPreset {
  id: string;
  name: string;
  description: string;
  processing: ProcessingSettings;
  export: ExportSettings;
  isCustom?: boolean;
}

export type JobStatus =
  | 'queued'
  | 'analyzing'
  | 'cleaning'
  | 'normalizing'
  | 'ready'
  | 'error';

export type JobSource = 'upload' | 'drive' | 'url';

export interface AudioTelemetry {
  inputLufs: number | null;
  outputLufs: number | null;
  inputTruePeak: number | null;
  outputTruePeak: number | null;
  inputLra: number | null;
  outputLra: number | null;
  noiseReductionDb: number;
}

export interface AiSpeakerProfile {
  label: string;
  genderRegister: string;
  timbreDescription: string;
  matchedVoice: GeminiVoiceName;
  stylePrompt: string;
}

export interface AiDspTuning {
  warmthHz: number;
  warmthGainDb: number;
  mudCutHz: number;
  mudCutDb: number;
  boxyCutHz: number;
  boxyCutDb: number;
  presenceHz: number;
  presenceGainDb: number;
  consonantHz: number;
  consonantGainDb: number;
  exciterBoost: number;
}

export interface AiVoiceProfile {
  analyzedAt: string;
  summary: string;
  speakerCount: number;
  speakers: AiSpeakerProfile[];
  acoustics: {
    mufflingScore: number;
    noiseScore: number;
    reverbScore: number;
    consonantLossScore: number;
  };
  dspTuning: AiDspTuning;
}

export interface AiUtterance {
  speaker: string;
  text: string;
  clarifiedText: string;
}

export interface AiVoiceClip {
  id: string;
  startSec: number;
  durationSec: number;
  detectedLanguage: string;
  speakerCount: number;
  speakers: AiSpeakerProfile[];
  utterances: AiUtterance[];
  muffledWordsNote: string;
  blendMode: AiVoiceBlendMode;
  blendAmount: number; // 0 - 100
  hasSynthesizedVoice: boolean;
  appliedToMaster: boolean;
  updatedAt: string;
}

export interface AudioJob {
  id: string;
  originalName: string;
  source: JobSource;
  sourceDetail?: string;
  mimeType: string;
  fileSizeBytes: number;
  durationSeconds: number;
  inputCodec: string;
  inputSampleRate: number;
  inputChannels: number;
  hasVideo: boolean;
  status: JobStatus;
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
}

export interface DriveMediaFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  iconLink?: string;
  webViewLink?: string;
  appProperties?: Record<string, string>;
  description?: string;
}

export const BUILT_IN_PRESETS: AudioPreset[] = [
  {
    id: 'fast-voice-clean',
    name: 'Fast Voice Clean',
    description:
      'Quick voice cleanup without cloud AI analysis. Neural noise isolation, clear speech EQ and consistent -16 LUFS loudness.',
    processing: {
      presetId: 'fast-voice-clean',
      presetName: 'Fast Voice Clean',
      noiseReduction: 58,
      voiceClarity: 65,
      voicePresenceLayer: 38,
      leveling: 65,
      targetLufs: -16,
      highPassHz: 80,
      neuralDenoise: true,
      aiVoiceListener: false,
      deEsser: true,
      deClick: false,
    },
    export: {
      format: 'mp3',
      mp3Bitrate: 192,
      wavBitDepth: 24,
      sampleRate: 48000,
      channels: 'original',
    },
  },
  {
    id: 'podcast-broadcast',
    name: 'Podcast Voice',
    description:
      'AI voice listener + RNNoise isolation, speaker-tuned de-muddle EQ, parallel vocal articulation layer, noise-gated leveling, and -16 LUFS loudness.',
    processing: {
      presetId: 'podcast-broadcast',
      presetName: 'Podcast Voice',
      noiseReduction: 82,
      voiceClarity: 78,
      voicePresenceLayer: 55,
      leveling: 72,
      targetLufs: -16,
      highPassHz: 80,
      neuralDenoise: true,
      aiVoiceListener: true,
      deEsser: true,
      deClick: false,
    },
    export: {
      format: 'mp3',
      mp3Bitrate: 192,
      wavBitDepth: 24,
      sampleRate: 48000,
      channels: 'stereo',
    },
  },
  {
    id: 'studio-light',
    name: 'Studio Clean',
    description:
      'Natural neural noise floor cleanup, AI-guided light de-muddying, subtle consonant polish, and transparent dynamic leveling.',
    processing: {
      presetId: 'studio-light',
      presetName: 'Studio Clean',
      noiseReduction: 48,
      voiceClarity: 45,
      voicePresenceLayer: 30,
      leveling: 50,
      targetLufs: -16,
      highPassHz: 60,
      neuralDenoise: true,
      aiVoiceListener: true,
      deEsser: false,
      deClick: false,
    },
    export: {
      format: 'wav',
      mp3Bitrate: 320,
      wavBitDepth: 24,
      sampleRate: 48000,
      channels: 'original',
    },
  },
  {
    id: 'field-recovery',
    name: 'Field & Muffled Recovery',
    description:
      'Maximum AI voice listening, deep neural isolation, aggressive de-muddying, strong consonant articulation layer, and bandwidth restoration.',
    processing: {
      presetId: 'field-recovery',
      presetName: 'Field & Muffled Recovery',
      noiseReduction: 95,
      voiceClarity: 92,
      voicePresenceLayer: 80,
      leveling: 82,
      targetLufs: -16,
      highPassHz: 110,
      neuralDenoise: true,
      aiVoiceListener: true,
      deEsser: true,
      deClick: true,
    },
    export: {
      format: 'wav',
      mp3Bitrate: 256,
      wavBitDepth: 24,
      sampleRate: 48000,
      channels: 'mono',
    },
  },
  {
    id: 'ebu-broadcast',
    name: 'Broadcast EBU R128',
    description:
      'Strict -23 LUFS television and radio broadcast compliance with AI voice listener, crisp vocal articulation, and controlled peak ceiling.',
    processing: {
      presetId: 'ebu-broadcast',
      presetName: 'Broadcast EBU R128',
      noiseReduction: 75,
      voiceClarity: 68,
      voicePresenceLayer: 45,
      leveling: 75,
      targetLufs: -23,
      highPassHz: 80,
      neuralDenoise: true,
      aiVoiceListener: true,
      deEsser: true,
      deClick: false,
    },
    export: {
      format: 'wav',
      mp3Bitrate: 320,
      wavBitDepth: 24,
      sampleRate: 48000,
      channels: 'stereo',
    },
  },
];

export const MAX_DURATION_SECONDS = 4500; // 75 minutes max
