import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import type { AudioPreset, DriveMediaFile } from '../types/audio';

export const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
];

const app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);

const provider = new GoogleAuthProvider();
for (const scope of DRIVE_SCOPES) {
  provider.addScope(scope);
}

let isSigningIn = false;
let cachedAccessToken: string | null = null;

export const SYNC_FOLDER_NAME = 'ClearCast Studio Sync';
export const PRESETS_FILENAME = 'clearcast-presets.json';

export function initGoogleAuth(
  onAuthReady: (user: User | null, accessToken: string | null) => void
) {
  return onAuthStateChanged(auth, (user) => {
    if (user) {
      if (!isSigningIn) {
        onAuthReady(user, cachedAccessToken);
      }
    } else {
      cachedAccessToken = null;
      onAuthReady(null, null);
    }
  });
}

export async function signInWithGoogleDrive(): Promise<{ user: User; accessToken: string }> {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Google Drive access token was not granted. Please try signing in again.');
    }
    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } finally {
    isSigningIn = false;
  }
}

export async function signOutGoogle(): Promise<void> {
  await auth.signOut();
  cachedAccessToken = null;
}

export function getCachedAccessToken(): string | null {
  return cachedAccessToken;
}

export async function listDriveMediaFiles(
  accessToken: string,
  searchQuery = '',
  mediaKind: 'all' | 'audio' | 'video' = 'all'
): Promise<DriveMediaFile[]> {
  const filters: string[] = ['trashed = false'];
  if (mediaKind === 'audio') {
    filters.push("mimeType contains 'audio/'");
  } else if (mediaKind === 'video') {
    filters.push("mimeType contains 'video/'");
  } else {
    filters.push("(mimeType contains 'audio/' or mimeType contains 'video/')");
  }

  const trimmed = searchQuery.trim().replace(/'/g, "\\'");
  if (trimmed) {
    filters.push(`name contains '${trimmed}'`);
  }

  const params = new URLSearchParams({
    q: filters.join(' and '),
    pageSize: '60',
    orderBy: 'modifiedTime desc',
    fields: 'files(id,name,mimeType,size,modifiedTime,iconLink,webViewLink)',
  });

  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401) {
    cachedAccessToken = null;
    throw new Error('SESSION_EXPIRED');
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Could not list Google Drive files (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as { files?: DriveMediaFile[] };
  return data.files || [];
}

export async function ensureSyncFolder(accessToken: string): Promise<string> {
  const q = `name = '${SYNC_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const params = new URLSearchParams({
    q,
    pageSize: '1',
    fields: 'files(id,name)',
  });

  const findRes = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (findRes.status === 401) {
    cachedAccessToken = null;
    throw new Error('SESSION_EXPIRED');
  }
  if (!findRes.ok) {
    throw new Error(`Failed to inspect Drive sync folder (${findRes.status})`);
  }

  const found = (await findRes.json()) as { files?: Array<{ id: string }> };
  if (found.files && found.files.length > 0) {
    return found.files[0].id;
  }

  const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: SYNC_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });

  if (!createRes.ok) {
    throw new Error(`Failed to create sync folder in Google Drive (${createRes.status})`);
  }

  const created = (await createRes.json()) as { id: string };
  return created.id;
}

export async function listSyncedMasters(
  accessToken: string,
  folderId: string
): Promise<DriveMediaFile[]> {
  const q = `'${folderId}' in parents and trashed = false and name != '${PRESETS_FILENAME}'`;
  const params = new URLSearchParams({
    q,
    pageSize: '100',
    orderBy: 'modifiedTime desc',
    fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,appProperties,description)',
  });

  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401) {
    cachedAccessToken = null;
    throw new Error('SESSION_EXPIRED');
  }
  if (!res.ok) {
    throw new Error(`Failed to list synced files (${res.status})`);
  }

  const data = (await res.json()) as { files?: DriveMediaFile[] };
  return data.files || [];
}

export async function deleteDriveFile(accessToken: string, fileId: string): Promise<void> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401) {
    cachedAccessToken = null;
    throw new Error('SESSION_EXPIRED');
  }
  if (!res.ok && res.status !== 204) {
    throw new Error(`Failed to delete file from Google Drive (${res.status})`);
  }
}

export async function fetchDriveFileBlob(accessToken: string, fileId: string): Promise<Blob> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (res.status === 401) {
    cachedAccessToken = null;
    throw new Error('SESSION_EXPIRED');
  }
  if (!res.ok) {
    throw new Error(`Failed to download file from Google Drive (${res.status})`);
  }
  return res.blob();
}

export async function loadSyncedPresets(
  accessToken: string,
  folderId: string
): Promise<{ fileId: string | null; presets: AudioPreset[] }> {
  const q = `'${folderId}' in parents and name = '${PRESETS_FILENAME}' and trashed = false`;
  const params = new URLSearchParams({ q, pageSize: '1', fields: 'files(id)' });

  const findRes = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!findRes.ok) return { fileId: null, presets: [] };
  const found = (await findRes.json()) as { files?: Array<{ id: string }> };
  if (!found.files || found.files.length === 0) {
    return { fileId: null, presets: [] };
  }

  const fileId = found.files[0].id;
  const contentRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!contentRes.ok) return { fileId, presets: [] };

  try {
    const json = (await contentRes.json()) as AudioPreset[];
    return { fileId, presets: Array.isArray(json) ? json : [] };
  } catch {
    return { fileId, presets: [] };
  }
}

export async function saveSyncedPresets(
  accessToken: string,
  folderId: string,
  existingFileId: string | null,
  presets: AudioPreset[]
): Promise<string> {
  const content = JSON.stringify(presets, null, 2);

  if (existingFileId) {
    const updateRes = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingFileId)}?uploadType=media`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: content,
      }
    );
    if (!updateRes.ok) {
      throw new Error(`Failed to update synced presets (${updateRes.status})`);
    }
    return existingFileId;
  }

  const boundary = 'clearcast_boundary_' + Date.now();
  const metadata = JSON.stringify({
    name: PRESETS_FILENAME,
    parents: [folderId],
    mimeType: 'application/json',
  });

  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;

  const createRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
  if (!createRes.ok) {
    throw new Error(`Failed to create synced presets file (${createRes.status})`);
  }
  const created = (await createRes.json()) as { id: string };
  return created.id;
}
