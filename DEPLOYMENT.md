# ClearCast Studio Processor Deployment

The Creative Studio frontend cannot execute FFmpeg, RNNoise or Gemini natively. Run this repository as a separate HTTPS service (Docker / Cloud Run / Render / Railway / Fly), and set the Creative Studio server's **CLEARCAST_PROCESSOR_URL** to the actual processor origin.

## Required runtime
- ffmpeg and ffprobe installed on PATH
- Node-compatible Bun runtime
- Network access to private Supabase signed URLs
- Persistent or sufficiently large temporary storage for recordings, processed WAV files, and previews (the app currently writes under /tmp/clearcast-studio)
- Port 3000 exposed through an HTTPS reverse proxy
- The model files at models/*.rnnn (included here)

## Environment variables
- `CLEARCAST_PROCESSOR_URL` (on the Creative Studio server): deployed HTTPS processor origin. **Do not set this to the frontend URL unless it runs this Express processor.**
- `CLEARCAST_PROCESSOR_KEY` (on both Creative Studio server and processor): a strong matching secret to protect private media publish operations.
- `CLEARCAST_STORAGE_HOST` (on the processor, if needed): exact hostname for the private Supabase storage origin when it is not a `.supabase.co` host.
- `GEMINI_API_KEY` (on processor): necessary for optional AI voice analysis and synthesis. Fast Voice Clean does not use Gemini.
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
