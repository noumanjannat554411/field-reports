# FieldReportApp

An offline-first React Native field reporting application with a Node.js backend, developed for the Wyxan technical assessment.

## Overview

FieldReportApp allows field workers to create reports containing a description and 1–5 photos, even without an internet connection. Reports and image files are stored locally before upload. When connectivity is available, the app attempts to upload pending reports and displays reports received by the server.

## Features

- Create a report with a non-empty description and 1–5 camera/gallery photos.
- Resize and compress selected photos to JPEG; reject images above the 5 MB limit.
- Store report metadata in AsyncStorage and image files in app-private document storage.
- Show local reports with pending, uploaded, and failed states.
- Retry transient upload failures with exponential backoff (up to 30 seconds); respect the server's `Retry-After` header when provided.
- Treat most HTTP 4xx responses as permanent failures, except 408 and 429.
- Show uploaded reports and images from the backend in a separate Server Reports screen.
- Provide a confirmed **Reset Local Data** action that clears locally saved reports and managed images without deleting server data.

## Technology

**Mobile:** React Native CLI, TypeScript, AsyncStorage, NetInfo, React Native Image Picker, Image Resizer, React Native FS.

**Backend:** Node.js, Express, multipart image upload, persistent server-side report/image storage, and fault-injection (chaos) endpoints.

## Prerequisites

- Node.js and npm
- Android Studio, Android SDK, and an Android emulator or connected Android device
- React Native CLI development environment configured for Android

## Getting started

### 1. Install mobile dependencies

From the repository root:

```bash
npm install
```

### 2. Install and start the backend

In a separate terminal:

```bash
cd server
npm install
npm start
```

The backend listens on port `4000` in the development setup. For automatic server restarts during development, use `npm run dev` instead of `npm start`.

### 3. Configure the mobile API URL

The development API URL is defined in `src/config.ts`:

```ts
import {Platform} from 'react-native';
export const API_URL = Platform.OS === 'android'
  ? 'http://10.0.2.2:4000'
  : 'http://localhost:4000';
```

`10.0.2.2` points from the Android emulator to the development computer. For a physical device, use a reachable LAN address or an HTTPS tunnel such as **ngrok**.

#### Option A: Android emulator (local backend)

Keep the `10.0.2.2:4000` URL shown above. The backend must be running on the development computer. Local HTTP development may require Android cleartext-traffic configuration.

#### Option B: Physical device or remote testing (ngrok)

1. Start the backend on port `4000` (`cd server && npm start`).
2. Install and configure [ngrok](https://ngrok.com/docs/getting-started/) if needed, then run this in a separate terminal:

   ```bash
   ngrok http 4000
   ```

3. Copy the **HTTPS forwarding URL** shown by ngrok (example only: `https://your-tunnel.ngrok-free.app`).
4. Replace `src/config.ts` with the URL of **your own active tunnel**:

   ```ts
   export const API_URL = 'https://your-tunnel.ngrok-free.app';
   ```

5. Rebuild/reload the app as needed and verify that the device can reach `${API_URL}/health`.

Keep the backend and ngrok running while testing. A temporary ngrok URL may change when the tunnel restarts; update `API_URL` accordingly. Do **not** commit a personal, temporary tunnel URL to the repository. The ngrok tunnel exposes the development server, including its test-only chaos/admin endpoints, to the internet; use it only for controlled assessment testing, stop it afterward, and never use this configuration for production.

### 4. Run the Android app

From the repository root, with the backend running:

```bash
npm start
```

In another terminal:

```bash
npm run android
```

## Data flow and delivery behavior

1. The user enters a description and selects or captures 1–5 photos.
2. Photos are resized/compressed and copied to app-private persistent storage.
3. Report metadata and local image paths are saved to AsyncStorage before the app attempts network upload.
4. The uploader sends each image to the backend using its stable report ID and image index.
5. After the image uploads, the client commits the report with its description, creation time, and image metadata.
6. The backend treats repeated commits for the same report ID as the same report, preventing duplicate report records when a response is lost and the client retries.
7. After a successful commit response, the app marks the local report as uploaded.

Transient failures retain the report locally for a later retry. A server-side commit may have succeeded even if its response never reached the client; retrying the same report ID is therefore essential.

**Scope of guarantee:** Backend idempotency is covered by API tests. End-to-end delivery depends on the app running or being reopened and obtaining connectivity. Uploads while the app remains fully terminated have not been verified as a native background job.

## Backend API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Health check |
| `GET` | `/reports` | List committed server reports |
| `PUT` | `/reports/:id/images/:index` | Upload one JPEG image in multipart field `image` |
| `POST` | `/reports/:id/commit` | Commit a report after image uploads |
| `GET` | `/images/:id/:file` | Serve a committed report image |
| `POST` | `/__chaos` | Set a simulated failure mode for testing |
| `DELETE` | `/__admin/reports` | **Destructive test-only** server reset |

The commit request uses the following shape:

```json
{
  "description": "Broken pipe",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "images": [{"index": 0, "size": 1004}]
}
```

## Testing

### Mobile tests (Jest)

From the repository root:

```bash
npm test -- --runInBand
```

The current Jest suite verifies that the app renders with mocked native modules. It is not a complete automated test of the mobile upload pipeline.

### Backend API tests (Node.js test runner)

```bash
cd server
npm test
```

The backend test suite covers initial upload/commit, duplicate prevention, missing/mismatched images, validation, lost commit responses, chaos modes, and image serving. At the time this README was prepared, all **7 backend tests** and the **1 mobile render test** passed.

### Manual offline and failure test

1. Start the backend and app; ensure the backend chaos mode is `ok`.
2. Enable airplane mode on the device/emulator.
3. Create three reports, including one with five camera photos.
4. Force-stop and reopen the app; verify the local reports and photos remain.
5. Restore connectivity and simulate server failures. For example, from PowerShell:

   ```powershell
   Invoke-RestMethod -Uri 'http://localhost:4000/__chaos' -Method POST -ContentType 'application/json' -Body '{"mode":"refuse"}'
   Invoke-RestMethod -Uri 'http://localhost:4000/__chaos' -Method POST -ContentType 'application/json' -Body '{"mode":"lose-response"}'
   Invoke-RestMethod -Uri 'http://localhost:4000/__chaos' -Method POST -ContentType 'application/json' -Body '{"mode":"ok"}'
   ```

   Apply these modes at separate moments during the test, not all at once.
6. Verify that all reports eventually appear in Server Reports with their expected photos.
7. Inspect `GET /reports` to confirm each stable report ID appears exactly once.
8. Test **Reset Local Data** separately; confirm it removes local data but preserves server reports.

## Reset behavior

**Reset Local Data** is a user-confirmed, device-only operation. It removes report metadata from the app's `reports` AsyncStorage key and deletes files under its managed `report-images` directory. It does **not** call the backend admin delete endpoint. Pending reports that have not reached the server will be lost if reset.

## Known limitations / future improvements

- Native OS-scheduled background uploads while the app is fully terminated are not established. Pending reports are retained and can resume when the app runs again.
- A scheduled retry could race with local reset; retry timer cancellation and reset/upload synchronization would further harden this path.
- Mobile Jest coverage currently checks rendering, not the complete upload state machine; backend delivery guarantees have stronger automated coverage.
- The chaos and admin endpoints are development/test utilities and should not be exposed in a production deployment without access controls.

## Assessment handoff

- Git repository with meaningful incremental commits
- This README with installation, run, test, and failure-reproduction instructions
- A 2–3 minute narrated demonstration of offline creation, persistence, network recovery, and server-side results
- Repository access for the reviewer specified in the assessment instructions
