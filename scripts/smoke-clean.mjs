import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const origin = process.env.CLEARCAST_TEST_URL || 'http://127.0.0.1:3000';
const audioPath = '/tmp/clearcast-smoke-input.wav';
const generated = spawnSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2.5',
  '-f', 'lavfi', '-i', 'anoisesrc=d=2.5:c=white:a=0.025:r=48000',
  '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=first:normalize=0[out]',
  '-map', '[out]', '-c:a', 'pcm_s16le', audioPath,
], { encoding: 'utf8' });
assert.equal(generated.status, 0, generated.stderr);

async function jsonResponse(res) {
  const body = await res.text();
  let data;
  try { data = JSON.parse(body); } catch { throw new Error('Expected JSON: ' + body.slice(0, 200)); }
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + JSON.stringify(data));
  return data;
}
const health = await jsonResponse(await fetch(origin + '/api/health'));
assert.equal(health.ffmpegAvailable, true);
assert.ok(health.ffprobeAvailable || health.metadataProbe === 'ffmpeg-fallback', 'No media metadata probe available');

const form = new FormData();
form.append('files', new Blob([readFileSync(audioPath)], { type: 'audio/wav' }), 'smoke-test.wav');
const { jobs } = await jsonResponse(await fetch(origin + '/api/upload', { method: 'POST', body: form }));
assert.equal(jobs.length, 1);
const jobId = jobs[0].id;

const settings = {
  presetId: 'fast-voice-clean', presetName: 'Fast Voice Clean',
  noiseReduction: 58, voiceClarity: 65, voicePresenceLayer: 38,
  leveling: 65, targetLufs: -16, highPassHz: 80,
  neuralDenoise: true, aiVoiceListener: false, deEsser: true, deClick: false,
};
await jsonResponse(await fetch(origin + '/api/jobs/' + jobId + '/process', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ settings }),
}));

let completed;
for (let attempt = 0; attempt < 90; attempt++) {
  const { job } = await jsonResponse(await fetch(origin + '/api/jobs/' + jobId));
  if (job.status === 'error') throw new Error('Clean failed: ' + job.errorMessage);
  if (job.status === 'ready') { completed = job; break; }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.ok(completed, 'Clean did not finish within 90 seconds');
assert.equal(completed.progress, 100);
assert.ok(completed.cleanedPeaks?.length > 0, 'Cleaned waveform missing');
assert.ok(Number.isFinite(completed.telemetry?.outputLufs), 'Loudness statistics missing');

const res = await fetch(origin + '/api/jobs/' + jobId + '/export?format=wav&wavBitDepth=24&sampleRate=48000&channels=original');
assert.equal(res.status, 200, 'WAV export failed');
const outPath = '/tmp/clearcast-smoke-export.wav';
const { writeFileSync } = await import('node:fs');
writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
assert.ok(statSync(outPath).size > 25000, 'WAV output is empty');
const probe = spawnSync('ffprobe', [
  '-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,duration',
  '-of', 'json', outPath,
], { encoding: 'utf8' });
assert.equal(probe.status, 0, probe.stderr);
const stream = JSON.parse(probe.stdout).streams?.[0];
assert.equal(stream?.codec_name, 'pcm_s24le');
assert.equal(Number(stream?.sample_rate), 48000);
console.log('PASS: upload > Clean > ready > waveform > WAV export; output LUFS', completed.telemetry.outputLufs);
