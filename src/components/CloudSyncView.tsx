import { useEffect, useRef, useState } from 'react';
import {
  Cloud,
  RefreshCw,
  Play,
  Pause,
  Download,
  Trash2,
  FolderUp,
  Loader2,
} from 'lucide-react';
import type { DriveMediaFile } from '../types/audio';
import {
  deleteDriveFile,
  fetchDriveFileBlob,
  listSyncedMasters,
  SYNC_FOLDER_NAME,
} from '../lib/googleDrive';
import { formatBytes, formatDuration, formatRelativeDate } from '../lib/formatters';
import { GoogleSignInButton } from './GoogleSignInButton';
import { ConfirmModal } from './ConfirmModal';

interface CloudSyncViewProps {
  accessToken: string | null;
  syncFolderId: string | null;
  onSignIn: () => Promise<void>;
  isSigningIn: boolean;
  onReopenInStudio: (file: DriveMediaFile) => Promise<void>;
  onSessionExpired: () => void;
}

export function CloudSyncView({
  accessToken,
  syncFolderId,
  onSignIn,
  isSigningIn,
  onReopenInStudio,
  onSessionExpired,
}: CloudSyncViewProps) {
  const [files, setFiles] = useState<DriveMediaFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadingAudioId, setLoadingAudioId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DriveMediaFile | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  const loadSynced = async () => {
    if (!accessToken || !syncFolderId) return;
    setLoading(true);
    setError(null);
    try {
      const list = await listSyncedMasters(accessToken, syncFolderId);
      setFiles(list);
    } catch (err) {
      if (err instanceof Error && err.message === 'SESSION_EXPIRED') {
        onSessionExpired();
        return;
      }
      setError(err instanceof Error ? err.message : 'Unable to load synced cloud files.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (accessToken && syncFolderId) {
      void loadSynced();
    }
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
      }
    };
  }, [accessToken, syncFolderId]);

  const handlePlayToggle = async (file: DriveMediaFile) => {
    if (!accessToken) return;
    const audio = audioRef.current;
    if (!audio) return;

    if (playingId === file.id) {
      audio.pause();
      setPlayingId(null);
      return;
    }

    setLoadingAudioId(file.id);
    setError(null);
    try {
      const blob = await fetchDriveFileBlob(accessToken, file.id);
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;
      audio.src = url;
      await audio.play();
      setPlayingId(file.id);
    } catch (err) {
      if (err instanceof Error && err.message === 'SESSION_EXPIRED') {
        onSessionExpired();
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to stream synced audio file.');
    } finally {
      setLoadingAudioId(null);
    }
  };

  const handleDownload = async (file: DriveMediaFile) => {
    if (!accessToken) return;
    try {
      const blob = await fetchDriveFileBlob(accessToken, file.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err) {
      if (err instanceof Error && err.message === 'SESSION_EXPIRED') {
        onSessionExpired();
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to download file from Drive.');
    }
  };

  const handleConfirmDelete = async () => {
    if (!accessToken || !pendingDelete) return;
    setIsDeleting(true);
    try {
      await deleteDriveFile(accessToken, pendingDelete.id);
      setFiles((prev) => prev.filter((f) => f.id !== pendingDelete.id));
      if (playingId === pendingDelete.id && audioRef.current) {
        audioRef.current.pause();
        setPlayingId(null);
      }
      setPendingDelete(null);
    } catch (err) {
      if (err instanceof Error && err.message === 'SESSION_EXPIRED') {
        onSessionExpired();
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not delete synced file.');
    } finally {
      setIsDeleting(false);
    }
  };

  if (!accessToken) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
          <Cloud className="h-6 w-6" />
        </div>
        <h2 className="mt-4 text-xl font-semibold text-slate-900">
          Cross-Device Cloud Storage Sync
        </h2>
        <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-slate-600">
          Sign in with Google to sync your cleaned WAV and MP3 masters plus custom presets into a
          dedicated <span className="font-medium text-slate-900">{SYNC_FOLDER_NAME}</span> folder in
          your Google Drive, accessible from any device.
        </p>
        <div className="mt-6 flex justify-center">
          <GoogleSignInButton
            onClick={() => void onSignIn()}
            disabled={isSigningIn}
            label={isSigningIn ? 'Connecting...' : 'Sign in with Google'}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <audio ref={audioRef} onEnded={() => setPlayingId(null)} className="hidden" />

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Cloud Synced Library</h2>
          <p className="mt-1 text-sm text-slate-600">
            Cleaned masters and broadcast exports stored in Google Drive folder{' '}
            <span className="font-medium text-slate-900">{SYNC_FOLDER_NAME}</span>.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadSynced()}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap shrink-0"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>Sync Refresh</span>
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                <th className="px-4 py-3">Master File</th>
                <th className="px-4 py-3">Spec</th>
                <th className="px-4 py-3 text-right">Duration</th>
                <th className="px-4 py-3 text-right">Loudness</th>
                <th className="px-4 py-3 text-right">Size</th>
                <th className="px-4 py-3 text-right">Synced</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                Array.from({ length: 4 }).map((_, idx) => (
                  <tr key={idx} className="h-12 animate-pulse">
                    <td className="px-4 py-3"><div className="h-4 w-56 rounded bg-slate-200" /></td>
                    <td className="px-4 py-3"><div className="h-4 w-24 rounded bg-slate-200" /></td>
                    <td className="px-4 py-3"><div className="ml-auto h-4 w-12 rounded bg-slate-200" /></td>
                    <td className="px-4 py-3"><div className="ml-auto h-4 w-16 rounded bg-slate-200" /></td>
                    <td className="px-4 py-3"><div className="ml-auto h-4 w-14 rounded bg-slate-200" /></td>
                    <td className="px-4 py-3"><div className="ml-auto h-4 w-24 rounded bg-slate-200" /></td>
                    <td className="px-4 py-3"><div className="ml-auto h-7 w-28 rounded bg-slate-200" /></td>
                  </tr>
                ))
              ) : files.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-sm text-slate-500">
                    No synced masters yet. Process a track in the Batch Queue and click{' '}
                    <span className="font-medium text-slate-900">Sync to Drive</span> to access it
                    from any device.
                  </td>
                </tr>
              ) : (
                files.map((file) => {
                  const props = file.appProperties || {};
                  const dur = props.durationSeconds ? formatDuration(Number(props.durationSeconds)) : '—';
                  const lufs = props.outputLufs ? `${props.outputLufs} LUFS` : '—';
                  const specParts = [
                    props.format?.toUpperCase(),
                    props.bitrate,
                    props.sampleRate ? `${Number(props.sampleRate) / 1000}kHz` : null,
                  ].filter(Boolean);

                  return (
                    <tr key={file.id} className="transition-colors hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <div className="max-w-xs truncate font-medium text-slate-900">{file.name}</div>
                        {props.presetName && (
                          <div className="mt-0.5 text-xs text-slate-500">{props.presetName}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-600">
                        {specParts.length > 0 ? specParts.join(' · ') : 'Audio Master'}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-slate-700">
                        {dur}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-emerald-700">
                        {lufs}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-slate-600">
                        {formatBytes(file.size)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-slate-500">
                        {formatRelativeDate(file.modifiedTime)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => void handlePlayToggle(file)}
                            disabled={loadingAudioId === file.id}
                            className="rounded-md border border-slate-200 bg-white p-1.5 text-slate-700 transition-colors hover:bg-slate-100"
                            title={playingId === file.id ? 'Pause' : 'Play preview'}
                            aria-label={`Play ${file.name}`}
                          >
                            {loadingAudioId === file.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : playingId === file.id ? (
                              <Pause className="h-3.5 w-3.5 text-blue-700" />
                            ) : (
                              <Play className="h-3.5 w-3.5" />
                            )}
                          </button>

                          <button
                            type="button"
                            onClick={() => void handleDownload(file)}
                            className="rounded-md border border-slate-200 bg-white p-1.5 text-slate-700 transition-colors hover:bg-slate-100"
                            title="Download file"
                            aria-label={`Download ${file.name}`}
                          >
                            <Download className="h-3.5 w-3.5" />
                          </button>

                          <button
                            type="button"
                            onClick={() => void onReopenInStudio(file)}
                            className="rounded-md border border-slate-200 bg-white p-1.5 text-slate-700 transition-colors hover:bg-slate-100"
                            title="Re-open in Batch Queue"
                            aria-label={`Re-open ${file.name} in Batch Queue`}
                          >
                            <FolderUp className="h-3.5 w-3.5" />
                          </button>

                          <button
                            type="button"
                            onClick={() => setPendingDelete(file)}
                            className="rounded-md border border-slate-200 bg-white p-1.5 text-red-600 transition-colors hover:border-red-200 hover:bg-red-50"
                            title="Delete from Google Drive"
                            aria-label={`Delete ${file.name}`}
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
      </div>

      <ConfirmModal
        open={Boolean(pendingDelete)}
        title="Delete synced master from Google Drive?"
        description="This will permanently remove the selected audio master from your ClearCast Studio Sync folder in Google Drive across all connected devices."
        items={pendingDelete ? [pendingDelete.name] : []}
        confirmLabel="Delete from Drive"
        destructive
        isLoading={isDeleting}
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
