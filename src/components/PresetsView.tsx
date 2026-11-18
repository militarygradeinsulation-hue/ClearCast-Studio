import { useState } from 'react';
import { Check, CloudUpload, Plus, Trash2, Loader2 } from 'lucide-react';
import type { AudioPreset, ExportSettings, ProcessingSettings } from '../types/audio';
import { ConfirmModal } from './ConfirmModal';

interface PresetsViewProps {
  presets: AudioPreset[];
  currentProcessing: ProcessingSettings;
  currentExport: ExportSettings;
  onApplyPreset: (preset: AudioPreset) => void;
  onSaveCustomPreset: (name: string, description: string) => void;
  onDeleteCustomPreset: (presetId: string) => void;
  isGoogleConnected: boolean;
  hasExistingCloudPresets: boolean;
  onSyncPresetsToCloud: () => Promise<void>;
  isSyncingPresets: boolean;
}

export function PresetsView({
  presets,
  currentProcessing,
  currentExport,
  onApplyPreset,
  onSaveCustomPreset,
  onDeleteCustomPreset,
  isGoogleConnected,
  hasExistingCloudPresets,
  onSyncPresetsToCloud,
  isSyncingPresets,
}: PresetsViewProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [confirmOverwriteOpen, setConfirmOverwriteOpen] = useState(false);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSaveCustomPreset(name.trim(), description.trim() || 'Custom voice cleanup & export chain');
    setName('');
    setDescription('');
  };

  const handleCloudSyncClick = () => {
    if (hasExistingCloudPresets) {
      setConfirmOverwriteOpen(true);
    } else {
      void onSyncPresetsToCloud();
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Mastering &amp; Export Presets</h2>
          <p className="mt-1 text-sm text-slate-600">
            One-click filter chains and WAV/MP3 bitrate targets for podcasts, interviews, and
            broadcast delivery.
          </p>
        </div>

        {isGoogleConnected && (
          <button
            type="button"
            disabled={isSyncingPresets}
            onClick={handleCloudSyncClick}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-800 transition-colors hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            {isSyncingPresets ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CloudUpload className="h-3.5 w-3.5 text-blue-700" />
            )}
            <span>{isSyncingPresets ? 'Syncing Presets...' : 'Sync Custom Presets to Drive'}</span>
          </button>
        )}
      </div>

      {/* Preset Grid */}
      <div className="grid gap-4 md:grid-cols-2">
        {presets.map((preset) => {
          const isActive = currentProcessing.presetId === preset.id;
          return (
            <div
              key={preset.id}
              className={`flex flex-col justify-between rounded-xl border bg-white p-5 transition-colors ${
                isActive ? 'border-blue-600' : 'border-slate-200'
              }`}
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-base font-semibold text-slate-900">{preset.name}</h3>
                  {preset.isCustom && (
                    <button
                      type="button"
                      onClick={() => onDeleteCustomPreset(preset.id)}
                      className="rounded-md p-1 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600"
                      title="Delete custom preset"
                      aria-label={`Delete ${preset.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
                  {preset.description}
                </p>

                <div className="mt-4 flex flex-wrap items-center gap-2 font-mono text-xs tabular-nums text-slate-500">
                  <span>NR {preset.processing.noiseReduction}%</span>
                  <span aria-hidden="true">·</span>
                  <span>Clarity {preset.processing.voiceClarity ?? 75}%</span>
                  <span aria-hidden="true">·</span>
                  <span>Articulation {preset.processing.voicePresenceLayer ?? 55}%</span>
                  <span aria-hidden="true">·</span>
                  <span>Level {preset.processing.leveling}%</span>
                  <span aria-hidden="true">·</span>
                  <span>{preset.processing.targetLufs} LUFS</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {preset.export.format.toUpperCase()}{' '}
                    {preset.export.format === 'mp3'
                      ? `${preset.export.mp3Bitrate} kbps`
                      : `${preset.export.wavBitDepth}-bit`}
                  </span>
                </div>
              </div>

              <div className="mt-5 flex items-center justify-end border-t border-slate-100 pt-4">
                <button
                  type="button"
                  onClick={() => onApplyPreset(preset)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    isActive
                      ? 'bg-blue-700 text-white'
                      : 'border border-slate-200 bg-white text-slate-800 hover:bg-slate-50'
                  }`}
                >
                  {isActive && <Check className="h-3.5 w-3.5" />}
                  <span>{isActive ? 'Active Preset' : 'Apply Preset'}</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Save Current Settings as Custom Preset */}
      <form
        onSubmit={handleSave}
        className="rounded-xl border border-slate-200 bg-white p-6"
      >
        <h3 className="text-base font-semibold text-slate-900">
          Save Current Sidebar Chain as Preset
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          Captures NR {currentProcessing.noiseReduction}% · Clarity {currentProcessing.voiceClarity}% ·
          Articulation {currentProcessing.voicePresenceLayer}% · Leveling {currentProcessing.leveling}% ·{' '}
          {currentProcessing.targetLufs} LUFS ·{' '}
          {currentExport.format.toUpperCase()}{' '}
          {currentExport.format === 'mp3'
            ? `${currentExport.mp3Bitrate} kbps`
            : `${currentExport.wavBitDepth}-bit`}
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="preset-name" className="block text-xs font-medium text-slate-700">
              Preset Name
            </label>
            <input
              id="preset-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Morning Interview MP3 256k"
              className="mt-1.5 h-9 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="preset-desc" className="block text-xs font-medium text-slate-700">
              Notes (Optional)
            </label>
            <input
              id="preset-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Two-host desk setup with lav mics"
              className="mt-1.5 h-9 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-900 focus:border-blue-600 focus:bg-white focus:outline-none"
            />
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="submit"
            className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Save Custom Preset</span>
          </button>
        </div>
      </form>

      <ConfirmModal
        open={confirmOverwriteOpen}
        title="Update synced presets in Google Drive?"
        description="This will overwrite your existing clearcast-presets.json file in Google Drive with your current custom presets list so all devices stay in sync."
        items={['clearcast-presets.json']}
        confirmLabel="Update Cloud Presets"
        isLoading={isSyncingPresets}
        onConfirm={() => {
          setConfirmOverwriteOpen(false);
          void onSyncPresetsToCloud();
        }}
        onCancel={() => setConfirmOverwriteOpen(false)}
      />
    </div>
  );
}
