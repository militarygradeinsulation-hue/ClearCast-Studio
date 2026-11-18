import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

export type GeminiVoiceName = 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr';

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

export interface AiSegmentAnalysis {
  detectedLanguage: string;
  speakerCount: number;
  speakers: AiSpeakerProfile[];
  utterances: AiUtterance[];
  muffledWordsNote: string;
}

const VALID_VOICES: GeminiVoiceName[] = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'];

function normalizeVoiceName(name: unknown): GeminiVoiceName {
  if (typeof name === 'string' && VALID_VOICES.includes(name as GeminiVoiceName)) {
    return name as GeminiVoiceName;
  }
  return 'Charon';
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Gemini API key is not configured. Check your API key in Settings > Secrets to use AI voice listening and matched-voice enhancement.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function isQuotaOrRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('RESOURCE_EXHAUSTED') || msg.includes('429') || msg.includes('503');
}

function formatGeminiError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[ClearCast GeminiAudio]', message.slice(0, 400));
  if (message.includes('API_KEY_INVALID') || message.includes('403') || message.includes('PERMISSION_DENIED')) {
    return new Error(
      'Gemini API key permission error. Please check your API key in Settings > Secrets.'
    );
  }
  if (message.includes('RESOURCE_EXHAUSTED') || message.includes('429')) {
    return new Error(
      'Gemini API quota limit reached for your current API key tier. You can wait a moment and retry, or select a billing-enabled key in Settings > Secrets.'
    );
  }
  return err instanceof Error ? err : new Error(message);
}

async function withModelFallback<T>(
  attempts: Array<{ name: string; run: () => Promise<T> }>
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    try {
      return await attempt.run();
    } catch (err) {
      lastErr = err;
      if (isQuotaOrRateLimitError(err) && i < attempts.length - 1) {
        await new Promise((r) => setTimeout(r, 900 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Listens to a representative audio sample of the track using Gemini multimodal audio
 * and produces a speaker-specific vocal profile + targeted broadcast EQ/articulation parameters.
 */
export async function listenAndProfileVoice(audioMp3Buffer: Buffer): Promise<AiVoiceProfile> {
  const ai = getGeminiClient();
  const base64Audio = audioMp3Buffer.toString('base64');

  const promptText = [
    'Listen carefully to the human voice(s) in this audio recording as a senior broadcast mastering engineer.',
    'Diagnose muffling, low-mid muddiness, boxiness, room noise/reverb, and missing consonant clarity (t, s, k, p, ch, f).',
    'Identify the speaker count (1 or 2), each speaker vocal register/timbre, and the closest prebuilt voice persona:',
    '- Charon: deep, warm, grounded male voice',
    '- Fenrir: resonant, articulate, clear mid-low male voice',
    '- Puck: energetic, lighter mid-high male voice',
    '- Kore: warm, clear, professional female voice',
    '- Zephyr: bright, airy, conversational female voice',
    'Provide targeted parametric EQ & articulation frequencies specifically tuned to make THIS voice sound studio-close, crisp, and easy to understand without harshness:',
    '- warmthHz (105..180 Hz) & warmthGainDb (0..2.8 dB)',
    '- mudCutHz (190..360 Hz) & mudCutDb (-6.0..-0.5 dB)',
    '- boxyCutHz (420..700 Hz) & boxyCutDb (-3.8..0 dB)',
    '- presenceHz (2100..3400 Hz) & presenceGainDb (0.5..6.0 dB)',
    '- consonantHz (3600..5600 Hz) & consonantGainDb (0.5..5.2 dB)',
    '- exciterBoost (0..100, higher when recording sounds muffled, phone-like, or lacks high-frequency air).',
    'Keep the summary concise (1-2 clear sentences describing what you heard and how the tuning fixes it).',
  ].join('\n');

  const schema = {
    type: Type.OBJECT,
    properties: {
      summary: { type: Type.STRING },
      speakerCount: { type: Type.INTEGER },
      speakers: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            label: { type: Type.STRING },
            genderRegister: { type: Type.STRING },
            timbreDescription: { type: Type.STRING },
            matchedVoice: { type: Type.STRING },
            stylePrompt: { type: Type.STRING },
          },
        },
      },
      acoustics: {
        type: Type.OBJECT,
        properties: {
          mufflingScore: { type: Type.INTEGER },
          noiseScore: { type: Type.INTEGER },
          reverbScore: { type: Type.INTEGER },
          consonantLossScore: { type: Type.INTEGER },
        },
      },
      dspTuning: {
        type: Type.OBJECT,
        properties: {
          warmthHz: { type: Type.NUMBER },
          warmthGainDb: { type: Type.NUMBER },
          mudCutHz: { type: Type.NUMBER },
          mudCutDb: { type: Type.NUMBER },
          boxyCutHz: { type: Type.NUMBER },
          boxyCutDb: { type: Type.NUMBER },
          presenceHz: { type: Type.NUMBER },
          presenceGainDb: { type: Type.NUMBER },
          consonantHz: { type: Type.NUMBER },
          consonantGainDb: { type: Type.NUMBER },
          exciterBoost: { type: Type.NUMBER },
        },
      },
    },
  };

  try {
    const response = await withModelFallback([
      {
        name: 'gemini-4-hydrogen',
        run: () =>
          ai.models.generateContent({
            model: 'gemini-4-hydrogen',
            contents: {
              parts: [
                { inlineData: { mimeType: 'audio/mp3', data: base64Audio } },
                { text: promptText },
              ],
            },
            config: {
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              responseMimeType: 'application/json',
              responseSchema: schema,
            },
          }),
      },
      {
        name: 'gemini-3.1-flash-lite',
        run: () =>
          ai.models.generateContent({
            model: 'gemini-3.1-flash-lite',
            contents: {
              parts: [
                { inlineData: { mimeType: 'audio/mp3', data: base64Audio } },
                { text: promptText },
              ],
            },
            config: {
              thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
              responseMimeType: 'application/json',
              responseSchema: schema,
            },
          }),
      },
    ]);

    const raw = JSON.parse((response.text ?? '{}').trim());
    const rawSpeakers =
      Array.isArray(raw.speakers) && raw.speakers.length > 0
        ? raw.speakers.slice(0, 2)
        : [
            {
              label: 'Speaker 1',
              genderRegister: 'Natural spoken voice',
              timbreDescription: 'Conversational studio voice',
              matchedVoice: 'Charon',
              stylePrompt: 'Clear, natural, articulate studio host matching original conversational pace',
            },
          ];

    const speakers: AiSpeakerProfile[] = rawSpeakers.map((sp: Record<string, unknown>, idx: number) => ({
      label: String(sp.label || `Speaker ${idx + 1}`).trim(),
      genderRegister: String(sp.genderRegister || 'Spoken voice').trim(),
      timbreDescription: String(sp.timbreDescription || 'Conversational tone').trim(),
      matchedVoice: normalizeVoiceName(sp.matchedVoice),
      stylePrompt: String(
        sp.stylePrompt || 'Clear, crisp, natural studio articulation matching the original speaker'
      ).trim(),
    }));

    const acoustics = raw.acoustics || {};
    const tuning = raw.dspTuning || {};

    return {
      analyzedAt: new Date().toISOString(),
      summary: String(
        raw.summary ||
          'Analyzed vocal register and consonant roll-off; applied custom formant EQ and harmonic articulation clarity.'
      ).trim(),
      speakerCount: Math.max(1, Math.min(2, Math.round(Number(raw.speakerCount) || speakers.length))),
      speakers,
      acoustics: {
        mufflingScore: Math.round(clamp(acoustics.mufflingScore, 0, 100, 65)),
        noiseScore: Math.round(clamp(acoustics.noiseScore, 0, 100, 55)),
        reverbScore: Math.round(clamp(acoustics.reverbScore, 0, 100, 35)),
        consonantLossScore: Math.round(clamp(acoustics.consonantLossScore, 0, 100, 65)),
      },
      dspTuning: {
        warmthHz: Math.round(clamp(tuning.warmthHz, 105, 180, 135)),
        warmthGainDb: Number(clamp(tuning.warmthGainDb, 0, 2.8, 1.4).toFixed(2)),
        mudCutHz: Math.round(clamp(tuning.mudCutHz, 190, 360, 250)),
        mudCutDb: Number(clamp(tuning.mudCutDb, -6.0, -0.5, -3.6).toFixed(2)),
        boxyCutHz: Math.round(clamp(tuning.boxyCutHz, 420, 700, 520)),
        boxyCutDb: Number(clamp(tuning.boxyCutDb, -3.8, 0, -1.8).toFixed(2)),
        presenceHz: Math.round(clamp(tuning.presenceHz, 2100, 3400, 2750)),
        presenceGainDb: Number(clamp(tuning.presenceGainDb, 0.5, 6.0, 3.8).toFixed(2)),
        consonantHz: Math.round(clamp(tuning.consonantHz, 3600, 5600, 4300)),
        consonantGainDb: Number(clamp(tuning.consonantGainDb, 0.5, 5.2, 3.2).toFixed(2)),
        exciterBoost: Math.round(clamp(tuning.exciterBoost, 0, 100, 72)),
      },
    };
  } catch (err) {
    throw formatGeminiError(err);
  }
}

/**
 * Listens to a specific audio segment (5s–60s), captures exact wording & speaker style,
 * and prepares speaker-matched Voice Design instructions so Gemini TTS can generate
 * a clean reinforcement voice layer that makes muffled words crisp and easy to hear.
 */
export async function listenAndTranscribeSegment(
  audioMp3Buffer: Buffer,
  durationSeconds: number
): Promise<AiSegmentAnalysis> {
  const ai = getGeminiClient();
  const base64Audio = audioMp3Buffer.toString('base64');

  const promptText = [
    `Listen very carefully to this ${durationSeconds.toFixed(1)}-second audio segment.`,
    'Your job is to transcribe the exact spoken wording and profile the speaker(s) so a matched studio voice can reinforce and clarify the muffled words.',
    'Rules:',
    '1. Detect whether there is 1 speaker or 2 speakers in this segment.',
    '2. For each speaker, choose the closest prebuilt voice (Charon=deep warm male, Fenrir=clear resonant male, Puck=lighter mid male, Kore=warm clear female, Zephyr=bright conversational female) and write a detailed stylePrompt describing their exact tone, pace, warmth, accent, and crisp diction.',
    '3. Break the spoken audio into sequential utterances in exact chronological order.',
    '4. "text" is the exact verbatim wording spoken.',
    '5. "clarifiedText" keeps the EXACT SAME words and meaning (do NOT invent new content or summarize), with clean punctuation and natural phrasing so every word is enunciated clearly.',
    '6. In "muffledWordsNote", briefly note any words or phrases that sounded muffled or noisy and will benefit from the voice clarity reinforcement layer.',
  ].join('\n');

  const schema = {
    type: Type.OBJECT,
    properties: {
      detectedLanguage: { type: Type.STRING },
      speakerCount: { type: Type.INTEGER },
      muffledWordsNote: { type: Type.STRING },
      speakers: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            label: { type: Type.STRING },
            genderRegister: { type: Type.STRING },
            timbreDescription: { type: Type.STRING },
            matchedVoice: { type: Type.STRING },
            stylePrompt: { type: Type.STRING },
          },
        },
      },
      utterances: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            speaker: { type: Type.STRING },
            text: { type: Type.STRING },
            clarifiedText: { type: Type.STRING },
          },
        },
      },
    },
  };

  try {
    const response = await withModelFallback([
      {
        name: 'gemini-4-hydrogen',
        run: () =>
          ai.models.generateContent({
            model: 'gemini-4-hydrogen',
            contents: {
              parts: [
                { inlineData: { mimeType: 'audio/mp3', data: base64Audio } },
                { text: promptText },
              ],
            },
            config: {
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              responseMimeType: 'application/json',
              responseSchema: schema,
            },
          }),
      },
      {
        name: 'gemini-3.1-flash-lite',
        run: () =>
          ai.models.generateContent({
            model: 'gemini-3.1-flash-lite',
            contents: {
              parts: [
                { inlineData: { mimeType: 'audio/mp3', data: base64Audio } },
                { text: promptText },
              ],
            },
            config: {
              thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
              responseMimeType: 'application/json',
              responseSchema: schema,
            },
          }),
      },
    ]);

    const raw = JSON.parse((response.text ?? '{}').trim());
    const rawSpeakers =
      Array.isArray(raw.speakers) && raw.speakers.length > 0
        ? raw.speakers.slice(0, 2)
        : [
            {
              label: 'Speaker 1',
              genderRegister: 'Spoken voice',
              timbreDescription: 'Natural podcast voice',
              matchedVoice: 'Charon',
              stylePrompt: 'Warm, articulate, close-mic studio voice matching the original cadence',
            },
          ];

    const speakers: AiSpeakerProfile[] = rawSpeakers.map((sp: Record<string, unknown>, idx: number) => ({
      label: String(sp.label || `Speaker ${idx + 1}`).trim(),
      genderRegister: String(sp.genderRegister || 'Spoken voice').trim(),
      timbreDescription: String(sp.timbreDescription || 'Natural conversational timbre').trim(),
      matchedVoice: normalizeVoiceName(sp.matchedVoice),
      stylePrompt: String(
        sp.stylePrompt || 'Articulate, natural broadcast voice matching the original speaker pace'
      ).trim(),
    }));

    const defaultSpeakerLabel = speakers[0].label;
    const rawUtterances = Array.isArray(raw.utterances) ? raw.utterances : [];
    const utterances: AiUtterance[] = rawUtterances
      .map((u: Record<string, unknown>) => {
        const text = String(u.text || '').trim();
        const clarifiedText = String(u.clarifiedText || text).trim();
        const speakerLabel = String(u.speaker || defaultSpeakerLabel).trim();
        const matched = speakers.find((s) => s.label.toLowerCase() === speakerLabel.toLowerCase());
        return {
          speaker: matched ? matched.label : defaultSpeakerLabel,
          text,
          clarifiedText,
        };
      })
      .filter((u: AiUtterance) => u.clarifiedText.length > 0);

    if (utterances.length === 0) {
      throw new Error(
        'No clear spoken words were detected in this audio window. Move the playhead to a section with speech and try again.'
      );
    }

    return {
      detectedLanguage: String(raw.detectedLanguage || 'English').trim(),
      speakerCount: speakers.length,
      speakers,
      utterances,
      muffledWordsNote: String(
        raw.muffledWordsNote ||
          'Captured speech phrasing and matched speaker timbre for consonant & word clarity reinforcement.'
      ).trim(),
    };
  } catch (err) {
    throw formatGeminiError(err);
  }
}

/**
 * Generates a matched studio-clarity voice WAV (24 kHz mono 16-bit) using Gemini 3.8 TTS
 * that mirrors the detected speaker(s)' tone, pace, and exact wording so it can be softly
 * blended into the original voice or used as a clean studio re-voice layer.
 */
export async function synthesizeMatchedVoiceLayer(params: {
  speakers: AiSpeakerProfile[];
  utterances: AiUtterance[];
}): Promise<Buffer> {
  const ai = getGeminiClient();
  const validUtterances = params.utterances.filter((u) => u.clarifiedText.trim().length > 0);
  if (validUtterances.length === 0) {
    throw new Error('At least one spoken line is required to generate the AI clarity voice layer.');
  }

  const speakers = params.speakers.slice(0, 2);
  const usedSpeakerLabels = new Set(validUtterances.map((u) => u.speaker));
  const useMultiSpeaker = speakers.length === 2 && usedSpeakerLabels.size === 2;

  try {
    if (useMultiSpeaker) {
      const sp1 = speakers[0];
      const sp2 = speakers[1];
      const parts = validUtterances.map((u) => {
        const sp = u.speaker === sp2.label ? sp2 : sp1;
        return {
          text: `${sp.label}: ${u.clarifiedText.trim()}`,
          speechMetadata: {
            speaker: sp.label,
            style: `${sp.stylePrompt}. Crisp, articulate, close-mic studio clarity, natural conversational cadence.`,
          },
        };
      });

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash-tts',
        contents: [{ role: 'user', parts }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            multiSpeakerVoiceConfig: {
              speakerVoiceConfigs: [
                {
                  speaker: sp1.label,
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: normalizeVoiceName(sp1.matchedVoice) },
                  },
                },
                {
                  speaker: sp2.label,
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: normalizeVoiceName(sp2.matchedVoice) },
                  },
                },
              ],
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) {
        throw new Error('Gemini TTS did not return audio data for the dual-speaker voice layer.');
      }
      return Buffer.from(base64Audio, 'base64');
    }

    // Single-speaker studio clarity voice (tries flagship Voice Design TTS first, falls back to Flash Lite TTS on 429)
    const primary = speakers[0] || {
      label: 'Speaker 1',
      genderRegister: 'Natural voice',
      timbreDescription: 'Warm broadcast voice',
      matchedVoice: 'Charon' as GeminiVoiceName,
      stylePrompt: 'Clear, natural, articulate broadcast voice',
    };
    const combinedText = validUtterances.map((u) => u.clarifiedText.trim()).join(' ');

    const runSingleSpeakerTts = (model: 'gemini-3.8-flash-tts' | 'gemini-3.8-flash-lite-tts') =>
      ai.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: combinedText,
                speechMetadata: {
                  style: `${primary.stylePrompt}. Close-mic studio voice with crisp consonant articulation and clear, easy-to-hear wording.`,
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: normalizeVoiceName(primary.matchedVoice) },
            },
          },
        },
      });

    const response = await withModelFallback([
      { name: 'gemini-3.8-flash-tts', run: () => runSingleSpeakerTts('gemini-3.8-flash-tts') },
      { name: 'gemini-3.8-flash-lite-tts', run: () => runSingleSpeakerTts('gemini-3.8-flash-lite-tts') },
    ]);

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) {
      throw new Error('Gemini TTS did not return audio data for the voice clarity layer.');
    }
    return Buffer.from(base64Audio, 'base64');
  } catch (err) {
    throw formatGeminiError(err);
  }
}
