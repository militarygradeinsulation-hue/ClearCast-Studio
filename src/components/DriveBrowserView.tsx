import { useEffect, useState } from 'react';
import {
  Search,
  RefreshCw,
  FileAudio,
  FileVideo,
  CheckSquare,
  Square,
  Download,
  Loader2,
  HardDrive,
} from 'lucide-react';
import type { DriveMediaFile } from '../types/audio';
import { listDriveMediaFiles } from '../lib/googleDrive';
import { formatBytes, formatRelativeDate, sanitizeExtensionLabel } from '../lib/formatters';
import { GoogleSignInButton } from './GoogleSignInButton';

interface DriveBrowserViewProps {
  accessToken: string | null;
  onSignIn: () => Promise<void>;
  isSigningIn: boolean;
  onImportFiles: (files: DriveMediaFile[]) => Promise<void>;
  isImporting: boolean;
  onSessionExpired: () => void;
}

export function DriveBrowserView({
  accessToken,
  onSignIn,
  isSigningIn,
  onImportFiles,
  isImporting,
  onSessionExpired,
}: DriveBrowserViewProps) {
  const [files, setFiles] = useState<DriveMediaFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [mediaKind, setMediaKind] = useState<'all' | 'audio' | 'video'>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const fetchFiles = async (queryText = searchQuery, kind = mediaKind) => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const results = await listDriveMediaFiles(accessToken, queryText, kind);
      setFiles(results);
      setSelectedIds(new Set());
    } catch (err) {
      if (err instanceof Error && err.message === 'SESSION_EXPIRED') {
        onSessionExpired();
        return;
      }
      setError(err instanceof Error ? err.message : 'Unable to load files from Google Drive.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (accessToken) {
      void fetchFiles(searchQuery, mediaKind);
    }
  }, [accessToken, mediaKind]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === files.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(files.map((f) => f.id)));
    }
  };

  if (!accessToken) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
          <HardDrive className="h-6 w-6" />
        </div>
        <h2 className="mt-4 text-xl font-semibold text-slate-900">
          Connect Google Drive to import recordings
        </h2>
        <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-slate-600">
          Sign in with your Google account to browse podcast interviews, video recordings, and voice
          memos stored in Google Drive and send them directly into the batch cleanup queue (up to 75
          minutes per file).
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

  const selectedFiles = files.filter((f) => selectedIds.has(f.id));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Import from Google Drive</h2>
          <p className="mt-1 text-sm text-slate-600">
            Select audio or video files up to 75 minutes long to extract, denoise, and level.
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => void fetchFiles()}
            disabled={loading || isImporting}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>

          <button
            type="button"
            disabled={selectedFiles.length === 0 || isImporting}
            onClick={() => void onImportFiles(selectedFiles)}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-45 whitespace-nowrap shrink-0"
          >
            {isImporting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            <span>
              {isImporting
                ? 'Importing...'
                : `Import Selected (${selectedFiles.length})`}
            </span>
          </button>
        </div>
      </div>

      {/* Filter & Search Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void fetchFiles(searchQuery, mediaKind);
          }}
          className="flex min-w-64 flex-1 items-center gap-2"
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search Drive audio and video files..."
              className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pr-3 pl-9 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:bg-white focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="h-9 rounded-lg border border-slate-200 bg-white px-4 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            Search
          </button>
        </form>

        <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
          {(['all', 'audio', 'video'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => setMediaKind(kind)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors whitespace-nowrap shrink-0 ${
                mediaKind === kind
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {kind === 'all' ? 'All Media' : `${kind} Only`}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Drive File Table */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                <th className="w-10 px-4 py-3">
                  <button
                    type="button"
                    onClick={toggleSelectAll}
                    className="flex items-center justify-center text-slate-500 hover:text-slate-900"
                    aria-label="Toggle select all files"
                  >
                    {files.length > 0 && selectedIds.size === files.length ? (
                      <CheckSquare className="h-4 w-4 text-blue-700" />
                    ) : (
                      <Square className="h-4 w-4" />
                    )}
                  </button>
                </th>
                <th className="px-4 py-3">File Name</th>
                <th className="px-4 py-3">Format</th>
                <th className="px-4 py-3 text-right">Size</th>
                <th className="px-4 py-3 text-right">Modified</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                Array.from({ length: 5 }).map((_, idx) => (
                  <tr key={idx} className="h-12 animate-pulse">
                    <td className="px-4 py-3"><div className="h-4 w-4 rounded bg-slate-200" /></td>
                    <td className="px-4 py-3"><div className="h-4 w-64 rounded bg-slate-200" /></td>
                    <td className="px-4 py-3"><div className="h-4 w-12 rounded bg-slate-200" /></td>
                    <td className="px-4 py-3"><div className="ml-auto h-4 w-16 rounded bg-slate-200" /></td>
                    <td className="px-4 py-3"><div className="ml-auto h-4 w-24 rounded bg-slate-200" /></td>
                    <td className="px-4 py-3"><div className="ml-auto h-7 w-20 rounded bg-slate-200" /></td>
                  </tr>
                ))
              ) : files.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-sm text-slate-500">
                    No matching audio or video files found in your Google Drive.
                  </td>
                </tr>
              ) : (
                files.map((file) => {
                  const isVideo = file.mimeType.startsWith('video/');
                  const checked = selectedIds.has(file.id);
                  return (
                    <tr
                      key={file.id}
                      className={`transition-colors hover:bg-slate-50 ${checked ? 'bg-blue-50/40' : ''}`}
                    >
                      <td className="px-4 py-2.5">
                        <button
                          type="button"
                          onClick={() => toggleSelect(file.id)}
                          className="flex items-center justify-center text-slate-500 hover:text-slate-900"
                          aria-label={`Select ${file.name}`}
                        >
                          {checked ? (
                            <CheckSquare className="h-4 w-4 text-blue-700" />
                          ) : (
                            <Square className="h-4 w-4" />
                          )}
                        </button>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2.5">
                          {isVideo ? (
                            <FileVideo className="h-4 w-4 shrink-0 text-slate-400" />
                          ) : (
                            <FileAudio className="h-4 w-4 shrink-0 text-slate-400" />
                          )}
                          <span className="max-w-md truncate font-medium text-slate-900">
                            {file.name}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-slate-600">
                        {sanitizeExtensionLabel(file.mimeType, file.name)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-slate-600">
                        {formatBytes(file.size)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-slate-500">
                        {formatRelativeDate(file.modifiedTime)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button
                          type="button"
                          disabled={isImporting}
                          onClick={() => void onImportFiles([file])}
                          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:border-blue-600 hover:text-blue-700 disabled:opacity-50 whitespace-nowrap shrink-0"
                        >
                          Import
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
