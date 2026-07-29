# DSS Flow

A responsive project and task management workspace built for DSS Corps Inc. It supports projects, Kanban task tracking, people, invitations, teams, assignments, priorities, due dates, and personal task views.

## Run locally

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Open `http://localhost:5173`.

Without a `DATABASE_URL`, DSS Flow starts in demo mode with sample data held in memory. This makes the complete interface immediately usable. Demo changes reset whenever the server restarts.

## Connect Neon PostgreSQL

1. Create a Neon project and copy its PostgreSQL connection string.
2. Copy `.env.example` to `.env`.
3. Replace `DATABASE_URL` in `.env` with the Neon connection string.
4. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` for the initial workspace administrator.
5. Restart `npm run dev`.

The server automatically creates the required tables and indexes from `server/schema.sql`. On the first start it creates the administrator and stores the password as a bcrypt hash. Sessions are random, expire after seven days, and are held in secure HttpOnly cookies. A new Neon database starts empty, so create people, teams, projects, and tasks through the application.

## Invitation email delivery

Inviting an employee creates their login, generates a strong temporary password, and forces them to choose a new password on first sign-in. Configure these server-side values in `.env` to send the credentials automatically:

```env
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=notifications@your-company.com
SMTP_PASSWORD=your-provider-app-password
MAIL_FROM=DSS Flow <notifications@your-company.com>
APP_URL=https://your-deployed-domain.com
```

When SMTP is not configured, the administrator receives a one-time credentials screen to copy and share securely.

## PWA installation

DSS Flow includes a web app manifest, offline application shell, install prompt, mobile metadata, and a service worker. On a deployed HTTPS domain, supported mobile and desktop browsers display **Install DSS Flow** in the sidebar or their browser install menu. Localhost also supports installation during development.

## Publishing a new version

Set `APP_VERSION` to a new unique value whenever a release is deployed. You can also set `APP_RELEASE_TITLE` and `APP_RELEASE_NOTES`. On startup, DSS Flow records the version once. When it detects a version newer than the previously recorded release, every active employee receives a branded Zoho email and an in-app notification. Connected clients also detect the new version within five minutes and display an **Update now** banner that clears the old PWA cache and reloads the current application.

The first version recorded in a database is treated as the baseline and does not email the whole workspace.

## Task collaboration

- Full task instructions and definitions of done
- Up to five documents per upload, 8 MB each, stored in Neon
- Questions, replies, and progress updates inside each task
- Required delivery summary when work is marked complete
- Optional handoff and completion notes
- Persisted assignment, message, document, question, and completion notifications
- Distinct in-app sound patterns and browser notifications by notification type

## Internal communication and meetings

- Employees can update assigned work but cannot create tasks
- Private direct messages between colleagues
- Persistent team channels automatically created from team membership
- Live WhatsApp-style messages delivered through authenticated Socket.IO connections
- Image previews and document uploads in chat (up to five files, 8 MB each)
- Chat notifications with a dedicated sound pattern and browser notification
- Calendar-based meeting scheduling with separate date, start-time, and end-time controls
- Attendee invitations and meeting-update notifications
- Private in-app browser video rooms using WebRTC, with camera, microphone, screen sharing, and leave controls
- A dedicated meeting-notification sound pattern
- Available, busy, lunch, break, in-meeting, and offline work statuses with an optional note

WebRTC media is peer to peer and meeting signaling stays inside DSS Flow. There is no Jitsi, Zoom, Google Meet, iframe, or external meeting-service integration. Camera and microphone access require HTTPS in production (localhost is allowed for development). For calls across restrictive company networks, configure organization-controlled `STUN_URL`, `TURN_URL`, `TURN_USERNAME`, and `TURN_CREDENTIAL` values. When these are blank, DSS Flow attempts a direct peer-to-peer connection.

Browsers require a user interaction before they allow audio. Use **Enable & test custom sounds** in the notification panel once; DSS Flow then plays a different sound pattern for task assignments, chat messages, meetings, questions, documents, and completions.

## Employee account controls

Workspace administrators and project managers can use the People menu to change an employee’s role, suspend or restore access, reset their password, or remove their account. Suspension and password reset revoke every active session immediately. Password resets send a new temporary password through the configured Zoho mailbox and force a private password change on the next sign-in. The final active administrator cannot suspend, demote, or remove their own account.

## Production

```powershell
npm run build
npm start
```

Open `http://localhost:3001`. Set `DATABASE_URL` and `PORT` in the hosting environment.

## Deploying on Vercel

The repository includes `vercel.json` and a catch-all Vercel Function entry point. Import the repository in Vercel, keep the detected framework as **Vite**, use `npm run build`, and use `dist` as the output directory. Enable Fluid Compute and WebSocket support for the project; DSS Flow uses Vercel's Socket.IO-compatible WebSocket runtime for chat, notification delivery, presence, and internal WebRTC signaling.

Add these values in **Project Settings → Environment Variables** for Production, Preview, and Development as appropriate:

```env
DATABASE_URL=your-neon-pooled-connection-string
ADMIN_EMAIL=your-admin-email
ADMIN_PASSWORD=your-strong-admin-password
NODE_ENV=production
SMTP_HOST=smtp.zoho.in
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-zoho-mailbox
SMTP_PASSWORD=your-zoho-app-password
MAIL_FROM=DSS Flow <your-zoho-mailbox>
APP_URL=https://your-project.vercel.app
APP_VERSION=1.0.0
APP_RELEASE_TITLE=DSS Flow update
APP_RELEASE_NOTES=Release notes shown to employees.
REDIS_URL=your-vercel-marketplace-redis-url
```

Connect a Redis-compatible store from Vercel Marketplace and provide `REDIS_URL`. This coordinates Socket.IO rooms across Vercel Function instances and is required for dependable multi-user chat, presence, and meeting signaling in production.

DSS Flow uses Google's public STUN service when `STUN_URL` is blank. For dependable meetings across restrictive networks, configure organization-controlled `STUN_URL`, `TURN_URL`, `TURN_USERNAME`, and `TURN_CREDENTIAL` values. Redeploy after changing `APP_URL` to the final production domain so invitation and meeting links use the correct address.

Vercel Functions have a 4.5 MB request/response payload limit. On Vercel, DSS Flow therefore accepts one attachment of up to 4 MB per upload request; users can repeat the upload for additional files.

## Main API routes

- `GET /api/dashboard`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/projects`
- `POST /api/tasks`
- `PATCH /api/tasks/:id`
- `DELETE /api/tasks/:id`
- `PATCH /api/users/me/status`
- `GET /api/chat/channels`
- `POST /api/chat/channels/:id/messages`
- `POST /api/chat/channels/:id/attachments`
- `POST /api/meetings`
- `GET /api/webrtc-config`
- `POST /api/teams`
- `POST /api/invitations`
