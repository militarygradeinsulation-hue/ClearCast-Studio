# ClearCast Studio Processor Deployment

The Creative Studio frontend cannot execute FFmpeg, RNNoise or Gemini natively. Run this repository as a separate HTTPS service (Docker / Cloud Run / Render / Railway / Fly), and set the Creative Studio server's **CLEARCAST_PROCESSOR_URL** to the actual processor origin.

## Required runtime
- FFmpeg available from the host OS or packaged dependencies; FFprobe is optional because the server can read media metadata with FFmpeg
- Node-compatible Bun runtime
- Network access to private Supabase signed URLs
- Persistent or sufficiently large temporary storage for recordings, processed WAV files, and previews (the app currently writes under /tmp/clearcast-studio)
- HTTPS reverse proxy to the port set in the `PORT` environment variable (defaults to 3000)
- The model files at models/*.rnnn (included here)

## Environment variables
- `CLEARCAST_PROCESSOR_URL` (on the Creative Studio server): deployed HTTPS processor origin. **Do not set this to the frontend URL unless it runs this Express processor.**
- `CLEARCAST_PROCESSOR_KEY` (on both Creative Studio server and processor): a strong matching secret to protect private media publish operations.
- `CLEARCAST_STORAGE_HOST` (on the processor, if needed): exact hostname for the private Supabase storage origin when it is not a `.supabase.co` host.
- `GEMINI_API_KEY` (on processor): necessary for optional AI voice analysis and synthesis. Fast Voice Clean does not use Gemini.
- `FFMPEG_PATH` / `FFPROBE_PATH` (optional): full paths to media tools. If omitted, the app prefers system tools, then platform binaries from the installed dependencies. If FFprobe is missing, it uses FFmpeg metadata extraction.
- `PORT`: listener port, assigned by your hosting provider or 3000 by default.
- Any Google and Firebase variables required by the existing app should stay on the server.

The project currently offers processor routes directly. Keep the processor behind authenticated networking or strengthen the API authorization before opening it to arbitrary untrusted clients.

## Health and smoke test
```bash
docker build -t clearcast-processor .
docker run --rm -p 3000:3000 --env-file .env clearcast-processor
curl --fail http://localhost:3000/api/health
node scripts/smoke-clean.mjs
```
The smoke test uploads generated noisy audio, runs Clean, polls for completion, and exports a 48 kHz 24-bit WAV file.

This repository has GitHub Actions coverage for TypeScript, production build and the audio smoke test. A passing local or CI test is not proof of the remote HTTPS deployment.

## Verify a deployment actually has working audio

Visit `<processor-origin>/api/health`. A functional backend reports `ffmpegAvailable: true` and `ok: true`. If FFprobe is missing, `metadataProbe` should be `ffmpeg-fallback`; that is supported. Then upload a real test recording and press Clean. If the host cannot execute FFmpeg, point the studio to a deployed Docker processor, not its own UI origin.

## Railway deployment for ClearCast Creative Studio

1. Connect your Railway account and create a service from `militarygradeinsulation-hue/ClearCast-Studio`, using the Dockerfile in this repo. `railway.toml` configures a single instance and `/api/health` checks.
2. Set `CLEARCAST_PROCESSOR_KEY` in Railway to a strong random value. Also set `GEMINI_API_KEY` only if you need optional AI voice analysis. The FFmpeg voice-cleaning preset works without Gemini.
3. In the **Lovable server environment** for `militarygradeinsulation-hue/clearcast-creative-studio`, set `CLEARCAST_PROCESSOR_URL=https://<your-service-domain>` and the **same** `CLEARCAST_PROCESSOR_KEY`. These are server secrets, never browser variables and never GitHub files.
4. Verify `/api/health` contains `ok:true` and `ffmpegAvailable:true`. Upload a short test recording from the Creative Studio, press Clean, confirm it reaches Ready and plays back, and then test a recording longer than 10 minutes.

If a private Supabase Storage domain differs from `.supabase.co`, set `CLEARCAST_STORAGE_HOST` to its exact hostname on Railway before publishing cleaned files to storage. For jobs up to 75 minutes, allocate enough CPU, RAM, storage, and request time; avoid multiple replicas until job media is moved to durable shared storage.

The hosted processor should not be public without access controls. `CLEARCAST_PROCESSOR_KEY` protects all non-health API endpoints when configured; production administrators must set it.
