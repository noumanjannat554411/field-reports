# FieldReportApp

An offline-first React Native field reporting application with a Node.js backend, developed for the Wyxan technical assessment.

## Overview

FieldReportApp lets field workers create reports with a description and 1–5 photos without an internet connection. Reports and image files are saved locally before any upload attempt. When connectivity is available and the app is running, pending reports are uploaded automatically. The app also displays reports received by the server.

## Features

- Create reports with a non-empty description and 1–5 camera/gallery photos.
- Resize and compress photos to JPEG; reject images exceeding 5 MB.
- Persist report metadata in AsyncStorage and images in app-private document storage.
- View local reports and their upload status, plus committed server reports and images.
- Retry temporary HTTP/network failures with exponential backoff (up to 30 seconds) and honor `Retry-After` when supplied.
- Treat most HTTP 4xx responses as permanent errors, except 408 and 429.
- Reset local reports and managed images after confirmation, without deleting server data.

## Technology

**Mobile:** React Native CLI, TypeScript, AsyncStorage, NetInfo, React Native Image Picker, Image Resizer, React Native FS.

**Backend:** Node.js, Express, multipart JPEG uploads, persistent report/image storage, and test-only chaos endpoints.

## Prerequisites

- Node.js and npm
- Android Studio, Android SDK, and an Android emulator or connected device
- React Native CLI Android development environment

## Getting started

### 1. Install mobile dependencies

From the repository root:

```bash
npm install
```

### 2. Start the backend

In a separate terminal:

```bash
cd server
npm install
npm start
```

The backend listens on port `4000`. For automatic development restarts, use `npm run dev` instead of `npm start`.

### 3. Configure the API URL

Set the backend URL in `src/config.ts`.

**Android emulator:**

```ts
import {Platform} from 'react-native';

export const API_URL = Platform.OS === 'android'
  ? 'http://10.0.2.2:4000'
  : 'http://localhost:4000';
```

`10.0.2.2` allows the Android emulator to reach the host computer. Local HTTP development may require Android cleartext-traffic configuration.

**Physical Android device using ngrok:**

1. Start the backend on port `4000`.
2. In another terminal, run:

   ```bash
   ngrok http 4000
   ```

3. Copy the active HTTPS forwarding URL.
4. Set `API_URL` in `src/config.ts` to that URL, for example:

   ```ts
   export const API_URL = 'https://your-tunnel.ngrok-free.app';
   ```

5. Keep the backend and tunnel running while testing, and check the `/health` endpoint from the device.

A free tunnel URL may change when ngrok restarts. **Do not commit a personal temporary URL.** The tunnel also exposes development-only chaos/admin endpoints; use it only for controlled testing and stop it afterward. See [ngrok setup](https://ngrok.com/docs/getting-started/).

### 4. Run the Android app

From the repository root:

```bash
npm start
```

In another terminal:

```bash
npm run android
```

## Data flow and delivery guarantees

1. The user enters a description and captures/selects 1–5 photos.
2. Photos are compressed and copied into persistent app-private storage.
3. Report metadata, including a stable report ID and image paths, is saved locally **before** network upload begins.
4. The uploader sends each image sequentially via `PUT /reports/:id/images/:index`.
5. After receiving successful responses for all images, the client calls `POST /reports/:id/commit` with the description, creation time, and image metadata.
6. The backend handles repeated commits for the same report ID idempotently, preventing duplicate committed reports after a lost response.
7. The client marks the local report uploaded after a successful commit response.

**Lost-response behavior:** The chaos backend may save an image but deliberately discard its HTTP response. The client cannot confirm success and therefore retries **the same image index**. With `lose-response` continuously enabled (`rate: 1`), the uploader can repeatedly send image 0 and never advance to image 1 or commit. This is expected for a sequential uploader. When the backend returns to `ok`, the next retry receives confirmation, remaining images upload, and the report commits. The server must safely handle repeated image PUTs.

**Scope:** Backend commit idempotency is covered by API tests. Pending uploads resume when the app runs with connectivity; uploads while the app remains fully terminated have not been verified as native OS-scheduled background work.

## Backend API

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/reports` | List committed reports |
| `PUT` | `/reports/:id/images/:index` | Upload a JPEG as multipart field `image` |
| `POST` | `/reports/:id/commit` | Commit after images are uploaded |
| `GET` | `/images/:id/:file` | Serve a committed image |
| `POST` | `/__chaos` | Set a test failure mode |
| `DELETE` | `/__admin/reports` | **Destructive test-only** server reset |

Commit request example:

```json
{
  "description": "Broken pipe",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "images": [{"index": 0, "size": 1004}]
}
```

## Testing

### Mobile Jest tests

From the repository root:

```bash
npm test -- --runInBand
```

The existing mobile Jest test verifies app rendering with mocked native modules; it is not a full automated upload-state-machine test.

### Backend API tests

```bash
cd server
npm test
```

The backend suite covers upload/commit, duplicate prevention, image validation, missing/mismatched images, lost commit responses, chaos modes, and image serving. In the last reported run, **7 backend tests and 1 mobile render test passed**.

### Manual offline and chaos test

1. Start the backend in `ok` mode and open the app.
2. Enable airplane mode; create three reports, including one with five camera photos.
3. Force-stop and reopen the app while offline. Verify the descriptions and images remain locally available.
4. Enable connectivity. Use the following commands in **separate stages**, observing backend logs and app status between them:

   ```powershell
   Invoke-RestMethod -Uri 'http://localhost:4000/__chaos' -Method POST -ContentType 'application/json' -Body '{"mode":"refuse"}'
   Invoke-RestMethod -Uri 'http://localhost:4000/__chaos' -Method POST -ContentType 'application/json' -Body '{"mode":"lose-response"}'
   Invoke-RestMethod -Uri 'http://localhost:4000/__chaos' -Method POST -ContentType 'application/json' -Body '{"mode":"ok"}'
   ```

5. In `refuse` mode, requests fail temporarily and reports stay pending. In `lose-response` mode, the same image PUT may be repeated because the response is deliberately dropped.
6. Return to `ok`, keep the app open, and wait for automatic retries. Verify remaining images upload and reports commit.
7. Inspect `GET /reports` or the Server Reports screen to confirm each report ID appears once, with the expected images and image sizes under 5 MB.
8. Test **Reset Local Data** separately and verify server reports remain intact.

**Observed manual result (November 5, 2026):** The `refuse` mode produced pending reports and automatic retries. Under `lose-response`, the backend logged repeated `PUT` requests for image index 0. After returning to `ok`, the user confirmed recovery worked. This verifies recovery in the observed scenario; it does **not** by itself certify that the entire three-report/five-camera-photo stress test passed.

## Reset behavior

**Reset Local Data** is a user-confirmed device-only operation. It deletes the `reports` AsyncStorage key and app-managed files in the `report-images` directory. It does not invoke the backend admin-delete endpoint. Any pending reports not yet committed to the server will be lost if reset.

## Known limitations and improvements

- Native OS-scheduled uploads while the app remains fully terminated have not been established; pending work resumes when the app runs again.
- The current upload implementation should be reviewed for request timeouts, retry timer scheduling, and concurrent AsyncStorage updates. These improvements were discussed but **have not been confirmed as applied** to the repository.
- Retry timers and reset operations should be synchronized to avoid a reset/upload race.
- The mobile automated test suite covers rendering, not the full uploader; backend delivery behavior has stronger automated coverage.
- Development chaos/admin endpoints require access controls before any production deployment.

## Assessment handoff

- Git repository with genuine incremental commits
- This README with installation, testing, and failure-reproduction instructions
- A 2–3 minute narrated recording demonstrating offline creation, persistence, recovery, and server-side results
