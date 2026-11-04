#!/usr/bin/env node
// One-off helper: authorises Intel-Agent to read your Google Calendar and
// prints a refresh token for unattended access. Run with: npm run google:auth
//
// Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (a "Desktop app" OAuth
// client), read from .env.local or the shell environment.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline";

const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const PORT = Number(process.env.GOOGLE_AUTH_PORT ?? 53682);
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2callback`;
const ENV_FILE = ".env.local";

const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) {
  console.error(`Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in ${ENV_FILE} first (see README).`);
  process.exit(1);
}

const base64url = (buffer) => buffer.toString("base64url");
const state = base64url(randomBytes(24));
const verifier = base64url(randomBytes(48));
const challenge = base64url(createHash("sha256").update(verifier).digest());

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT_URI,
  response_type: "code",
  scope: SCOPE,
  access_type: "offline",
  // Forces Google to issue a new refresh token even if access was granted before.
  prompt: "consent",
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
}).toString();

function codeFrom(url) {
  if (url.searchParams.get("state") !== state) throw new Error("State mismatch: please start again.");
  const error = url.searchParams.get("error");
  if (error) throw new Error(`Google returned an error: ${error}`);
  const code = url.searchParams.get("code");
  if (!code) throw new Error("No authorisation code found in the URL.");
  if (!url.searchParams.get("scope")?.split(" ").includes(SCOPE)) {
    throw new Error("Calendar read access was not granted. Tick the calendar permission and try again.");
  }
  return code;
}

async function exchange(code) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Token exchange failed (HTTP ${response.status}: ${body.error ?? "unknown"}).`);
  if (!body.refresh_token) throw new Error("Google did not return a refresh token. Remove the app's access and retry.");
  return body;
}

async function verify(accessToken) {
  const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary?fields=id,timeZone", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Calendar check failed (HTTP ${response.status}). Is the Calendar API enabled?`);
  return response.json();
}

function saveRefreshToken(token) {
  const line = `GOOGLE_REFRESH_TOKEN=${token}`;
  const current = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const next = /^GOOGLE_REFRESH_TOKEN=.*$/m.test(current)
    ? current.replace(/^GOOGLE_REFRESH_TOKEN=.*$/m, line)
    : `${current}${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`;
  writeFileSync(ENV_FILE, next, { mode: 0o600 });
}

let cleanup = () => undefined;

const codePromise = new Promise((resolve, reject) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", REDIRECT_URI);
    if (url.pathname !== "/oauth2callback") {
      response.writeHead(404).end();
      return;
    }
    try {
      const code = codeFrom(url);
      response.writeHead(200, { "Content-Type": "text/plain" }).end("Intel-Agent is authorised. You can close this tab.");
      resolve(code);
    } catch (error) {
      response.writeHead(400, { "Content-Type": "text/plain" }).end(error.message);
      reject(error);
    }
  });
  server.on("error", reject);
  server.listen(PORT, "127.0.0.1");

  // Fallback for remote shells where the browser cannot reach this port.
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    if (!line.trim()) return;
    try {
      resolve(codeFrom(new URL(line.trim())));
    } catch (error) {
      console.error(`${error.message} Paste the full address from the browser bar.`);
    }
  });
  cleanup = () => {
    input.close();
    server.close();
  };
});
console.log("\n1. Open this link in your browser and sign in with the Google account whose calendar you want:\n");
console.log(`   ${authUrl}\n`);
console.log("2. If the browser shows \"This site can't be reached\" after you approve, copy the full");
console.log("   address from the browser bar, paste it here and press Enter.\n");

try {
  const tokens = await exchange(await codePromise);
  const calendar = await verify(tokens.access_token);
  saveRefreshToken(tokens.refresh_token);
  console.log(`\n✔ Authorised. Calendar "${calendar.id}" is readable (time zone ${calendar.timeZone}).`);
  console.log(`✔ Saved GOOGLE_REFRESH_TOKEN to ${ENV_FILE}.\n`);
  console.log("Add this value as GOOGLE_REFRESH_TOKEN (Sensitive) in both Vercel projects:\n");
  console.log(`   ${tokens.refresh_token}\n`);
} catch (error) {
  console.error(`\n✘ ${error.message}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
