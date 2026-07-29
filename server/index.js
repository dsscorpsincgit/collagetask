import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import multer from 'multer';
import nodemailer from 'nodemailer';
import { neon } from '@neondatabase/serverless';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import webpush from 'web-push';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3001;
const appUrl = process.env.APP_URL || `http://localhost:${port}`;
const vercelDeploymentVersion = String(process.env.VERCEL_DEPLOYMENT_ID || '').trim();
const vercelCommitVersion = String(process.env.VERCEL_GIT_COMMIT_SHA || '').trim();
const appVersion = (
  vercelDeploymentVersion
    ? `deploy-${vercelDeploymentVersion.replace(/^dpl_/, '')}`
    : vercelCommitVersion
      ? `git-${vercelCommitVersion}`
      : process.env.APP_VERSION || '1.0.0'
).slice(0, 40);
const appReleaseTitle = process.env.APP_RELEASE_TITLE || 'A new DSS Flow version is available';
const appReleaseNotes = String(process.env.VERCEL_GIT_COMMIT_MESSAGE || process.env.APP_RELEASE_NOTES || 'Performance improvements and fixes are ready.').trim();
const isProductionRelease = !process.env.VERCEL || ['production', 'prod'].includes(String(process.env.VERCEL_TARGET_ENV || process.env.VERCEL_ENV || '').toLowerCase());
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
let io;
let pushEnabled=false;
if(process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY){
  const configuredSubject=String(process.env.VAPID_SUBJECT||process.env.ADMIN_EMAIL||'admin@example.com').trim();
  const vapidSubject=/^(mailto:|https?:\/\/)/i.test(configuredSubject)?configuredSubject:`mailto:${configuredSubject}`;
  try{
    webpush.setVapidDetails(vapidSubject,process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);
    pushEnabled=true;
  }catch(error){
    console.error(`Push notifications disabled: ${error.message}`);
  }
}

app.use(cors());
app.use(express.json());
app.use(cookieParser());

const SESSION_COOKIE = 'dss_session';
const SESSION_DAYS = 7;
const demoSessions = new Set();
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: SESSION_DAYS * 86400000, path: '/' };
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: (process.env.VERCEL ? 4 : 8) * 1024 * 1024, files: process.env.VERCEL ? 1 : 5 } });
const mailer = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD ? nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
}) : null;
const makeTemporaryPassword = () => `Dss@${crypto.randomBytes(6).toString('base64url')}7!`;
const logoAttachment={filename:'dss-flow-logo.jpg',path:path.join(__dirname,'..','public','dsslogo.31878f461bb1d61573f8.jpg'),cid:'dss-flow-logo'};
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));
const brandedEmail=({eyebrow='DSS FLOW',title,greeting,content,buttonLabel='Open DSS Flow',buttonUrl=appUrl,showInstall=true})=>({
  attachments:[logoAttachment],
  html:`<!doctype html><html><body style="margin:0;background:#f2f5f9;font-family:Arial,sans-serif;color:#17243a"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f2f5f9;padding:28px 12px"><tr><td align="center"><table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border:1px solid #e1e7ef;border-radius:16px;overflow:hidden"><tr><td style="background:#101c2f;padding:22px 28px"><table role="presentation" width="100%"><tr><td><img src="cid:dss-flow-logo" width="48" height="48" style="display:block;border-radius:10px;object-fit:cover" alt="DSS Flow"></td><td align="right" style="color:#2ac7d6;font-size:12px;font-weight:bold;letter-spacing:1.5px">${escapeHtml(eyebrow)}</td></tr></table></td></tr><tr><td style="padding:30px 32px"><h1 style="font-size:24px;line-height:1.25;margin:0 0 10px;color:#142036">${escapeHtml(title)}</h1><p style="font-size:15px;margin:0 0 22px;color:#647187">${escapeHtml(greeting)}</p>${content}<p style="margin:26px 0"><a href="${escapeHtml(buttonUrl)}" style="display:inline-block;background:#20c2d1;color:#062d34;padding:13px 21px;border-radius:9px;text-decoration:none;font-weight:bold">${escapeHtml(buttonLabel)}</a></p>${showInstall?`<div style="margin-top:26px;padding:18px;background:#f4f8fb;border:1px solid #e2e9f0;border-radius:10px"><strong style="font-size:14px">Install DSS Flow as an app</strong><ol style="padding-left:20px;margin:10px 0 0;color:#68758a;font-size:13px;line-height:1.7"><li>Open DSS Flow in Google Chrome.</li><li>Desktop: click the install icon in the address bar or Chrome menu → Install DSS Flow.</li><li>Android: open the Chrome menu → Install app or Add to Home screen.</li><li>Sign in using your work email.</li></ol></div>`:''}</td></tr><tr><td style="padding:18px 32px;background:#f8fafc;color:#8a96a7;font-size:12px">DSS Flow · DSS Corps Inc. · Secure internal workspace</td></tr></table></td></tr></table></body></html>`
});

async function sendPush(userId,payload){
  if(!sql||!pushEnabled||!userId)return;
  const subscriptions=await sql`SELECT id,subscription FROM push_subscriptions WHERE user_id=${userId}`;
  await Promise.all(subscriptions.map(async row=>{try{await webpush.sendNotification(row.subscription,JSON.stringify(payload),{TTL:86400,urgency:'high'})}catch(error){if([404,410].includes(error.statusCode))await sql`DELETE FROM push_subscriptions WHERE id=${row.id}`;else console.error('Push delivery failed:',error.message)}}));
}

async function addNotification(userId, actorId, taskId, type, title, message) {
  if (!sql || !userId || userId === actorId) return;
  const[item]=await sql`INSERT INTO notifications (user_id, actor_id, task_id, type, title, message) VALUES (${userId}, ${actorId}, ${taskId}, ${type}, ${title}, ${message}) RETURNING *`;
  io?.to(`user:${userId}`).emit('notification',item);
  await sendPush(userId,{notificationId:item.id,title,body:message,type,url:taskId?`/?task=${taskId}`:'/',tag:`${type}-${item.id}`});
}

async function addWorkspaceNotification(userId, actorId, type, title, message, chatChannelId = null, meetingId = null) {
  if (!sql || !userId || userId === actorId) return;
  const[item]=await sql`INSERT INTO notifications (user_id, actor_id, type, title, message, chat_channel_id, meeting_id) VALUES (${userId}, ${actorId}, ${type}, ${title}, ${message}, ${chatChannelId}, ${meetingId}) RETURNING *`;
  io?.to(`user:${userId}`).emit('notification',item);
  await sendPush(userId,{notificationId:item.id,title,body:message,type,url:chatChannelId?`/?view=chat&channel=${chatChannelId}`:meetingId?`/?view=calendar&meeting=${meetingId}`:'/',tag:`${type}-${item.id}`});
}

async function sendMeetingChatInvitation(organizer, attendeeId, meeting) {
  if (!sql || !attendeeId || attendeeId === organizer.id) return;
  let [channel]=await sql`SELECT c.* FROM chat_channels c WHERE c.channel_type='direct' AND EXISTS(SELECT 1 FROM chat_channel_members m WHERE m.channel_id=c.id AND m.user_id=${organizer.id}) AND EXISTS(SELECT 1 FROM chat_channel_members m WHERE m.channel_id=c.id AND m.user_id=${attendeeId}) AND (SELECT COUNT(*) FROM chat_channel_members m WHERE m.channel_id=c.id)=2`;
  if(!channel){const[target]=await sql`SELECT name FROM users WHERE id=${attendeeId}`;if(!target)return;[channel]=await sql`INSERT INTO chat_channels(name,channel_type,created_by) VALUES(${target.name},'direct',${organizer.id}) RETURNING *`;await sql`INSERT INTO chat_channel_members(channel_id,user_id) VALUES(${channel.id},${organizer.id}),(${channel.id},${attendeeId})`;}
  const joinUrl=`${process.env.APP_URL||`http://localhost:${port}`}?meeting=${encodeURIComponent(meeting.room_name)}`;
  const message=`📹 ${meeting.title}\nJoin the internal DSS Flow meeting: ${joinUrl}`;
  const[item]=await sql`INSERT INTO chat_messages(channel_id,user_id,message) VALUES(${channel.id},${organizer.id},${message}) RETURNING *`;
  io?.to(`user:${attendeeId}`).emit('chat-message',{channel_id:channel.id,message_id:item.id});
}

async function syncAppRelease(){
  if(!sql||!isProductionRelease)return;
  const [release]=await sql`INSERT INTO app_releases(version,title,notes) VALUES(${appVersion},${appReleaseTitle},${appReleaseNotes}) ON CONFLICT(version) DO NOTHING RETURNING version`;
  if(!release)return;
  const [{release_count:releaseCount}]=await sql`SELECT COUNT(*)::int AS release_count FROM app_releases`;
  if(releaseCount<=1)return;
  const notifications=await sql`INSERT INTO notifications(user_id,type,title,message) SELECT id,'app_update',${appReleaseTitle},${appReleaseNotes} FROM users WHERE status='active' RETURNING *`;
  notifications.forEach(item=>io?.to(`user:${item.user_id}`).emit('notification',item));
  const deliveries=notifications.map(item=>sendPush(item.user_id,{notificationId:item.id,title:appReleaseTitle,body:appReleaseNotes,type:'app_update',url:'/',tag:`app_update-${item.id}`}));
  const results=await Promise.allSettled(deliveries);
  const failed=results.filter(result=>result.status==='rejected');
  if(failed.length)console.error(`Release ${appVersion}: ${failed.length} push deliveries failed.`);
}

const demo = {
  users: [
    { id: 1, name: 'Vamsi Krishna', email: 'vamsi@dsscorps.com', role: 'Workspace Admin', avatar_color: '#f48b45', status: 'active' },
    { id: 2, name: 'Maya Chen', email: 'maya@dsscorps.com', role: 'Product Designer', avatar_color: '#8b7cf6', status: 'active' },
    { id: 3, name: 'Noah Williams', email: 'noah@dsscorps.com', role: 'Developer', avatar_color: '#24c8d8', status: 'active' },
    { id: 4, name: 'Amara Okafor', email: 'amara@dsscorps.com', role: 'QA Engineer', avatar_color: '#58c589', status: 'active' },
    { id: 5, name: 'Ethan Park', email: 'ethan@dsscorps.com', role: 'Developer', avatar_color: '#ef6f7a', status: 'active' },
  ],
  teams: [
    { id: 1, name: 'Product & Design', description: 'Research, UX and product strategy', color: '#8b7cf6', member_ids: [1, 2] },
    { id: 2, name: 'Engineering', description: 'Web platform and infrastructure', color: '#24c8d8', member_ids: [1, 3, 5] },
    { id: 3, name: 'Quality Assurance', description: 'Testing and release quality', color: '#58c589', member_ids: [4] },
  ],
  projects: [
    { id: 1, name: 'Client Portal Redesign', description: 'A faster, clearer experience for every customer.', color: '#24c8d8', status: 'active', due_date: '2026-08-28' },
    { id: 2, name: 'Mobile App v2', description: 'Rebuild the core mobile experience.', color: '#8b7cf6', status: 'active', due_date: '2026-09-15' },
    { id: 3, name: 'Q3 Marketing Site', description: 'New campaign pages and performance updates.', color: '#f48b45', status: 'active', due_date: '2026-08-12' },
  ],
  tasks: [
    { id: 1, title: 'Map the new onboarding journey', description: 'Document all entry points and key decisions.', project_id: 1, assignee_id: 2, team_id: 1, status: 'todo', priority: 'high', due_date: '2026-08-02' },
    { id: 2, title: 'Build authentication screens', description: 'Implement login, password reset and SSO states.', project_id: 1, assignee_id: 3, team_id: 2, status: 'in_progress', priority: 'high', due_date: '2026-08-05' },
    { id: 3, title: 'Set up component test suite', description: 'Add coverage for shared UI components.', project_id: 1, assignee_id: 4, team_id: 3, status: 'review', priority: 'medium', due_date: '2026-08-07' },
    { id: 4, title: 'Customer dashboard UI', description: 'Build responsive cards and activity feed.', project_id: 1, assignee_id: 5, team_id: 2, status: 'in_progress', priority: 'medium', due_date: '2026-08-09' },
    { id: 5, title: 'Finalize design tokens', description: 'Publish the approved color and type tokens.', project_id: 1, assignee_id: 2, team_id: 1, status: 'done', priority: 'low', due_date: '2026-07-28' },
    { id: 6, title: 'API error handling', description: 'Standardize error payloads and logging.', project_id: 2, assignee_id: 3, team_id: 2, status: 'todo', priority: 'urgent', due_date: '2026-08-10' },
    { id: 7, title: 'Regression testing', description: 'Run the full release checklist.', project_id: 2, assignee_id: 4, team_id: 3, status: 'review', priority: 'high', due_date: '2026-08-11' },
    { id: 8, title: 'Optimize hero illustrations', description: 'Export optimized responsive assets.', project_id: 3, assignee_id: 2, team_id: 1, status: 'done', priority: 'medium', due_date: '2026-07-30' },
  ],
  invitations: [{ id: 1, email: 'sarah@dsscorps.com', role: 'Member', status: 'pending', created_at: new Date().toISOString() }],
};

const nextId = (items) => Math.max(0, ...items.map((x) => x.id)) + 1;
const sendError = (res, error) => { console.error(error); res.status(500).json({ error: error.message || 'Something went wrong' }); };

async function initDatabase() {
  if (!sql) return;
  const schema = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  for (const statement of schema.split(';').map((s) => s.trim()).filter(Boolean)) await sql.query(statement);
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const email = process.env.ADMIN_EMAIL.trim().toLowerCase();
    const existing = await sql`SELECT id, password_hash FROM users WHERE email = ${email}`;
    if (!existing.length) {
      const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
      await sql`INSERT INTO users (name, email, role, avatar_color, password_hash) VALUES ('DSS Administrator', ${email}, 'Workspace Admin', '#f48b45', ${passwordHash})`;
    } else if (!existing[0].password_hash) {
      const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
      await sql`UPDATE users SET password_hash = ${passwordHash}, role = 'Workspace Admin' WHERE id = ${existing[0].id}`;
    }
  }
  await sql`INSERT INTO chat_channels (name, channel_type, team_id) SELECT t.name, 'team', t.id FROM teams t WHERE NOT EXISTS (SELECT 1 FROM chat_channels c WHERE c.team_id=t.id)`;
  await sql`INSERT INTO chat_channel_members (channel_id, user_id) SELECT c.id, tm.user_id FROM chat_channels c JOIN team_members tm ON tm.team_id=c.team_id WHERE c.channel_type='team' ON CONFLICT DO NOTHING`;
  await sql`UPDATE invitations i SET status='accepted',accepted_at=COALESCE(i.accepted_at,NOW()) FROM users u WHERE (i.user_id=u.id OR LOWER(i.email)=LOWER(u.email)) AND i.status='pending' AND u.must_change_password=FALSE`;
  await syncAppRelease();
}

let databaseReadyPromise;
const ensureDatabase=()=>databaseReadyPromise||(databaseReadyPromise=initDatabase());
app.use(async(_req,res,next)=>{try{await ensureDatabase();next()}catch(error){sendError(res,error)}});

app.get('/api/health', (_req, res) => res.json({ ok: true, database: sql ? 'neon' : 'demo' }));

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  try {
    let user;
    if (!sql) {
      const allowedEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
      if (!allowedEmail || email !== allowedEmail || password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Email or password is incorrect' });
      user = { ...demo.users[0], email: allowedEmail };
      const token = crypto.randomBytes(32).toString('hex');
      demoSessions.add(token);
      res.cookie(SESSION_COOKIE, token, cookieOptions);
    } else {
      [user] = await sql`SELECT id, name, email, role, avatar_color, status, work_status, status_note, password_hash, must_change_password FROM users WHERE email = ${email}`;
      if (!user?.password_hash || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Email or password is incorrect' });
      if (user.status !== 'active') return res.status(403).json({ error: 'Your workspace access has been suspended. Contact an administrator.' });
      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
      await sql`DELETE FROM sessions WHERE expires_at < NOW()`;
      await sql`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (${hashToken(token)}, ${user.id}, ${expires})`;
      await sql`UPDATE invitations SET status='accepted', accepted_at=COALESCE(accepted_at,NOW()) WHERE LOWER(email)=${email} AND status<>'accepted'`;
      res.cookie(SESSION_COOKIE, token, cookieOptions);
    }
    const { password_hash, ...safeUser } = user;
    res.json({ user: safeUser });
  } catch (error) { sendError(res, error); }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = req.cookies[SESSION_COOKIE];
    if (sql && token) await sql`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}`;
    if (!sql && token) demoSessions.delete(token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  } catch (error) { sendError(res, error); }
});

async function requireAuth(req, res, next) {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  if (!sql) {
    if (!demoSessions.has(token)) return res.status(401).json({ error: 'Session expired' });
    req.user = { ...demo.users[0], email: process.env.ADMIN_EMAIL };
    return next();
  }
  try {
    const [user] = await sql`SELECT u.id, u.name, u.email, u.role, u.avatar_color, u.status, u.work_status, u.status_note, u.must_change_password FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ${hashToken(token)} AND s.expires_at > NOW()`;
    if (!user) return res.status(401).json({ error: 'Session expired' });
    if (user.status !== 'active') return res.status(403).json({ error: 'Workspace access suspended' });
    await sql`UPDATE invitations SET status='accepted',accepted_at=COALESCE(accepted_at,NOW()) WHERE status='pending' AND (user_id=${user.id} OR LOWER(email)=LOWER(${user.email}))`;
    req.user = user;
    next();
  } catch (error) { sendError(res, error); }
}

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const newPassword = String(req.body.new_password || '');
  if (newPassword.length < 10 || !/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/\d/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword)) return res.status(400).json({ error: 'Use at least 10 characters with upper and lowercase letters, a number, and a symbol' });
  try {
    if (!sql) { req.user.must_change_password = false; return res.json({ user: req.user }); }
    const passwordHash = await bcrypt.hash(newPassword, 12);
    const [user] = await sql`UPDATE users SET password_hash=${passwordHash}, must_change_password=FALSE WHERE id=${req.user.id} RETURNING id, name, email, role, avatar_color, status, work_status, status_note, must_change_password`;
    res.json({ user });
  } catch (error) { sendError(res, error); }
});
app.use('/api', requireAuth);
app.use('/api', (req, res, next) => req.user.must_change_password ? res.status(403).json({ error: 'Set a new password before continuing' }) : next());

function requireWorkspaceManager(req, res, next) {
  if (['Employee', 'Guest'].includes(req.user.role)) return res.status(403).json({ error: 'Your role does not have permission to manage the workspace' });
  next();
}

app.get('/api/dashboard', async (req, res) => {
  try {
    if (!sql) return res.json(demo);
    const [users, teamsRaw, projects, tasks, invitations, links, notifications, meetingsRaw, meetingLinks] = await Promise.all([
      sql`SELECT u.id,u.name,u.email,u.role,u.avatar_color,u.status,u.work_status,u.status_note,u.status_updated_at,u.created_at,COALESCE((SELECT i.status FROM invitations i WHERE i.user_id=u.id OR LOWER(i.email)=LOWER(u.email) ORDER BY i.created_at DESC LIMIT 1),'accepted') AS invitation_status FROM users u ORDER BY u.name`, sql`SELECT * FROM teams ORDER BY created_at`,
      sql`SELECT * FROM projects ORDER BY created_at`, sql`SELECT * FROM tasks ORDER BY created_at`,
      sql`SELECT i.* FROM invitations i JOIN users u ON u.id=i.user_id WHERE i.status='pending' AND u.status='active' AND u.must_change_password=TRUE ORDER BY i.created_at DESC`, sql`SELECT * FROM team_members`,
      sql`SELECT n.*, a.name AS actor_name FROM notifications n LEFT JOIN users a ON a.id=n.actor_id WHERE n.user_id=${req.user.id} ORDER BY n.created_at DESC LIMIT 40`,
      sql`SELECT m.*, u.name AS organizer_name FROM meetings m LEFT JOIN users u ON u.id=m.organizer_id WHERE m.organizer_id=${req.user.id} OR EXISTS (SELECT 1 FROM meeting_attendees ma WHERE ma.meeting_id=m.id AND ma.user_id=${req.user.id}) ORDER BY m.start_at`,
      sql`SELECT ma.* FROM meeting_attendees ma WHERE ma.meeting_id IN (SELECT m.id FROM meetings m WHERE m.organizer_id=${req.user.id} OR EXISTS (SELECT 1 FROM meeting_attendees x WHERE x.meeting_id=m.id AND x.user_id=${req.user.id}))`,
    ]);
    const teams = teamsRaw.map((t) => ({ ...t, member_ids: links.filter((l) => l.team_id === t.id).map((l) => l.user_id) }));
    const meetings = meetingsRaw.map(m=>({...m,attendee_ids:meetingLinks.filter(x=>x.meeting_id===m.id).map(x=>x.user_id)}));
    res.json({ users, teams, projects, tasks, invitations, notifications, meetings });
  } catch (error) { sendError(res, error); }
});

app.get('/api/app-version',async(_req,res)=>{try{if(!sql)return res.json({version:appVersion,title:appReleaseTitle,notes:appReleaseNotes});const[release]=await sql`SELECT * FROM app_releases WHERE version=${appVersion}`;res.json({version:appVersion,title:release?.title||appReleaseTitle,notes:release?.notes||appReleaseNotes})}catch(error){sendError(res,error)}});

app.post('/api/projects', requireWorkspaceManager, async (req, res) => {
  const { name, description = '', color = '#24c8d8', due_date = null } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Project name is required' });
  try {
    if (!sql) { const item = { id: nextId(demo.projects), name: name.trim(), description, color, due_date, status: 'active' }; demo.projects.push(item); return res.status(201).json(item); }
    const [item] = await sql`INSERT INTO projects (name, description, color, due_date) VALUES (${name.trim()}, ${description}, ${color}, ${due_date}) RETURNING *`;
    res.status(201).json(item);
  } catch (error) { sendError(res, error); }
});

app.patch('/api/projects/:id', requireWorkspaceManager, async (req, res) => {
  const id = Number(req.params.id); const { name, description, color, due_date, status } = req.body;
  try {
    if (!sql) { const item=demo.projects.find(p=>p.id===id); if(!item)return res.status(404).json({error:'Project not found'}); Object.assign(item,Object.fromEntries(Object.entries({name,description,color,due_date,status}).filter(([,v])=>v!==undefined))); return res.json(item); }
    const [current] = await sql`SELECT * FROM projects WHERE id=${id}`;
    if (!current) return res.status(404).json({ error: 'Project not found' });
    if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: 'Project name is required' });
    const [item] = await sql`UPDATE projects SET name=${name===undefined?current.name:String(name).trim()}, description=${description??current.description}, color=${color??current.color}, due_date=${due_date===undefined?current.due_date:due_date}, status=${status??current.status} WHERE id=${id} RETURNING *`;
    res.json(item);
  } catch (error) { sendError(res, error); }
});

app.delete('/api/projects/:id', requireWorkspaceManager, async (req, res) => {
  const id = Number(req.params.id);
  try {
    if (!sql) { demo.projects=demo.projects.filter(p=>p.id!==id); demo.tasks=demo.tasks.filter(t=>t.project_id!==id); return res.status(204).end(); }
    const result = await sql`DELETE FROM projects WHERE id=${id} RETURNING id`;
    if (!result.length) return res.status(404).json({ error: 'Project not found' });
    res.status(204).end();
  } catch (error) { sendError(res, error); }
});

app.post('/api/tasks', requireWorkspaceManager, async (req, res) => {
  const { title, description = '', project_id, assignee_id = null, team_id = null, status = 'todo', priority = 'medium', due_date = null } = req.body;
  if (!title?.trim() || !project_id) return res.status(400).json({ error: 'Title and project are required' });
  try {
    if (!sql) { const item = { id: nextId(demo.tasks), title: title.trim(), description, project_id: Number(project_id), assignee_id: assignee_id ? Number(assignee_id) : null, team_id: team_id ? Number(team_id) : null, status, priority, due_date }; demo.tasks.push(item); return res.status(201).json(item); }
    const [item] = await sql`INSERT INTO tasks (title, description, project_id, assignee_id, team_id, status, priority, due_date, created_by) VALUES (${title.trim()}, ${description}, ${project_id}, ${assignee_id}, ${team_id}, ${status}, ${priority}, ${due_date}, ${req.user.id}) RETURNING *`;
    await addNotification(assignee_id, req.user.id, item.id, 'assignment', 'New task assigned', item.title);
    res.status(201).json(item);
  } catch (error) { sendError(res, error); }
});

app.patch('/api/tasks/:id', async (req, res) => {
  const id = Number(req.params.id); const { title, description, assignee_id, team_id, status, priority, due_date, completion_summary, completion_notes } = req.body;
  try {
    if (!sql) { const item = demo.tasks.find((t) => t.id === id); if (!item) return res.status(404).json({ error: 'Task not found' }); Object.assign(item, Object.fromEntries(Object.entries({ title, description, assignee_id, team_id, status, priority, due_date }).filter(([,v]) => v !== undefined))); return res.json(item); }
    const current = (await sql`SELECT * FROM tasks WHERE id = ${id}`)[0];
    if (!current) return res.status(404).json({ error: 'Task not found' });
    if (['Employee', 'Guest'].includes(req.user.role) && description !== undefined && description !== current.description) return res.status(403).json({ error: 'Employees cannot edit task instructions' });
    if (status === 'done' && !String(completion_summary ?? current.completion_summary ?? '').trim()) return res.status(400).json({ error: 'Add a completion summary before marking this task done' });
    const completedAt = status === 'done' ? new Date() : status && status !== 'done' ? null : current.completed_at;
    const [item] = await sql`UPDATE tasks SET title=${title ?? current.title}, description=${description ?? current.description}, assignee_id=${assignee_id === undefined ? current.assignee_id : assignee_id}, team_id=${team_id === undefined ? current.team_id : team_id}, status=${status ?? current.status}, priority=${priority ?? current.priority}, due_date=${due_date === undefined ? current.due_date : due_date}, completion_summary=${completion_summary ?? current.completion_summary}, completion_notes=${completion_notes ?? current.completion_notes}, completed_at=${completedAt}, updated_at=NOW() WHERE id=${id} RETURNING *`;
    if (assignee_id && assignee_id !== current.assignee_id) await addNotification(assignee_id, req.user.id, id, 'assignment', 'Task assigned to you', item.title);
    if (status === 'done' && current.status !== 'done') await addNotification(current.created_by, req.user.id, id, 'completion', 'Task completed', `${item.title}: ${item.completion_summary}`);
    res.json(item);
  } catch (error) { sendError(res, error); }
});

app.delete('/api/tasks/:id', requireWorkspaceManager, async (req, res) => {
  const id = Number(req.params.id);
  try { if (!sql) demo.tasks = demo.tasks.filter((t) => t.id !== id); else await sql`DELETE FROM tasks WHERE id=${id}`; res.status(204).end(); } catch (error) { sendError(res, error); }
});

app.get('/api/tasks/:id/activity', async (req, res) => {
  if (!sql) return res.json({ messages: [], attachments: [] });
  try {
    const taskId = Number(req.params.id);
    const [messages, attachments] = await Promise.all([
      sql`SELECT m.*, u.name AS user_name, u.avatar_color FROM task_messages m LEFT JOIN users u ON u.id=m.user_id WHERE m.task_id=${taskId} ORDER BY m.created_at`,
      sql`SELECT a.id, a.task_id, a.filename, a.mime_type, a.file_size, a.created_at, u.name AS uploaded_by_name FROM task_attachments a LEFT JOIN users u ON u.id=a.uploaded_by WHERE a.task_id=${taskId} ORDER BY a.created_at`,
    ]);
    res.json({ messages, attachments });
  } catch (error) { sendError(res, error); }
});

app.post('/api/tasks/:id/messages', async (req, res) => {
  const taskId = Number(req.params.id); const message = String(req.body.message || '').trim(); const messageType = ['question', 'update', 'reply'].includes(req.body.message_type) ? req.body.message_type : 'question';
  if (!message) return res.status(400).json({ error: 'Write a message first' });
  try {
    if (!sql) return res.status(501).json({ error: 'Messages require a database connection' });
    const [task] = await sql`SELECT id, title, assignee_id, created_by FROM tasks WHERE id=${taskId}`;
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const [item] = await sql`INSERT INTO task_messages (task_id, user_id, message, message_type) VALUES (${taskId}, ${req.user.id}, ${message}, ${messageType}) RETURNING *`;
    const recipients = new Set([task.assignee_id, task.created_by]);
    await Promise.all([...recipients].map(userId=>addNotification(userId, req.user.id, taskId, messageType === 'question' ? 'question' : 'message', messageType === 'question' ? 'Question about a task' : 'New task message', `${task.title}: ${message}`)));
    res.status(201).json({ ...item, user_name: req.user.name, avatar_color: req.user.avatar_color });
  } catch (error) { sendError(res, error); }
});

app.post('/api/tasks/:id/attachments', upload.array('files', 5), async (req, res) => {
  try {
    if (!sql) return res.status(501).json({ error: 'Attachments require a database connection' });
    const taskId = Number(req.params.id); const [task] = await sql`SELECT id, title, assignee_id, created_by FROM tasks WHERE id=${taskId}`;
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!req.files?.length) return res.status(400).json({ error: 'Choose at least one document' });
    const items = [];
    for (const file of req.files) {
      const [item] = await sql`INSERT INTO task_attachments (task_id, uploaded_by, filename, mime_type, file_size, content) VALUES (${taskId}, ${req.user.id}, ${file.originalname}, ${file.mimetype}, ${file.size}, ${file.buffer}) RETURNING id, task_id, filename, mime_type, file_size, created_at`;
      items.push(item);
    }
    const recipient = req.user.id === task.assignee_id ? task.created_by : task.assignee_id;
    await addNotification(recipient, req.user.id, taskId, 'document', 'Documents added to a task', `${task.title}: ${items.map(i => i.filename).join(', ')}`);
    res.status(201).json(items);
  } catch (error) { sendError(res, error); }
});

app.get('/api/attachments/:id', async (req, res) => {
  try {
    const [file] = await sql`SELECT filename, mime_type, content FROM task_attachments WHERE id=${Number(req.params.id)}`;
    if (!file) return res.status(404).json({ error: 'Document not found' });
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    res.end(file.content);
  } catch (error) { sendError(res, error); }
});

app.get('/api/notifications',async(req,res)=>{
  const after=Math.max(0,Number(req.query.after)||0);
  try{
    if(!sql)return res.json([]);
    const items=after
      ? await sql`SELECT n.*,a.name AS actor_name FROM notifications n LEFT JOIN users a ON a.id=n.actor_id WHERE n.user_id=${req.user.id} AND n.id>${after} ORDER BY n.id ASC LIMIT 40`
      : await sql`SELECT n.*,a.name AS actor_name FROM notifications n LEFT JOIN users a ON a.id=n.actor_id WHERE n.user_id=${req.user.id} ORDER BY n.id DESC LIMIT 40`;
    res.json(items);
  }catch(error){sendError(res,error)}
});

app.patch('/api/notifications/:id/read', async (req, res) => {
  try { if (sql) await sql`UPDATE notifications SET is_read=TRUE WHERE id=${Number(req.params.id)} AND user_id=${req.user.id}`; res.status(204).end(); } catch (error) { sendError(res, error); }
});

app.post('/api/notifications/read-all', async (req, res) => {
  try { if (sql) await sql`UPDATE notifications SET is_read=TRUE WHERE user_id=${req.user.id}`; res.status(204).end(); } catch (error) { sendError(res, error); }
});

app.get('/api/push/config',(_req,res)=>res.json({enabled:pushEnabled,public_key:pushEnabled?process.env.VAPID_PUBLIC_KEY:''}));

app.post('/api/push/subscribe',async(req,res)=>{
  const subscription=req.body?.subscription||req.body,endpoint=String(subscription?.endpoint||'');
  if(!pushEnabled)return res.status(503).json({error:'Mobile push is not configured on the server'});
  if(!endpoint||!subscription?.keys?.p256dh||!subscription?.keys?.auth)return res.status(400).json({error:'Invalid push subscription'});
  try{await sql`INSERT INTO push_subscriptions(user_id,endpoint,subscription,user_agent) VALUES(${req.user.id},${endpoint},${JSON.stringify(subscription)}::jsonb,${String(req.headers['user-agent']||'').slice(0,500)}) ON CONFLICT(endpoint) DO UPDATE SET user_id=${req.user.id},subscription=${JSON.stringify(subscription)}::jsonb,user_agent=${String(req.headers['user-agent']||'').slice(0,500)},updated_at=NOW()`;res.status(201).json({subscribed:true})}catch(error){sendError(res,error)}
});

app.post('/api/push/test',async(req,res)=>{
  if(!pushEnabled)return res.status(503).json({error:'Push notifications are not configured on the server'});
  if(!sql)return res.status(503).json({error:'A database connection is required to test push notifications'});
  try{
    const title='DSS Flow test notification',message='Mobile and desktop push notifications are working correctly on this device.';
    const[item]=await sql`INSERT INTO notifications(user_id,actor_id,type,title,message) VALUES(${req.user.id},${req.user.id},'message',${title},${message}) RETURNING *`;
    io?.to(`user:${req.user.id}`).emit('notification',item);
    await sendPush(req.user.id,{notificationId:item.id,title,body:message,type:'message',url:'/',tag:`push-test-${item.id}`,timestamp:Date.now(),forceDisplay:true});
    res.json({sent:true});
  }catch(error){sendError(res,error)}
});

app.delete('/api/push/subscribe',async(req,res)=>{
  const endpoint=String(req.body?.endpoint||'');try{if(endpoint)await sql`DELETE FROM push_subscriptions WHERE endpoint=${endpoint} AND user_id=${req.user.id}`;res.status(204).end()}catch(error){sendError(res,error)}
});

app.post('/api/teams', requireWorkspaceManager, async (req, res) => {
  const { name, description = '', color = '#24c8d8', member_ids = [] } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Team name is required' });
  try {
    if (!sql) { const item = { id: nextId(demo.teams), name: name.trim(), description, color, member_ids: member_ids.map(Number) }; demo.teams.push(item); return res.status(201).json(item); }
    const [item] = await sql`INSERT INTO teams (name, description, color) VALUES (${name.trim()}, ${description}, ${color}) RETURNING *`;
    for (const userId of member_ids) await sql`INSERT INTO team_members (team_id, user_id) VALUES (${item.id}, ${userId}) ON CONFLICT DO NOTHING`;
    const [channel] = await sql`INSERT INTO chat_channels (name, channel_type, team_id, created_by) VALUES (${name.trim()}, 'team', ${item.id}, ${req.user.id}) RETURNING id`;
    for (const userId of member_ids) await sql`INSERT INTO chat_channel_members (channel_id, user_id) VALUES (${channel.id}, ${userId}) ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO chat_channel_members (channel_id, user_id) VALUES (${channel.id}, ${req.user.id}) ON CONFLICT DO NOTHING`;
    res.status(201).json({ ...item, member_ids });
  } catch (error) { sendError(res, error); }
});

app.patch('/api/teams/:id/members',requireWorkspaceManager,async(req,res)=>{
  const teamId=Number(req.params.id),requested=[...new Set((req.body.user_ids||[]).map(Number).filter(Boolean))].slice(0,100);
  if(!requested.length)return res.status(400).json({error:'Select at least one employee'});
  try{
    if(!sql){const team=demo.teams.find(item=>item.id===teamId);if(!team)return res.status(404).json({error:'Team not found'});team.member_ids=[...new Set([...(team.member_ids||[]),...requested])];return res.json({member_ids:team.member_ids,added:requested.length})}
    const[team]=await sql`SELECT id,name FROM teams WHERE id=${teamId}`;if(!team)return res.status(404).json({error:'Team not found'});
    let[channel]=await sql`SELECT id FROM chat_channels WHERE team_id=${teamId} AND channel_type='team' LIMIT 1`;
    if(!channel)[channel]=await sql`INSERT INTO chat_channels(name,channel_type,team_id,created_by) VALUES(${team.name},'team',${teamId},${req.user.id}) RETURNING id`;
    const added=[];
    for(const userId of requested){
      const[user]=await sql`SELECT id FROM users WHERE id=${userId} AND status='active'`;if(!user)continue;
      const[link]=await sql`INSERT INTO team_members(team_id,user_id) VALUES(${teamId},${userId}) ON CONFLICT DO NOTHING RETURNING user_id`;
      await sql`INSERT INTO chat_channel_members(channel_id,user_id) VALUES(${channel.id},${userId}) ON CONFLICT DO NOTHING`;
      if(link){added.push(userId);await addWorkspaceNotification(userId,req.user.id,'team','Added to a team',`You were added to ${team.name}.`,channel.id,null)}
    }
    const members=await sql`SELECT user_id FROM team_members WHERE team_id=${teamId} ORDER BY user_id`;
    res.json({member_ids:members.map(item=>item.user_id),added:added.length});
  }catch(error){sendError(res,error)}
});

app.get('/api/chat/channels', async (req, res) => {
  try {
    await sql`INSERT INTO chat_message_receipts(message_id,user_id,delivered_at)
      SELECT cm.id,${req.user.id},NOW() FROM chat_messages cm
      JOIN chat_channel_members mine ON mine.channel_id=cm.channel_id AND mine.user_id=${req.user.id}
      WHERE cm.user_id<>${req.user.id}
      ON CONFLICT(message_id,user_id) DO UPDATE SET delivered_at=COALESCE(chat_message_receipts.delivered_at,NOW())`;
    const channels = await sql`SELECT c.*,
      (SELECT COALESCE(NULLIF(cm.message,''),'Attachment') FROM chat_messages cm WHERE cm.channel_id=c.id ORDER BY cm.created_at DESC LIMIT 1) AS last_message,
      (SELECT COALESCE(u.name,'Former employee') FROM chat_messages cm LEFT JOIN users u ON u.id=cm.user_id WHERE cm.channel_id=c.id ORDER BY cm.created_at DESC LIMIT 1) AS last_sender_name,
      (SELECT created_at FROM chat_messages cm WHERE cm.channel_id=c.id ORDER BY cm.created_at DESC LIMIT 1) AS last_message_at,
      (SELECT COUNT(*)::int FROM chat_messages cm WHERE cm.channel_id=c.id AND cm.user_id<>${req.user.id} AND NOT EXISTS(SELECT 1 FROM chat_message_receipts receipt WHERE receipt.message_id=cm.id AND receipt.user_id=${req.user.id} AND receipt.read_at IS NOT NULL)) AS unread_count
      FROM chat_channels c
      WHERE EXISTS (SELECT 1 FROM chat_channel_members m WHERE m.channel_id=c.id AND m.user_id=${req.user.id})
      AND (c.channel_type<>'direct' OR (SELECT COUNT(*) FROM chat_channel_members m WHERE m.channel_id=c.id)>1)
      ORDER BY COALESCE((SELECT created_at FROM chat_messages cm WHERE cm.channel_id=c.id ORDER BY cm.created_at DESC LIMIT 1),c.created_at) DESC`;
    const members = await sql`SELECT m.channel_id,u.id,u.name,u.avatar_color,u.role,u.work_status,u.status_note,u.status
      FROM chat_channel_members m JOIN users u ON u.id=m.user_id
      WHERE u.status='active' AND m.channel_id IN (SELECT channel_id FROM chat_channel_members WHERE user_id=${req.user.id})`;
    res.json(channels.map(c=>({...c,members:members.filter(m=>m.channel_id===c.id)})));
  } catch (error) { sendError(res, error); }
});

app.post('/api/chat/channels', async (req, res) => {
  try {
    const type = req.body.channel_type === 'team' ? 'team' : 'direct';
    if (type === 'team') {
      const teamId=Number(req.body.team_id); const [membership]=await sql`SELECT 1 FROM team_members WHERE team_id=${teamId} AND user_id=${req.user.id}`;
      if (!membership && ['Employee','Guest'].includes(req.user.role)) return res.status(403).json({error:'You are not a member of this team'});
      let [channel]=await sql`SELECT * FROM chat_channels WHERE team_id=${teamId} AND channel_type='team'`;
      if(!channel){const[team]=await sql`SELECT name FROM teams WHERE id=${teamId}`;if(!team)return res.status(404).json({error:'Team not found'});[channel]=await sql`INSERT INTO chat_channels(name,channel_type,team_id,created_by) VALUES(${team.name},'team',${teamId},${req.user.id}) RETURNING *`;await sql`INSERT INTO chat_channel_members(channel_id,user_id) SELECT ${channel.id},user_id FROM team_members WHERE team_id=${teamId} ON CONFLICT DO NOTHING`;}
      return res.status(201).json(channel);
    }
    const targetId=Number(req.body.user_id); if(!targetId||targetId===req.user.id)return res.status(400).json({error:'Choose another person'});
    let [channel]=await sql`SELECT c.* FROM chat_channels c WHERE c.channel_type='direct' AND EXISTS(SELECT 1 FROM chat_channel_members m WHERE m.channel_id=c.id AND m.user_id=${req.user.id}) AND EXISTS(SELECT 1 FROM chat_channel_members m WHERE m.channel_id=c.id AND m.user_id=${targetId}) AND (SELECT COUNT(*) FROM chat_channel_members m WHERE m.channel_id=c.id)=2`;
    if(!channel){const[target]=await sql`SELECT u.name FROM users u WHERE u.id=${targetId} AND u.status='active' AND (NOT EXISTS(SELECT 1 FROM invitations i WHERE i.user_id=u.id OR LOWER(i.email)=LOWER(u.email)) OR EXISTS(SELECT 1 FROM invitations i WHERE (i.user_id=u.id OR LOWER(i.email)=LOWER(u.email)) AND i.status='accepted'))`;if(!target)return res.status(404).json({error:'This employee has not accepted the invitation yet'});[channel]=await sql`INSERT INTO chat_channels(name,channel_type,created_by) VALUES(${target.name},'direct',${req.user.id}) RETURNING *`;await sql`INSERT INTO chat_channel_members(channel_id,user_id) VALUES(${channel.id},${req.user.id}),(${channel.id},${targetId})`;}
    res.status(201).json(channel);
  } catch (error) { sendError(res, error); }
});

app.get('/api/chat/channels/:id/messages', async (req, res) => {
  try {
    const channelId=Number(req.params.id);
    const[member]=await sql`SELECT 1 FROM chat_channel_members WHERE channel_id=${channelId} AND user_id=${req.user.id}`;
    if(!member)return res.status(403).json({error:'Chat access denied'});
    await sql`INSERT INTO chat_message_receipts(message_id,user_id,delivered_at,read_at)
      SELECT id,${req.user.id},NOW(),NOW() FROM chat_messages WHERE channel_id=${channelId} AND user_id<>${req.user.id}
      ON CONFLICT(message_id,user_id) DO UPDATE SET delivered_at=COALESCE(chat_message_receipts.delivered_at,NOW()),read_at=NOW()`;
    const messages=await sql`SELECT m.*,COALESCE(u.name,'Former employee') AS user_name,u.avatar_color,
      reply.message AS reply_message,COALESCE(reply_user.name,'Former employee') AS reply_user_name,
      (SELECT COUNT(*)::int FROM chat_channel_members cm WHERE cm.channel_id=m.channel_id AND cm.user_id<>m.user_id) AS recipient_count,
      (SELECT COUNT(*)::int FROM chat_message_receipts r WHERE r.message_id=m.id AND r.delivered_at IS NOT NULL) AS delivered_count,
      (SELECT COUNT(*)::int FROM chat_message_receipts r WHERE r.message_id=m.id AND r.read_at IS NOT NULL) AS read_count
      FROM chat_messages m LEFT JOIN users u ON u.id=m.user_id
      LEFT JOIN chat_messages reply ON reply.id=m.reply_to_id LEFT JOIN users reply_user ON reply_user.id=reply.user_id
      WHERE m.channel_id=${channelId} ORDER BY m.created_at LIMIT 300`;
    const attachments=await sql`SELECT a.id,a.message_id,a.filename,a.mime_type,a.file_size FROM chat_attachments a WHERE a.message_id IN (SELECT id FROM chat_messages WHERE channel_id=${channelId})`;
    const reactions=await sql`SELECT r.message_id,r.emoji,COUNT(*)::int AS count,BOOL_OR(r.user_id=${req.user.id}) AS reacted FROM chat_message_reactions r WHERE r.message_id IN (SELECT id FROM chat_messages WHERE channel_id=${channelId}) GROUP BY r.message_id,r.emoji ORDER BY MIN(r.created_at)`;
    res.json(messages.map(m=>({...m,attachments:attachments.filter(a=>a.message_id===m.id),reactions:reactions.filter(r=>r.message_id===m.id)})));
  } catch(error){sendError(res,error);}
});

app.post('/api/chat/channels/:id/messages', async (req, res) => {
  const channelId=Number(req.params.id),message=String(req.body.message||'').trim(),replyTo=Number(req.body.reply_to_id)||null;if(!message)return res.status(400).json({error:'Write a message first'});
  try { const[member]=await sql`SELECT 1 FROM chat_channel_members WHERE channel_id=${channelId} AND user_id=${req.user.id}`;if(!member)return res.status(403).json({error:'Chat access denied'});if(replyTo){const[reply]=await sql`SELECT 1 FROM chat_messages WHERE id=${replyTo} AND channel_id=${channelId}`;if(!reply)return res.status(400).json({error:'The replied message is unavailable'});}const[channel]=await sql`SELECT * FROM chat_channels WHERE id=${channelId}`;const[item]=await sql`INSERT INTO chat_messages(channel_id,user_id,message,reply_to_id) VALUES(${channelId},${req.user.id},${message},${replyTo}) RETURNING *`;const recipients=await sql`SELECT user_id FROM chat_channel_members WHERE channel_id=${channelId} AND user_id<>${req.user.id}`;const notificationTitle=replyTo?`${req.user.name} replied${channel.channel_type==='team'?` in ${channel.name}`:''}`:channel.channel_type==='team'?`${req.user.name} in ${channel.name}`:req.user.name;for(const person of recipients)await addWorkspaceNotification(person.user_id,req.user.id,'chat',notificationTitle,message,channelId,null);for(const person of recipients)io?.to(`user:${person.user_id}`).emit('chat-message',{channel_id:channelId,message_id:item.id});res.status(201).json({...item,user_name:req.user.name,avatar_color:req.user.avatar_color,attachments:[]}); } catch(error){sendError(res,error);}
});

app.post('/api/chat/channels/:id/attachments',upload.array('files',5),async(req,res)=>{
  const channelId=Number(req.params.id),caption=String(req.body.caption||'').trim(),replyTo=Number(req.body.reply_to_id)||null;try{const[member]=await sql`SELECT 1 FROM chat_channel_members WHERE channel_id=${channelId} AND user_id=${req.user.id}`;if(!member)return res.status(403).json({error:'Chat access denied'});if(!req.files?.length)return res.status(400).json({error:'Choose at least one image or document'});const[channel]=await sql`SELECT * FROM chat_channels WHERE id=${channelId}`;const[item]=await sql`INSERT INTO chat_messages(channel_id,user_id,message,reply_to_id) VALUES(${channelId},${req.user.id},${caption},${replyTo}) RETURNING *`;const attachments=[];for(const file of req.files){const[a]=await sql`INSERT INTO chat_attachments(message_id,filename,mime_type,file_size,content) VALUES(${item.id},${file.originalname},${file.mimetype},${file.size},${file.buffer}) RETURNING id,message_id,filename,mime_type,file_size`;attachments.push(a);}const recipients=await sql`SELECT user_id FROM chat_channel_members WHERE channel_id=${channelId} AND user_id<>${req.user.id}`;const preview=caption||`Sent ${attachments.length} file${attachments.length===1?'':'s'}`;for(const person of recipients){await addWorkspaceNotification(person.user_id,req.user.id,'chat',channel.channel_type==='team'?`New file in ${channel.name}`:`File from ${req.user.name}`,preview,channelId,null);io?.to(`user:${person.user_id}`).emit('chat-message',{channel_id:channelId,message_id:item.id});}res.status(201).json({...item,user_name:req.user.name,avatar_color:req.user.avatar_color,attachments});}catch(error){sendError(res,error);}
});

app.get('/api/chat/attachments/:id',async(req,res)=>{try{const[file]=await sql`SELECT a.filename,a.mime_type,a.content,m.channel_id FROM chat_attachments a JOIN chat_messages m ON m.id=a.message_id WHERE a.id=${Number(req.params.id)}`;if(!file)return res.status(404).json({error:'File not found'});const[member]=await sql`SELECT 1 FROM chat_channel_members WHERE channel_id=${file.channel_id} AND user_id=${req.user.id}`;if(!member)return res.status(403).json({error:'File access denied'});res.setHeader('Content-Type',file.mime_type);res.setHeader('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);res.end(file.content);}catch(error){sendError(res,error);}});

app.post('/api/chat/messages/:id/reactions',async(req,res)=>{
  const messageId=Number(req.params.id),emoji=String(req.body.emoji||'').trim().slice(0,20);if(!emoji)return res.status(400).json({error:'Choose a reaction'});
  try{const[message]=await sql`SELECT m.id,m.channel_id FROM chat_messages m JOIN chat_channel_members cm ON cm.channel_id=m.channel_id WHERE m.id=${messageId} AND cm.user_id=${req.user.id}`;if(!message)return res.status(404).json({error:'Message not found'});const[existing]=await sql`SELECT 1 FROM chat_message_reactions WHERE message_id=${messageId} AND user_id=${req.user.id} AND emoji=${emoji}`;if(existing)await sql`DELETE FROM chat_message_reactions WHERE message_id=${messageId} AND user_id=${req.user.id} AND emoji=${emoji}`;else await sql`INSERT INTO chat_message_reactions(message_id,user_id,emoji) VALUES(${messageId},${req.user.id},${emoji})`;io?.to(`chat:${message.channel_id}`).emit('chat-message',{channel_id:message.channel_id,message_id:messageId});res.json({reacted:!existing});}catch(error){sendError(res,error)}
});

app.post('/api/chat/messages/:id/forward',async(req,res)=>{
  const sourceId=Number(req.params.id),channelIds=[...new Set((req.body.channel_ids||[]).map(Number).filter(Boolean))].slice(0,20);if(!channelIds.length)return res.status(400).json({error:'Choose at least one conversation'});
  try{const[source]=await sql`SELECT m.* FROM chat_messages m JOIN chat_channel_members cm ON cm.channel_id=m.channel_id WHERE m.id=${sourceId} AND cm.user_id=${req.user.id}`;if(!source)return res.status(404).json({error:'Message not found'});const created=[];for(const channelId of channelIds){const[member]=await sql`SELECT 1 FROM chat_channel_members WHERE channel_id=${channelId} AND user_id=${req.user.id}`;if(!member)continue;const[item]=await sql`INSERT INTO chat_messages(channel_id,user_id,message,forwarded_from_id) VALUES(${channelId},${req.user.id},${source.message},${sourceId}) RETURNING *`;await sql`INSERT INTO chat_attachments(message_id,filename,mime_type,file_size,content) SELECT ${item.id},filename,mime_type,file_size,content FROM chat_attachments WHERE message_id=${sourceId}`;const recipients=await sql`SELECT user_id FROM chat_channel_members WHERE channel_id=${channelId} AND user_id<>${req.user.id}`;for(const person of recipients)io?.to(`user:${person.user_id}`).emit('chat-message',{channel_id:channelId,message_id:item.id});created.push(item);}res.status(201).json({forwarded:created.length});}catch(error){sendError(res,error)}
});

app.post('/api/meetings', async (req, res) => {
  const {title,description='',team_id=null,start_at,end_at,attendee_ids=[],meeting_mode='video',is_instant=false}=req.body;const start=new Date(start_at),end=new Date(end_at),mode=meeting_mode==='voice'?'voice':'video';if(!String(title||'').trim())return res.status(400).json({error:'Meeting title is required'});if(!start_at||!end_at||Number.isNaN(start.valueOf())||Number.isNaN(end.valueOf())||end<=start)return res.status(400).json({error:'Choose a valid start and end time'});
  try { const roomName=`DSSFlow-${crypto.randomBytes(10).toString('hex')}`;const[item]=await sql`INSERT INTO meetings(title,description,organizer_id,team_id,start_at,end_at,room_name,meeting_mode,is_instant) VALUES(${String(title).trim()},${description},${req.user.id},${team_id},${start},${end},${roomName},${mode},${Boolean(is_instant)}) RETURNING *`;const attendees=new Set(attendee_ids.map(Number));if(team_id){const members=await sql`SELECT user_id FROM team_members WHERE team_id=${team_id}`;members.forEach(m=>attendees.add(m.user_id));}attendees.add(req.user.id);for(const userId of attendees)await sql`INSERT INTO meeting_attendees(meeting_id,user_id,response) VALUES(${item.id},${userId},${userId===req.user.id?'accepted':'invited'}) ON CONFLICT DO NOTHING`;for(const userId of attendees){await addWorkspaceNotification(userId,req.user.id,'meeting',is_instant?'Instant meeting started':'Meeting scheduled',`${item.title} · ${start.toLocaleString()}`,null,item.id);if(is_instant)await sendMeetingChatInvitation(req.user,userId,item)}res.status(201).json({...item,attendee_ids:[...attendees]}); } catch(error){sendError(res,error);}
});

app.post('/api/meetings/join', async (req,res)=>{
  const input=String(req.body.link||req.body.room_name||'').trim();if(!input)return res.status(400).json({error:'Enter a meeting link'});
  let roomName=input;try{const parsed=new URL(input);roomName=parsed.searchParams.get('meeting')||parsed.pathname.split('/').filter(Boolean).pop()||''}catch{const match=input.match(/[?&]meeting=([^&]+)/);if(match)roomName=decodeURIComponent(match[1])}
  roomName=String(roomName).trim().slice(0,180);if(!roomName)return res.status(400).json({error:'This meeting link is not valid'});
  try{const[meeting]=await sql`SELECT m.*,u.name AS organizer_name FROM meetings m LEFT JOIN users u ON u.id=m.organizer_id WHERE m.room_name=${roomName} AND m.status<>'cancelled'`;if(!meeting)return res.status(404).json({error:'Meeting not found or no longer available'});await sql`INSERT INTO meeting_attendees(meeting_id,user_id,response) VALUES(${meeting.id},${req.user.id},'accepted') ON CONFLICT(meeting_id,user_id) DO UPDATE SET response='accepted'`;const attendees=await sql`SELECT user_id FROM meeting_attendees WHERE meeting_id=${meeting.id}`;res.json({...meeting,attendee_ids:attendees.map(item=>item.user_id)})}catch(error){sendError(res,error)}
});

app.patch('/api/meetings/:id', async (req, res) => {
  const id=Number(req.params.id);try{const[current]=await sql`SELECT * FROM meetings WHERE id=${id}`;if(!current)return res.status(404).json({error:'Meeting not found'});if(current.organizer_id!==req.user.id&&['Employee','Guest'].includes(req.user.role))return res.status(403).json({error:'Only the organizer can update this meeting'});const title=req.body.title??current.title,description=req.body.description??current.description,start=req.body.start_at?new Date(req.body.start_at):current.start_at,end=req.body.end_at?new Date(req.body.end_at):current.end_at,status=req.body.status??current.status;if(end<=start)return res.status(400).json({error:'End time must be after start time'});const[item]=await sql`UPDATE meetings SET title=${title},description=${description},start_at=${start},end_at=${end},status=${status} WHERE id=${id} RETURNING *`;const attendees=await sql`SELECT user_id FROM meeting_attendees WHERE meeting_id=${id}`;for(const person of attendees)await addWorkspaceNotification(person.user_id,req.user.id,'meeting',status==='cancelled'?'Meeting cancelled':'Meeting updated',`${item.title} · ${new Date(item.start_at).toLocaleString()}`,null,id);res.json(item);}catch(error){sendError(res,error);}
});

app.patch('/api/users/:id', requireWorkspaceManager, async (req, res) => {
  const id=Number(req.params.id),allowedRoles=['Employee','Member','Project Manager','Workspace Admin','Guest'],allowedStatuses=['active','suspended'];
  try{const[current]=await sql`SELECT id,name,email,role,status FROM users WHERE id=${id}`;if(!current)return res.status(404).json({error:'Employee not found'});const role=req.body.role??current.role,status=req.body.status??current.status;if(!allowedRoles.includes(role)||!allowedStatuses.includes(status))return res.status(400).json({error:'Invalid role or access status'});if(id===req.user.id&&(role!==current.role||status!=='active'))return res.status(400).json({error:'You cannot change your own administrator access'});if(current.role==='Workspace Admin'&&(role!=='Workspace Admin'||status==='suspended')){const[count]=await sql`SELECT COUNT(*)::int AS total FROM users WHERE role='Workspace Admin' AND status='active'`;if(count.total<=1)return res.status(400).json({error:'At least one active workspace administrator is required'});}const[item]=await sql`UPDATE users SET role=${role},status=${status} WHERE id=${id} RETURNING id,name,email,role,avatar_color,status,created_at`;if(status==='suspended')await sql`DELETE FROM sessions WHERE user_id=${id}`;res.json(item);}catch(error){sendError(res,error);}
});

app.post('/api/users/:id/reset-password', requireWorkspaceManager, async (req, res) => {
  const id=Number(req.params.id);if(id===req.user.id)return res.status(400).json({error:'Use the change-password screen for your own account'});
  try{const[user]=await sql`SELECT id,name,email,status FROM users WHERE id=${id}`;if(!user)return res.status(404).json({error:'Employee not found'});const temporaryPassword=makeTemporaryPassword(),passwordHash=await bcrypt.hash(temporaryPassword,12);await sql`UPDATE users SET password_hash=${passwordHash},must_change_password=TRUE,status='active' WHERE id=${id}`;await sql`DELETE FROM sessions WHERE user_id=${id}`;let emailSent=false;if(mailer){await mailer.sendMail({from:process.env.MAIL_FROM||process.env.SMTP_USER,to:user.email,subject:'Your DSS Flow password was reset',text:`Hello ${user.name},\n\nYour DSS Flow password has been reset.\n\nLogin: ${user.email}\nTemporary password: ${temporaryPassword}\nOpen: ${process.env.APP_URL||`http://localhost:${port}`}\n\nYou must create a new password after signing in.`,...brandedEmail({eyebrow:'ACCOUNT SECURITY',title:'Your DSS Flow password was reset',greeting:`Hello ${user.name},`,content:`<p style="color:#59677c;font-size:14px;line-height:1.65">An administrator reset your workspace password.</p><div style="background:#f3f6f9;padding:18px;border-radius:10px"><p style="margin:0 0 10px"><strong>Login:</strong> ${escapeHtml(user.email)}</p><p style="margin:0"><strong>Temporary password:</strong> <span style="font-family:monospace;font-size:15px">${escapeHtml(temporaryPassword)}</span></p></div><p style="color:#6f7c8f;font-size:13px">You must create a new private password after signing in.</p>`})});emailSent=true;}res.json({email:user.email,email_sent:emailSent,...(!emailSent&&{temporary_password:temporaryPassword})});}catch(error){sendError(res,error);}
});

app.delete('/api/users/:id', requireWorkspaceManager, async (req, res) => {
  const id=Number(req.params.id);if(id===req.user.id)return res.status(400).json({error:'You cannot remove your own administrator account'});
  try{const[user]=await sql`SELECT id,email,role,status FROM users WHERE id=${id}`;if(!user)return res.status(404).json({error:'Employee not found'});if(user.role==='Workspace Admin'&&user.status==='active'){const[count]=await sql`SELECT COUNT(*)::int AS total FROM users WHERE role='Workspace Admin' AND status='active'`;if(count.total<=1)return res.status(400).json({error:'At least one active workspace administrator is required'});}await sql`DELETE FROM invitations WHERE user_id=${id} OR email=${user.email}`;await sql`DELETE FROM users WHERE id=${id}`;res.status(204).end();}catch(error){sendError(res,error);}
});

app.patch('/api/users/me/status', async (req,res)=>{
  const allowed=['available','busy','lunch','break','in_meeting','offline'],workStatus=String(req.body.work_status||'');const note=String(req.body.status_note||'').trim().slice(0,180);if(!allowed.includes(workStatus))return res.status(400).json({error:'Choose a valid work status'});
  try{const[item]=await sql`UPDATE users SET work_status=${workStatus},status_note=${note},status_updated_at=NOW() WHERE id=${req.user.id} RETURNING id,name,email,role,avatar_color,status,work_status,status_note,status_updated_at`;io?.emit('presence-update',item);res.json(item);}catch(error){sendError(res,error);}
});

app.get('/api/webrtc-config',(_req,res)=>{const iceServers=[];if(process.env.STUN_URL)iceServers.push({urls:process.env.STUN_URL});if(process.env.TURN_URL)iceServers.push({urls:process.env.TURN_URL,username:process.env.TURN_USERNAME||'',credential:process.env.TURN_CREDENTIAL||''});res.json({iceServers,provider:'DSS Flow internal WebRTC'});});

app.post('/api/invitations', requireWorkspaceManager, async (req, res) => {
  const { email, name = '', role = 'Employee' } = req.body;
  if (!/^\S+@\S+\.\S+$/.test(email || '')) return res.status(400).json({ error: 'Enter a valid email address' });
  try {
    if (!sql) { const item = { id: nextId(demo.invitations), email: email.toLowerCase(), role, status: 'pending', created_at: new Date().toISOString() }; demo.invitations.unshift(item); return res.status(201).json(item); }
    const normalizedEmail = email.trim().toLowerCase();
    const existing = await sql`SELECT id FROM users WHERE email=${normalizedEmail}`;
    if (existing.length) return res.status(409).json({ error: 'A user with this email already exists' });
    const temporaryPassword = makeTemporaryPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);
    const displayName = name.trim() || normalizedEmail.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const allowedRole = ['Employee', 'Member', 'Project Manager', 'Workspace Admin', 'Guest'].includes(role) ? role : 'Employee';
    const [user] = await sql`INSERT INTO users (name, email, role, password_hash, must_change_password) VALUES (${displayName}, ${normalizedEmail}, ${allowedRole}, ${passwordHash}, TRUE) RETURNING id`;
    const [item] = await sql`INSERT INTO invitations (email, role, user_id) VALUES (${normalizedEmail}, ${allowedRole}, ${user.id}) RETURNING *`;
    let emailSent = false;
    if (mailer) {
      await mailer.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER, to: normalizedEmail, subject: 'You’re invited to DSS Flow',
        text: `Hello ${displayName},\n\nYou have been invited to DSS Flow as ${allowedRole}.\n\nLogin: ${normalizedEmail}\nTemporary password: ${temporaryPassword}\nOpen: ${process.env.APP_URL || `http://localhost:${port}`}\n\nYou will be asked to create a new password after signing in.`,
        ...brandedEmail({eyebrow:'EMPLOYEE INVITATION',title:'Welcome to DSS Flow',greeting:`Hello ${displayName},`,content:`<p style="color:#59677c;font-size:14px;line-height:1.65">You have been invited as <strong>${escapeHtml(allowedRole)}</strong>.</p><div style="background:#f3f6f9;padding:18px;border-radius:10px"><p style="margin:0 0 10px"><strong>Login:</strong> ${escapeHtml(normalizedEmail)}</p><p style="margin:0"><strong>Temporary password:</strong> <span style="font-family:monospace;font-size:15px">${escapeHtml(temporaryPassword)}</span></p></div><p style="color:#6f7c8f;font-size:13px;line-height:1.6">For your security, DSS Flow will ask you to create a new private password immediately after signing in.</p>`}),
      });
      emailSent = true;
    }
    res.status(201).json({ ...item, email_sent: emailSent, ...(!emailSent && { temporary_password: temporaryPassword }) });
  } catch (error) { sendError(res, error); }
});

const dist = path.join(__dirname, '..', 'dist');
if(!process.env.VERCEL){app.use(express.static(dist));app.get('*splat', (_req, res) => res.sendFile(path.join(dist, 'index.html')))}

const httpServer=http.createServer(app);
io=new SocketServer(httpServer,{path:'/api/realtime',cors:{origin:true,credentials:true},maxHttpBufferSize:4e6});
let realtimeAdapterPromise;
const ensureRealtimeAdapter=()=>{if(!process.env.REDIS_URL)return Promise.resolve();if(!realtimeAdapterPromise)realtimeAdapterPromise=(async()=>{const publisher=createClient({url:process.env.REDIS_URL}),subscriber=publisher.duplicate();publisher.on('error',error=>console.error('Redis publisher error:',error.message));subscriber.on('error',error=>console.error('Redis subscriber error:',error.message));await Promise.all([publisher.connect(),subscriber.connect()]);io.adapter(createAdapter(publisher,subscriber));console.log('DSS Flow realtime coordination connected')})();return realtimeAdapterPromise};
io.use(async(socket,next)=>{try{await Promise.all([ensureDatabase(),ensureRealtimeAdapter()]);const cookies=Object.fromEntries(String(socket.handshake.headers.cookie||'').split(';').map(part=>part.trim().split('=')));const token=cookies[SESSION_COOKIE];if(!token)return next(new Error('Authentication required'));const[user]=await sql`SELECT u.id,u.name,u.email,u.role,u.avatar_color,u.status FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=${hashToken(token)} AND s.expires_at>NOW()`;if(!user||user.status!=='active')return next(new Error('Session expired'));socket.data.user=user;next();}catch(error){next(error)}});
io.on('connection',socket=>{
  const user=socket.data.user;socket.join(`user:${user.id}`);socket.data.meetingRooms=new Set();
  socket.on('join-meeting',async({roomName})=>{try{const[meeting]=await sql`SELECT id,organizer_id FROM meetings WHERE room_name=${roomName}`;if(!meeting)return;const[attendee]=await sql`SELECT 1 FROM meeting_attendees WHERE meeting_id=${meeting.id} AND user_id=${user.id}`;if(!attendee&&meeting.organizer_id!==user.id)return;const room=`meeting:${roomName}`;const connected=await io.in(room).fetchSockets();const existing=connected.filter(person=>person.id!==socket.id).map(person=>({id:person.id,userId:person.data.user?.id,name:person.data.user?.name||'Participant',avatarColor:person.data.user?.avatar_color}));await socket.join(room);socket.data.meetingRooms.add(room);const participant={id:socket.id,userId:user.id,name:user.name,avatarColor:user.avatar_color};socket.emit('meeting-participants',existing);socket.to(room).emit('participant-joined',participant);}catch(error){console.error('Unable to join realtime meeting:',error.message)}});
  socket.on('webrtc-offer',({target,offer})=>io.to(target).emit('webrtc-offer',{from:socket.id,offer,name:user.name}));
  socket.on('webrtc-answer',({target,answer})=>io.to(target).emit('webrtc-answer',{from:socket.id,answer}));
  socket.on('webrtc-ice',({target,candidate})=>io.to(target).emit('webrtc-ice',{from:socket.id,candidate}));
  socket.on('meeting-chat',({roomName,message})=>{const room=`meeting:${roomName}`,text=String(message||'').trim().slice(0,1500);if(text&&socket.rooms.has(room))io.to(room).emit('meeting-chat',{id:crypto.randomUUID(),userId:user.id,userName:user.name,message:text,createdAt:new Date().toISOString()})});
  socket.on('meeting-hand',({roomName,raised})=>{const room=`meeting:${roomName}`;if(socket.rooms.has(room))io.to(room).emit('meeting-hand',{socketId:socket.id,userId:user.id,userName:user.name,raised:Boolean(raised)})});
  socket.on('leave-meeting',({roomName})=>{const room=`meeting:${roomName}`;socket.leave(room);socket.data.meetingRooms.delete(room);socket.to(room).emit('participant-left',{id:socket.id});});
  socket.on('disconnecting',()=>{for(const room of socket.data.meetingRooms)socket.to(room).emit('participant-left',{id:socket.id})});
});

export default httpServer;

if(!process.env.VERCEL)Promise.all([ensureDatabase(),ensureRealtimeAdapter()]).then(() => httpServer.listen(port, () => console.log(`DSS Flow server running on http://localhost:${port} (${sql ? 'Neon' : 'demo'} mode)`))).catch((error) => { console.error('Server setup failed:', error); process.exit(1); });
else Promise.all([ensureDatabase(),ensureRealtimeAdapter()]).catch(error=>console.error('Server setup failed:',error));
