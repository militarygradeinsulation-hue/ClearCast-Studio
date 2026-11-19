import { useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  Upload,
  Link as LinkIcon,
  HardDrive,
  Play,
  Download,
  CloudUpload,
  Trash2,
  Loader2,
  Check,
  AlertCircle,
  FileAudio,
  FileVideo,
  Sparkles,
} from 'lucide-react';
import {
  BUILT_IN_PRESETS,
  type AudioJob,
  type AudioPreset,
  type ChannelMode,
  type DriveMediaFile,
  type ExportFormat,
  type ExportSettings,
  type HighPassHz,
  type Mp3Bitrate,
  type ProcessingSettings,
  type SampleRate,
  type TargetLufs,
  type WavBitDepth,
} from './types/audio';
import {
  ensureSyncFolder,
  getCachedAccessToken,
  initGoogleAuth,
  loadSyncedPresets,
  saveSyncedPresets,
  signInWithGoogleDrive,
  signOutGoogle,
} from './lib/googleDrive';
import { formatBytes, formatDuration } from './lib/formatters';
import { GoogleSignInButton } from './components/GoogleSignInButton';
import { WaveformDeck } from './components/WaveformDeck';
import { DriveBrowserView } from './components/DriveBrowserView';
import { CloudSyncView } from './components/CloudSyncView';
import { PresetsView } from './components/PresetsView';

type ActiveTab = 'queue' | 'drive' | 'sync' | 'presets';

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('queue');

  // Google Auth & Drive Sync State
  const [googleUser, setGoogleUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [syncFolderId, setSyncFolderId] = useState<string | null>(null);
  const [autoSyncToDrive, setAutoSyncToDrive] = useState(false);
  const [cloudPresetsFileId, setCloudPresetsFileId] = useState<string | null>(null);
  const [isSyncingPresets, setIsSyncingPresets] = useState(false);

  // Studio Presets & Controls
  const [customPresets, setCustomPresets] = useState<AudioPreset[]>([]);
  const allPresets = useMemo(() => [...BUILT_IN_PRESETS, ...customPresets], [customPresets]);
  const [processingSettings, setProcessingSettings] = useState<ProcessingSettings>(
    BUILT_IN_PRESETS[0].processing
  );
  const [exportSettings, setExportSettings] = useState<ExportSettings>(BUILT_IN_PRESETS[0].export);

  // Jobs & Ingestion State
  const [jobs, setJobs] = useState<AudioJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgressPct, setUploadProgressPct] = useState<number | null>(null);
  const [linkInput, setLinkInput] = useState('');
  const [isImportingLink, setIsImportingLink] = useState(false);
  const [isImportingDrive, setIsImportingDrive] = useState(false);
  const [syncingJobIds, setSyncingJobIds] = useState<Set<string>>(new Set());
  const [bannerMessage, setBannerMessage] = useState<{
    type: 'error' | 'info' | 'success';
    text: string;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const autoSyncedTriggeredRef = useRef<Set<string>>(new Set());

  // Initialize Firebase Google Auth listener
  useEffect(() => {
    const unsubscribe = initGoogleAuth((user, token) => {
      setGoogleUser(user);
      setAccessToken(token);
      if (!user || !token) {
        setSyncFolderId(null);
        setCloudPresetsFileId(null);
      }
    });
    return () => unsubscribe();
  }, []);

  // Load initial queue from server
  const fetchJobs = async () => {
    try {
      const res = await fetch('/api/jobs');
      if (!res.ok) return;
      const data = (await res.json()) as { jobs: AudioJob[] };
      setJobs(data.jobs);
      setSelectedJobId((prev) => {
        if (prev && data.jobs.some((j) => j.id === prev)) return prev;
        return data.jobs[0]?.id ?? null;
      });
    } catch {
      // Ignore transient poll error
    }
  };

  useEffect(() => {
    void fetchJobs();
  }, []);

  // Poll live job progress while any track is active
  const hasActiveJobs = jobs.some(
    (j) => j.status === 'analyzing' || j.status === 'cleaning' || j.status === 'normalizing'
  );

  useEffect(() => {
    if (!hasActiveJobs) return;
    const timer = setInterval(() => {
      void fetchJobs();
    }, 1500);
    return () => clearInterval(timer);
  }, [hasActiveJobs]);

  // Auto-sync newly finished tracks if enabled and connected
  useEffect(() => {
    if (!autoSyncToDrive || !accessToken || !syncFolderId) return;
    for (const job of jobs) {
      if (
        job.status === 'ready' &&
        !job.syncedDriveFileId &&
        !autoSyncedTriggeredRef.current.has(job.id)
      ) {
        autoSyncedTriggeredRef.current.add(job.id);
        void handleSyncJobToDrive(job, exportSettings);
      }
    }
  }, [jobs, autoSyncToDrive, accessToken, syncFolderId]);

  const handleGoogleSignIn = async () => {
    setIsSigningIn(true);
    setBannerMessage(null);
    try {
      const { user, accessToken: token } = await signInWithGoogleDrive();
      setGoogleUser(user);
      setAccessToken(token);

      const folderId = await ensureSyncFolder(token);
      setSyncFolderId(folderId);

      const loaded = await loadSyncedPresets(token, folderId);
      setCloudPresetsFileId(loaded.fileId);
      if (loaded.presets.length > 0) {
        setCustomPresets(loaded.presets);
      }

      setBannerMessage({
        type: 'success',
        text: `Connected Google Drive for ${user.email || 'your account'}.`,
      });
    } catch (err) {
      setBannerMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Google Sign-In was cancelled or failed.',
      });
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleGoogleSignOut = async () => {
    await signOutGoogle();
    setGoogleUser(null);
    setAccessToken(null);
    setSyncFolderId(null);
    setCloudPresetsFileId(null);
    setAutoSyncToDrive(false);
    setBannerMessage({ type: 'info', text: 'Signed out of Google Drive.' });
  };

  const handleSessionExpired = () => {
    setAccessToken(null);
    setSyncFolderId(null);
    setBannerMessage({
      type: 'error',
      text: 'Google Drive session expired. Please sign in with Google again.',
    });
  };

  const uploadLocalFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    setIsUploading(true);
    setUploadProgressPct(0);
    setBannerMessage(null);

    const formData = new FormData();
    for (const f of files) {
      formData.append('files', f);
    }

    try {
      const result = await new Promise<{
        ok: boolean;
        jobs: AudioJob[];
        errors: Array<{ fileName: string; message: string }>;
        error?: string;
      }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload');
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) {
            setUploadProgressPct(Math.round((ev.loaded / ev.total) * 100));
          }
        };
        xhr.onload = () => {
          try {
            const parsed = JSON.parse(xhr.responseText);
            resolve({ ok: xhr.status >= 200 && xhr.status < 300, ...parsed });
          } catch {
            reject(new Error('Invalid server response during upload.'));
          }
        };
        xhr.onerror = () => reject(new Error('Network error while uploading files.'));
        xhr.send(formData);
      });

      if (result.jobs && result.jobs.length > 0) {
        setJobs((prev) => [...result.jobs, ...prev]);
        setSelectedJobId(result.jobs[0].id);
      }

      if (result.errors && result.errors.length > 0) {
        setBannerMessage({
          type: 'error',
          text: result.errors.map((e) => `${e.fileName}: ${e.message}`).join(' · '),
        });
      } else if (result.error) {
        setBannerMessage({ type: 'error', text: result.error });
      } else {
        setBannerMessage({
          type: 'success',
          text: `Added ${result.jobs.length} file${result.jobs.length === 1 ? '' : 's'} to the batch queue.`,
        });
      }
    } catch (err) {
      setBannerMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Upload failed.',
      });
    } finally {
      setIsUploading(false);
      setUploadProgressPct(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleImportFromLink = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = linkInput.trim();
    if (!trimmed) return;

    setIsImportingLink(true);
    setBannerMessage(null);
    try {
      const token = accessToken || getCachedAccessToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch('/api/import/url', {
        method: 'POST',
        headers,
        body: JSON.stringify({ url: trimmed }),
      });

      const data = (await res.json()) as { job?: AudioJob; error?: string };
      if (!res.ok || !data.job) {
        throw new Error(data.error || 'Could not import media from that URL.');
      }

      setJobs((prev) => [data.job!, ...prev]);
      setSelectedJobId(data.job.id);
      setLinkInput('');
      setBannerMessage({
        type: 'success',
        text: `Imported "${data.job.originalName}" into the batch queue.`,
      });
    } catch (err) {
      setBannerMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Link import failed.',
      });
    } finally {
      setIsImportingLink(false);
    }
  };

  const handleImportDriveFiles = async (selectedFiles: DriveMediaFile[]) => {
    const token = accessToken || getCachedAccessToken();
    if (!token || selectedFiles.length === 0) return;

    setIsImportingDrive(true);
    setBannerMessage(null);
    try {
      const res = await fetch('/api/import/drive', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          files: selectedFiles.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType })),
        }),
      });

      const data = (await res.json()) as {
        jobs?: AudioJob[];
        errors?: Array<{ fileName: string; message: string }>;
        error?: string;
      };

      if (data.jobs && data.jobs.length > 0) {
        setJobs((prev) => [...data.jobs!, ...prev]);
        setSelectedJobId(data.jobs[0].id);
        setActiveTab('queue');
      }

      if (data.errors && data.errors.length > 0) {
        setBannerMessage({
          type: 'error',
          text: data.errors.map((e) => `${e.fileName}: ${e.message}`).join(' · '),
        });
      } else if (!res.ok) {
        throw new Error(data.error || 'Google Drive import failed.');
      } else {
        setBannerMessage({
          type: 'success',
          text: `Imported ${data.jobs?.length ?? 0} file(s) from Google Drive.`,
        });
      }
    } catch (err) {
      setBannerMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Google Drive import failed.',
      });
    } finally {
      setIsImportingDrive(false);
    }
  };

  const handleProcessJob = async (job: AudioJob) => {
    setBannerMessage(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: processingSettings }),
      });
      const data = (await res.json()) as { job?: AudioJob; error?: string };
      if (!res.ok || !data.job) {
        throw new Error(data.error || 'Failed to start processing.');
      }
      setJobs((prev) => prev.map((j) => (j.id === job.id ? data.job! : j)));
      setSelectedJobId(job.id);
    } catch (err) {
      setBannerMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Could not process audio file.',
      });
    }
  };

  const handleProcessAllQueued = async () => {
    const candidates = jobs.filter((j) => j.status === 'queued' || j.status === 'error');
    if (candidates.length === 0) return;
    for (const job of candidates) {
      await handleProcessJob(job);
    }
  };

  const buildExportUrl = (job: AudioJob, settings: ExportSettings) => {
    const params = new URLSearchParams({
      format: settings.format,
      mp3Bitrate: String(settings.mp3Bitrate),
      wavBitDepth: String(settings.wavBitDepth),
      sampleRate: String(settings.sampleRate),
      channels: settings.channels,
    });
    return `/api/jobs/${job.id}/export?${params.toString()}`;
  };

  const handleDownloadJob = (job: AudioJob, settings: ExportSettings) => {
    const url = buildExportUrl(job, settings);
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const handleDownloadAllReady = () => {
    const readyJobs = jobs.filter((j) => j.status === 'ready');
    readyJobs.forEach((job, idx) => {
      setTimeout(() => handleDownloadJob(job, exportSettings), idx * 350);
    });
  };

  const handleSyncJobToDrive = async (job: AudioJob, settings: ExportSettings) => {
    const token = accessToken || getCachedAccessToken();
    if (!token) {
      setActiveTab('sync');
      setBannerMessage({
        type: 'info',
        text: 'Sign in with Google to sync cleaned masters to your Google Drive across devices.',
      });
      return;
    }

    let folderId = syncFolderId;
    if (!folderId) {
      folderId = await ensureSyncFolder(token);
      setSyncFolderId(folderId);
    }

    setSyncingJobIds((prev) => new Set(prev).add(job.id));
    try {
      const res = await fetch(`/api/jobs/${job.id}/sync-drive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ folderId, exportSettings: settings }),
      });

      const data = (await res.json()) as { job?: AudioJob; error?: string };
      if (!res.ok || !data.job) {
        throw new Error(data.error || 'Failed to upload master to Google Drive.');
      }

      setJobs((prev) => prev.map((j) => (j.id === job.id ? data.job! : j)));
      setBannerMessage({
        type: 'success',
        text: `Synced "${job.originalName}" to ClearCast Studio Sync in Google Drive.`,
      });
    } catch (err) {
      setBannerMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Cloud sync failed.',
      });
    } finally {
      setSyncingJobIds((prev) => {
        const next = new Set(prev);
        next.delete(job.id);
        return next;
      });
    }
  };

  const handleSyncAllReady = async () => {
    const readyJobs = jobs.filter((j) => j.status === 'ready' && !j.syncedDriveFileId);
    for (const job of readyJobs) {
      await handleSyncJobToDrive(job, exportSettings);
    }
  };

  const handleRemoveJob = async (jobId: string) => {
    try {
      await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
    } catch {
      // ignore
    }
    setJobs((prev) => {
      const remaining = prev.filter((j) => j.id !== jobId);
      if (selectedJobId === jobId) {
        setSelectedJobId(remaining[0]?.id ?? null);
      }
      return remaining;
    });
  };

  const handleApplyPreset = (preset: AudioPreset) => {
    setProcessingSettings({
      ...preset.processing,
      voiceClarity: preset.processing.voiceClarity ?? 78,
      voicePresenceLayer: preset.processing.voicePresenceLayer ?? 55,
      neuralDenoise: preset.processing.neuralDenoise ?? true,
      aiVoiceListener: preset.processing.aiVoiceListener ?? true,
    });
    setExportSettings({ ...preset.export });
    setBannerMessage({
      type: 'info',
      text: `Applied "${preset.name}" filter chain and export target.`,
    });
  };

  const handleSaveCustomPreset = (name: string, description: string) => {
    const id = `custom-${Date.now()}`;
    const nextPreset: AudioPreset = {
      id,
      name,
      description,
      isCustom: true,
      processing: { ...processingSettings, presetId: id, presetName: name },
      export: { ...exportSettings },
    };
    setCustomPresets((prev) => [...prev, nextPreset]);
    setProcessingSettings(nextPreset.processing);
    setBannerMessage({
      type: 'success',
      text: `Saved custom preset "${name}".`,
    });
  };

  const handleDeleteCustomPreset = (presetId: string) => {
    setCustomPresets((prev) => prev.filter((p) => p.id !== presetId));
  };

  const handleSyncPresetsToCloud = async () => {
    if (!accessToken) return;
    setIsSyncingPresets(true);
    try {
      const folderId = syncFolderId || (await ensureSyncFolder(accessToken));
      if (!syncFolderId) setSyncFolderId(folderId);
      const nextId = await saveSyncedPresets(
        accessToken,
        folderId,
        cloudPresetsFileId,
        customPresets
      );
      setCloudPresetsFileId(nextId);
      setBannerMessage({
        type: 'success',
        text: 'Custom presets synced to Google Drive across your devices.',
      });
    } catch (err) {
      setBannerMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to sync presets.',
      });
    } finally {
      setIsSyncingPresets(false);
    }
  };

  const selectedJob = jobs.find((j) => j.id === selectedJobId) || null;
  const queuedCount = jobs.filter((j) => j.status === 'queued' || j.status === 'error').length;
  const readyCount = jobs.filter((j) => j.status === 'ready').length;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Top Navigation Bar — 3-Zone Contract */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-xs">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-8 px-6 py-3.5">
          {/* Zone 1: Brand Title */}
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('queue');
            }}
            className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            ClearCast Studio
          </a>

          {/* Zone 2: Clean Single-Line Nav Links */}
          <nav className="hidden items-center gap-7 md:flex" aria-label="Primary sections">
            {(
              [
                { id: 'queue', label: 'Batch Queue' },
                { id: 'drive', label: 'Drive Import' },
                { id: 'sync', label: 'Cloud Sync' },
                { id: 'presets', label: 'Export Presets' },
              ] as const
            ).map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`border-b-2 py-1 text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                    active
                      ? 'border-blue-700 text-slate-900'
                      : 'border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          {/* Zone 3: Single Primary Account Action */}
          <div className="flex items-center gap-3 shrink-0">
            {googleUser && accessToken ? (
              <div className="flex items-center gap-3">
                <span className="hidden max-w-44 truncate text-xs font-medium text-slate-600 sm:inline">
                  {googleUser.email}
                </span>
                <button
                  type="button"
                  onClick={() => void handleGoogleSignOut()}
                  className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap shrink-0"
                >
                  Sign Out
                </button>
              </div>
            ) : (
              <GoogleSignInButton
                onClick={() => void handleGoogleSignIn()}
                disabled={isSigningIn}
                label={isSigningIn ? 'Connecting...' : 'Sign in with Google'}
              />
            )}
          </div>
        </div>

        {/* Mobile Tab Bar */}
        <div className="flex items-center gap-2 overflow-x-auto border-t border-slate-100 px-4 py-2 md:hidden">
          {(
            [
              { id: 'queue', label: 'Batch Queue' },
              { id: 'drive', label: 'Drive Import' },
              { id: 'sync', label: 'Cloud Sync' },
              { id: 'presets', label: 'Export Presets' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 ${
                activeTab === item.id
                  ? 'bg-blue-700 text-white'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      {/* Main Studio Workspace */}
      <div className="mx-auto grid max-w-[1440px] grid-cols-1 gap-8 px-6 py-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        {/* Left Control Sidebar */}
        <aside className="space-y-6">
          {/* Noise Reduction & Leveling Engine */}
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Cleanup &amp; Leveling</h2>
              <Sparkles className="h-4 w-4 text-blue-700" />
            </div>

            <div className="mt-4 space-y-4">
              <div>
                <label htmlFor="sidebar-preset" className="block text-xs font-medium text-slate-600">
                  Studio Profile
                </label>
                <select
                  id="sidebar-preset"
                  value={processingSettings.presetId}
                  onChange={(e) => {
                    const found = allPresets.find((p) => p.id === e.target.value);
                    if (found) handleApplyPreset(found);
                  }}
                  className="mt-1.5 h-9 w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-xs font-medium text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none"
                >
                  {allPresets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  {!allPresets.some((p) => p.id === processingSettings.presetId) && (
                    <option value={processingSettings.presetId}>Custom Studio Chain</option>
                  )}
                </select>
              </div>

              <div>
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="nr-range" className="font-medium text-slate-700">
                    Noise Reduction
                  </label>
                  <span className="font-mono font-medium tabular-nums text-slate-900">
                    {processingSettings.noiseReduction}%
                  </span>
                </div>
                <input
                  id="nr-range"
                  type="range"
                  min={0}
                  max={100}
                  value={processingSettings.noiseReduction}
                  onChange={(e) =>
                    setProcessingSettings((prev) => ({
                      ...prev,
                      presetId: 'custom',
                      presetName: 'Custom Studio Chain',
                      noiseReduction: Number(e.target.value),
                    }))
                  }
                  className="studio-range mt-2 w-full"
                />
              </div>

              <div>
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="clarity-range" className="font-medium text-slate-700">
                    Voice Clarity (De-Muffle)
                  </label>
                  <span className="font-mono font-medium tabular-nums text-slate-900">
                    {processingSettings.voiceClarity}%
                  </span>
                </div>
                <input
                  id="clarity-range"
                  type="range"
                  min={0}
                  max={100}
                  value={processingSettings.voiceClarity}
                  onChange={(e) =>
                    setProcessingSettings((prev) => ({
                      ...prev,
                      presetId: 'custom',
                      presetName: 'Custom Studio Chain',
                      voiceClarity: Number(e.target.value),
                    }))
                  }
                  className="studio-range mt-2 w-full"
                />
              </div>

              <div>
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="presence-layer-range" className="font-medium text-slate-700">
                    Vocal Articulation Layer
                  </label>
                  <span className="font-mono font-medium tabular-nums text-slate-900">
                    {processingSettings.voicePresenceLayer}%
                  </span>
                </div>
                <input
                  id="presence-layer-range"
                  type="range"
                  min={0}
                  max={100}
                  value={processingSettings.voicePresenceLayer}
                  onChange={(e) =>
                    setProcessingSettings((prev) => ({
                      ...prev,
                      presetId: 'custom',
                      presetName: 'Custom Studio Chain',
                      voicePresenceLayer: Number(e.target.value),
                    }))
                  }
                  className="studio-range mt-2 w-full"
                />
              </div>

              <div>
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="lvl-range" className="font-medium text-slate-700">
                    Auto-Leveling
                  </label>
                  <span className="font-mono font-medium tabular-nums text-slate-900">
                    {processingSettings.leveling}%
                  </span>
                </div>
                <input
                  id="lvl-range"
                  type="range"
                  min={0}
                  max={100}
                  value={processingSettings.leveling}
                  onChange={(e) =>
                    setProcessingSettings((prev) => ({
                      ...prev,
                      presetId: 'custom',
                      presetName: 'Custom Studio Chain',
                      leveling: Number(e.target.value),
                    }))
                  }
                  className="studio-range mt-2 w-full"
                />
              </div>

              <div>
                <span className="block text-xs font-medium text-slate-700">
                  Broadcast Target (LUFS)
                </span>
                <div className="mt-1.5 grid grid-cols-4 gap-1 rounded-lg bg-slate-100 p-1">
                  {([-14, -16, -19, -23] as TargetLufs[]).map((lufs) => (
                    <button
                      key={lufs}
                      type="button"
                      onClick={() =>
                        setProcessingSettings((prev) => ({
                          ...prev,
                          presetId: 'custom',
                          presetName: 'Custom Studio Chain',
                          targetLufs: lufs,
                        }))
                      }
                      className={`rounded-md py-1 font-mono text-xs font-medium tabular-nums transition-colors ${
                        processingSettings.targetLufs === lufs
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {lufs}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className="block text-xs font-medium text-slate-700">
                  High-Pass Rumble Cut
                </span>
                <div className="mt-1.5 grid grid-cols-4 gap-1 rounded-lg bg-slate-100 p-1">
                  {([0, 60, 80, 110] as HighPassHz[]).map((hz) => (
                    <button
                      key={hz}
                      type="button"
                      onClick={() =>
                        setProcessingSettings((prev) => ({
                          ...prev,
                          presetId: 'custom',
                          presetName: 'Custom Studio Chain',
                          highPassHz: hz,
                        }))
                      }
                      className={`rounded-md py-1 font-mono text-xs font-medium tabular-nums transition-colors ${
                        processingSettings.highPassHz === hz
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {hz === 0 ? 'Off' : `${hz}Hz`}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2.5 border-t border-slate-100 pt-3">
                <label className="flex cursor-pointer items-center justify-between text-xs text-slate-700">
                  <span>AI Voice Listener (Custom EQ)</span>
                  <input
                    type="checkbox"
                    checked={processingSettings.aiVoiceListener}
                    onChange={(e) =>
                      setProcessingSettings((prev) => ({
                        ...prev,
                        presetId: 'custom',
                        presetName: 'Custom Studio Chain',
                        aiVoiceListener: e.target.checked,
                      }))
                    }
                    className="h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                  />
                </label>

                <label className="flex cursor-pointer items-center justify-between text-xs text-slate-700">
                  <span>Neural Voice Isolation</span>
                  <input
                    type="checkbox"
                    checked={processingSettings.neuralDenoise}
                    onChange={(e) =>
                      setProcessingSettings((prev) => ({
                        ...prev,
                        presetId: 'custom',
                        presetName: 'Custom Studio Chain',
                        neuralDenoise: e.target.checked,
                      }))
                    }
                    className="h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                  />
                </label>

                <label className="flex cursor-pointer items-center justify-between text-xs text-slate-700">
                  <span>De-Esser (Sibilance)</span>
                  <input
                    type="checkbox"
                    checked={processingSettings.deEsser}
                    onChange={(e) =>
                      setProcessingSettings((prev) => ({
                        ...prev,
                        presetId: 'custom',
                        presetName: 'Custom Studio Chain',
                        deEsser: e.target.checked,
                      }))
                    }
                    className="h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                  />
                </label>

                <label className="flex cursor-pointer items-center justify-between text-xs text-slate-700">
                  <span>Click &amp; Pop Removal</span>
                  <input
                    type="checkbox"
                    checked={processingSettings.deClick}
                    onChange={(e) =>
                      setProcessingSettings((prev) => ({
                        ...prev,
                        presetId: 'custom',
                        presetName: 'Custom Studio Chain',
                        deClick: e.target.checked,
                      }))
                    }
                    className="h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                  />
                </label>
              </div>
            </div>
          </div>

          {/* Default Export Format & Bitrate */}
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">Export Format &amp; Bitrate</h2>

            <div className="mt-4 space-y-3.5">
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1">
                {(['wav', 'mp3'] as ExportFormat[]).map((fmt) => (
                  <button
                    key={fmt}
                    type="button"
                    onClick={() => setExportSettings((prev) => ({ ...prev, format: fmt }))}
                    className={`rounded-md py-1.5 font-mono text-xs font-semibold uppercase transition-colors ${
                      exportSettings.format === fmt
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {fmt}
                  </button>
                ))}
              </div>

              {exportSettings.format === 'mp3' ? (
                <div>
                  <label htmlFor="sidebar-mp3-br" className="block text-xs font-medium text-slate-600">
                    MP3 Bitrate
                  </label>
                  <select
                    id="sidebar-mp3-br"
                    value={exportSettings.mp3Bitrate}
                    onChange={(e) =>
                      setExportSettings((prev) => ({
                        ...prev,
                        mp3Bitrate: Number(e.target.value) as Mp3Bitrate,
                      }))
                    }
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 font-mono text-xs text-slate-900"
                  >
                    <option value={128}>128 kbps (Standard Speech)</option>
                    <option value={192}>192 kbps (Podcast Stereo)</option>
                    <option value={256}>256 kbps (High Fidelity)</option>
                    <option value={320}>320 kbps (Archival MP3)</option>
                  </select>
                </div>
              ) : (
                <div>
                  <label htmlFor="sidebar-wav-bd" className="block text-xs font-medium text-slate-600">
                    WAV Resolution
                  </label>
                  <select
                    id="sidebar-wav-bd"
                    value={exportSettings.wavBitDepth}
                    onChange={(e) =>
                      setExportSettings((prev) => ({
                        ...prev,
                        wavBitDepth: Number(e.target.value) as WavBitDepth,
                      }))
                    }
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 font-mono text-xs text-slate-900"
                  >
                    <option value={16}>16-bit PCM (CD Quality)</option>
                    <option value={24}>24-bit PCM (Broadcast)</option>
                    <option value={32}>32-bit Float (Mastering)</option>
                  </select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label htmlFor="sidebar-sr" className="block text-xs font-medium text-slate-600">
                    Sample Rate
                  </label>
                  <select
                    id="sidebar-sr"
                    value={exportSettings.sampleRate}
                    onChange={(e) =>
                      setExportSettings((prev) => ({
                        ...prev,
                        sampleRate: Number(e.target.value) as SampleRate,
                      }))
                    }
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-slate-50 px-2 font-mono text-xs text-slate-900"
                  >
                    <option value={44100}>44.1 kHz</option>
                    <option value={48000}>48.0 kHz</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="sidebar-ch" className="block text-xs font-medium text-slate-600">
                    Channels
                  </label>
                  <select
                    id="sidebar-ch"
                    value={exportSettings.channels}
                    onChange={(e) =>
                      setExportSettings((prev) => ({
                        ...prev,
                        channels: e.target.value as ChannelMode,
                      }))
                    }
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-slate-50 px-2 text-xs text-slate-900"
                  >
                    <option value="original">Original</option>
                    <option value="stereo">Stereo</option>
                    <option value="mono">Mono</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* Cloud Sync Automation */}
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">Cloud Storage Sync</h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              Automatically save cleaned masters to your Google Drive sync folder for access on any
              device.
            </p>
            <label className="mt-3 flex cursor-pointer items-center justify-between gap-3 text-xs font-medium text-slate-800">
              <span>Auto-sync finished tracks</span>
              <input
                type="checkbox"
                checked={autoSyncToDrive}
                onChange={(e) => {
                  const want = e.target.checked;
                  if (want && !accessToken) {
                    void handleGoogleSignIn().then(() => setAutoSyncToDrive(true));
                  } else {
                    setAutoSyncToDrive(want);
                  }
                }}
                className="h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
              />
            </label>
          </div>
        </aside>

        {/* Main Viewport */}
        <main className="min-w-0 space-y-6">
          {bannerMessage && (
            <div
              className={`flex items-center justify-between gap-4 rounded-xl border px-4 py-3 text-sm ${
                bannerMessage.type === 'error'
                  ? 'border-red-200 bg-red-50 text-red-800'
                  : bannerMessage.type === 'success'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                  : 'border-blue-200 bg-blue-50 text-blue-900'
              }`}
            >
              <div className="flex items-center gap-2.5">
                {bannerMessage.type === 'error' && <AlertCircle className="h-4 w-4 shrink-0" />}
                {bannerMessage.type === 'success' && <Check className="h-4 w-4 shrink-0" />}
                <span>{bannerMessage.text}</span>
              </div>
              <button
                type="button"
                onClick={() => setBannerMessage(null)}
                className="text-xs font-medium underline underline-offset-2 shrink-0"
              >
                Dismiss
              </button>
            </div>
          )}

          {activeTab === 'queue' && (
            <>
              {/* Batch Dropzone + Link & Drive Ingestion */}
              <section className="rounded-xl border border-slate-200 bg-white p-6">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <h1 className="text-xl font-semibold tracking-tight text-slate-900 text-balance">
                      Broadcast Voice Cleanup &amp; Batch Mastering
                    </h1>
                    <p className="mt-1 text-sm text-slate-600">
                      Upload video or audio recordings up to 75 minutes, paste a media link, or
                      import from Google Drive.
                    </p>
                  </div>
                  <div className="font-mono text-xs tabular-nums text-slate-500">
                    Max length: 75:00 per file · WAV &amp; MP3 export
                  </div>
                </div>

                {/* Drag & Drop Target */}
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDraggingOver(true);
                  }}
                  onDragLeave={() => setIsDraggingOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setIsDraggingOver(false);
                    if (e.dataTransfer.files?.length) {
                      void uploadLocalFiles(e.dataTransfer.files);
                    }
                  }}
                  onClick={() => fileInputRef.current?.click()}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      fileInputRef.current?.click();
                    }
                  }}
                  className={`mt-5 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors ${
                    isDraggingOver
                      ? 'border-blue-600 bg-blue-50/70'
                      : 'border-slate-300 bg-slate-50/70 hover:border-slate-400 hover:bg-slate-50'
                  }`}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="audio/*,video/*,.mp4,.mov,.mkv,.webm,.avi,.wav,.mp3,.m4a,.flac,.ogg,.aac"
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files?.length) {
                        void uploadLocalFiles(e.target.files);
                      }
                    }}
                  />

                  <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700">
                    {isUploading ? (
                      <Loader2 className="h-5 w-5 animate-spin text-blue-700" />
                    ) : (
                      <Upload className="h-5 w-5" />
                    )}
                  </div>

                  <div className="mt-3 text-sm font-medium text-slate-900">
                    {isUploading
                      ? `Uploading batch files (${uploadProgressPct ?? 0}%)...`
                      : 'Drag & drop audio or video files here, or click to browse'}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    Supports MP4, MOV, MKV, WebM, WAV, MP3, M4A, FLAC, OGG, AAC · Up to 75 minutes
                    (1:15:00) per file
                  </div>
                </div>

                {/* Link Paste + Google Drive Import Row */}
                <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                  <form onSubmit={handleImportFromLink} className="flex flex-1 gap-2">
                    <div className="relative flex-1">
                      <LinkIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <input
                        type="url"
                        value={linkInput}
                        onChange={(e) => setLinkInput(e.target.value)}
                        placeholder="Paste direct audio/video URL or Google Drive file link..."
                        className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50 pr-3 pl-9 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:bg-white focus:outline-none"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={isImportingLink || !linkInput.trim()}
                      className="h-10 rounded-lg border border-slate-200 bg-white px-4 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50 disabled:opacity-45 whitespace-nowrap shrink-0"
                    >
                      {isImportingLink ? 'Fetching...' : 'Import Link'}
                    </button>
                  </form>

                  <button
                    type="button"
                    onClick={() => setActiveTab('drive')}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50 whitespace-nowrap shrink-0"
                  >
                    <HardDrive className="h-4 w-4 text-blue-700" />
                    <span>Browse Google Drive</span>
                  </button>
                </div>
              </section>

              {/* Batch Processing Queue Table */}
              <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
                  <div className="flex items-center gap-3">
                    <h2 className="text-base font-semibold text-slate-900">Batch Queue</h2>
                    <span className="font-mono text-xs tabular-nums text-slate-500">
                      {jobs.length} {jobs.length === 1 ? 'track' : 'tracks'} · {readyCount} ready
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5">
                    <button
                      type="button"
                      disabled={queuedCount === 0}
                      onClick={() => void handleProcessAllQueued()}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-45 whitespace-nowrap shrink-0"
                    >
                      <Play className="h-3.5 w-3.5" />
                      <span>Clean All Queued ({queuedCount})</span>
                    </button>

                    <button
                      type="button"
                      disabled={readyCount === 0}
                      onClick={handleDownloadAllReady}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45 whitespace-nowrap shrink-0"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Download Ready ({readyCount})</span>
                    </button>

                    <button
                      type="button"
                      disabled={readyCount === 0}
                      onClick={() => void handleSyncAllReady()}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45 whitespace-nowrap shrink-0"
                    >
                      <CloudUpload className="h-3.5 w-3.5" />
                      <span>Sync All to Drive</span>
                    </button>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                        <th className="px-6 py-3">Track</th>
                        <th className="px-4 py-3 text-right">Duration</th>
                        <th className="px-4 py-3 text-right">Loudness (In → Out)</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-6 py-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {jobs.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-6 py-10 text-center text-sm text-slate-500">
                            No files in queue yet. Drop audio or video recordings above to begin
                            batch noise removal and loudness leveling.
                          </td>
                        </tr>
                      ) : (
                        jobs.map((job) => {
                          const isSelected = job.id === selectedJob?.id;
                          const isProcessing =
                            job.status === 'analyzing' ||
                            job.status === 'cleaning' ||
                            job.status === 'normalizing';
                          const isSyncing = syncingJobIds.has(job.id);

                          return (
                            <tr
                              key={job.id}
                              onClick={() => setSelectedJobId(job.id)}
                              className={`cursor-pointer transition-colors ${
                                isSelected ? 'bg-blue-50/50' : 'hover:bg-slate-50'
                              }`}
                            >
                              <td className="px-6 py-3">
                                <div className="flex items-center gap-3">
                                  {job.hasVideo ? (
                                    <FileVideo className="h-4 w-4 shrink-0 text-slate-400" />
                                  ) : (
                                    <FileAudio className="h-4 w-4 shrink-0 text-slate-400" />
                                  )}
                                  <div className="min-w-0">
                                    <div className="max-w-xs truncate font-medium text-slate-900">
                                      {job.originalName}
                                    </div>
                                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500">
                                      <span className="capitalize">{job.source}</span>
                                      <span aria-hidden="true">·</span>
                                      <span className="font-mono uppercase">{job.inputCodec}</span>
                                      <span aria-hidden="true">·</span>
                                      <span className="font-mono tabular-nums">
                                        {formatBytes(job.fileSizeBytes)}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              </td>

                              <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-slate-700">
                                {formatDuration(job.durationSeconds)}
                              </td>

                              <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-slate-700">
                                {job.telemetry?.inputLufs !== null &&
                                job.telemetry?.inputLufs !== undefined ? (
                                  <span>
                                    {job.telemetry.inputLufs} →{' '}
                                    <span className="font-semibold text-emerald-700">
                                      {job.telemetry.outputLufs} LUFS
                                    </span>
                                  </span>
                                ) : (
                                  <span className="text-slate-400">—</span>
                                )}
                              </td>

                              <td className="px-4 py-3">
                                {job.status === 'ready' ? (
                                  <span className="text-xs font-medium text-emerald-700">
                                    Master Ready
                                  </span>
                                ) : job.status === 'error' ? (
                                  <span
                                    className="text-xs font-medium text-red-600"
                                    title={job.errorMessage}
                                  >
                                    Error: {job.errorMessage?.slice(0, 48) || 'Failed'}
                                  </span>
                                ) : isProcessing ? (
                                  <div className="w-40 space-y-1">
                                    <div className="flex items-center justify-between text-xs text-blue-700">
                                      <span className="truncate">{job.stageLabel}</span>
                                      <span className="font-mono tabular-nums">{job.progress}%</span>
                                    </div>
                                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                                      <div
                                        className="h-full bg-blue-600 transition-all duration-300"
                                        style={{ width: `${job.progress}%` }}
                                      />
                                    </div>
                                  </div>
                                ) : (
                                  <span className="text-xs text-slate-500">Queued</span>
                                )}
                              </td>

                              <td
                                className="px-6 py-3 text-right"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <div className="flex items-center justify-end gap-1.5">
                                  <button
                                    type="button"
                                    disabled={isProcessing}
                                    onClick={() => void handleProcessJob(job)}
                                    className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:border-blue-600 hover:text-blue-700 disabled:opacity-45 whitespace-nowrap shrink-0"
                                  >
                                    {job.status === 'ready' ? 'Re-clean' : 'Clean'}
                                  </button>

                                  <button
                                    type="button"
                                    disabled={job.status !== 'ready'}
                                    onClick={() => handleDownloadJob(job, exportSettings)}
                                    className="rounded-md border border-slate-200 bg-white p-1.5 text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-40"
                                    title={`Download ${exportSettings.format.toUpperCase()}`}
                                    aria-label={`Download ${job.originalName}`}
                                  >
                                    <Download className="h-3.5 w-3.5" />
                                  </button>

                                  <button
                                    type="button"
                                    disabled={job.status !== 'ready' || isSyncing}
                                    onClick={() => void handleSyncJobToDrive(job, exportSettings)}
                                    className="rounded-md border border-slate-200 bg-white p-1.5 text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-40"
                                    title="Sync to Google Drive"
                                    aria-label={`Sync ${job.originalName} to Google Drive`}
                                  >
                                    {isSyncing ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : job.syncedDriveFileId ? (
                                      <Check className="h-3.5 w-3.5 text-emerald-600" />
                                    ) : (
                                      <CloudUpload className="h-3.5 w-3.5" />
                                    )}
                                  </button>

                                  <button
                                    type="button"
                                    disabled={isProcessing}
                                    onClick={() => void handleRemoveJob(job.id)}
                                    className="rounded-md border border-slate-200 bg-white p-1.5 text-slate-400 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                                    title="Remove from queue"
                                    aria-label={`Remove ${job.originalName}`}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* Waveform & A/B Comparison Deck */}
              <WaveformDeck
                job={selectedJob}
                exportSettings={exportSettings}
                onExportSettingsChange={setExportSettings}
                onDownload={handleDownloadJob}
                onSyncToDrive={handleSyncJobToDrive}
                onProcessJob={(j) => void handleProcessJob(j)}
                onJobUpdated={(updated) =>
                  setJobs((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
                }
                isGoogleConnected={Boolean(accessToken)}
                isSyncing={selectedJob ? syncingJobIds.has(selectedJob.id) : false}
              />
            </>
          )}

          {activeTab === 'drive' && (
            <DriveBrowserView
              accessToken={accessToken}
              onSignIn={handleGoogleSignIn}
              isSigningIn={isSigningIn}
              onImportFiles={handleImportDriveFiles}
              isImporting={isImportingDrive}
              onSessionExpired={handleSessionExpired}
            />
          )}

          {activeTab === 'sync' && (
            <CloudSyncView
              accessToken={accessToken}
              syncFolderId={syncFolderId}
              onSignIn={handleGoogleSignIn}
              isSigningIn={isSigningIn}
              onReopenInStudio={(file) => handleImportDriveFiles([file])}
              onSessionExpired={handleSessionExpired}
            />
          )}

          {activeTab === 'presets' && (
            <PresetsView
              presets={allPresets}
              currentProcessing={processingSettings}
              currentExport={exportSettings}
              onApplyPreset={handleApplyPreset}
              onSaveCustomPreset={handleSaveCustomPreset}
              onDeleteCustomPreset={handleDeleteCustomPreset}
              isGoogleConnected={Boolean(accessToken)}
              hasExistingCloudPresets={Boolean(cloudPresetsFileId)}
              onSyncPresetsToCloud={handleSyncPresetsToCloud}
              isSyncingPresets={isSyncingPresets}
            />
          )}
        </main>
      </div>
    </div>
  );
}
