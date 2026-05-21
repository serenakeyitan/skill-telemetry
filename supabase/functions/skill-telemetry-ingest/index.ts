// skill-telemetry-ingest — Supabase Edge Function
//
// Receives a batch of skill-invocation events from telemetry-sync and
// inserts them into the skill_events table using the service-role key.
//
// Deploy (from skill repo root, after `supabase login`):
//
//   supabase functions deploy skill-telemetry-ingest --no-verify-jwt
//
// The --no-verify-jwt is required because we're authenticating via
// anon-key header, not Supabase Auth user JWTs.
//
// Environment variables (auto-populated by Supabase):
//   SUPABASE_URL              — your project URL
//   SUPABASE_SERVICE_ROLE_KEY — server-side key, bypasses RLS

import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_OUTCOMES = new Set([
  "success",
  "error",
  "abandoned",
  "unknown",
]);

// Cap accepted batches so a misbehaving client can't fill the table
const MAX_BATCH = 100;

// Server-side caps (defense in depth; client already caps but trust nothing)
const MAX_ERROR_CLASS_LEN = 60;
const MAX_ERROR_MESSAGE_LEN = 400;
const MAX_ERROR_DETAIL_LEN = 160; // legacy v1 field
const MAX_STEP_LEN = 100;
const MAX_SKILL_LEN = 200;
const MAX_SKILL_VERSION_LEN = 40;
const MAX_SESSION_LEN = 200;
const MAX_OS_LEN = 20;
const MAX_ARCH_LEN = 20;

type IncomingEvent = {
  v?: number;                       // schema version, v2+
  ts?: string;
  skill?: string;
  skill_version?: string | null;    // v2
  outcome?: string | null;
  duration_s?: number | null;
  error_detail?: string | null;     // v1 legacy
  error_class?: string | null;      // v2
  error_message?: string | null;    // v2
  step?: string | null;
  session_id?: string | null;
  installation_id?: string | null;
  os?: string | null;               // v2
  arch?: string | null;             // v2
};

function clampStr(v: unknown, max: number): string | null {
  if (typeof v !== "string" || v.length === 0) return null;
  return v.slice(0, max);
}

function sanitize(e: IncomingEvent): Record<string, unknown> | null {
  // skill is the only required field
  if (!e.skill || typeof e.skill !== "string") return null;

  const outcome =
    e.outcome && ALLOWED_OUTCOMES.has(e.outcome) ? e.outcome : "unknown";

  let duration: number | null = null;
  if (
    typeof e.duration_s === "number" &&
    Number.isFinite(e.duration_s) &&
    e.duration_s >= 0 &&
    e.duration_s < 86_400 * 30 // sanity: <30 days
  ) {
    duration = Math.floor(e.duration_s);
  }

  // installation_id must look like a UUID or we drop it (don't fail
  // the row — just null it out so the rest of the event lands)
  let installId: string | null = null;
  if (
    typeof e.installation_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      e.installation_id,
    )
  ) {
    installId = e.installation_id.toLowerCase();
  }

  // Schema version: accept 1 or 2; default 1 for legacy clients
  let schemaVersion = 1;
  if (typeof e.v === "number" && Number.isInteger(e.v) && e.v >= 1 && e.v <= 2) {
    schemaVersion = e.v;
  }

  // v1 backward-compat: error_detail → error_message if v2 fields empty
  const errorClass = clampStr(e.error_class, MAX_ERROR_CLASS_LEN);
  let errorMessage = clampStr(e.error_message, MAX_ERROR_MESSAGE_LEN);
  const errorDetail = clampStr(e.error_detail, MAX_ERROR_DETAIL_LEN);
  if (!errorMessage && errorDetail) {
    errorMessage = errorDetail;
  }

  // OS / arch: lowercase, allow alphanumerics + dash/underscore
  const cleanPlatform = (v: unknown, max: number): string | null => {
    const s = clampStr(v, max);
    if (!s) return null;
    return /^[a-z0-9_-]+$/i.test(s) ? s.toLowerCase() : null;
  };

  return {
    schema_version: schemaVersion,
    ts: typeof e.ts === "string" ? e.ts : new Date().toISOString(),
    skill: e.skill.slice(0, MAX_SKILL_LEN),
    skill_version: clampStr(e.skill_version, MAX_SKILL_VERSION_LEN),
    outcome,
    duration_s: duration,
    error_class: errorClass,
    error_message: errorMessage,
    error_detail: errorDetail, // kept null for v2 clients; populated for v1
    step: clampStr(e.step, MAX_STEP_LEN),
    session_id: clampStr(e.session_id, MAX_SESSION_LEN),
    installation_id: installId,
    os: cleanPlatform(e.os, MAX_OS_LEN),
    arch: cleanPlatform(e.arch, MAX_ARCH_LEN),
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  if (!Array.isArray(body)) {
    return new Response("expected array", { status: 400 });
  }
  if (body.length === 0) {
    return new Response("ok", { status: 200 });
  }
  if (body.length > MAX_BATCH) {
    return new Response(`batch too large (max ${MAX_BATCH})`, {
      status: 413,
    });
  }

  const rows: Record<string, unknown>[] = [];
  for (const raw of body) {
    const clean = sanitize(raw as IncomingEvent);
    if (clean) rows.push(clean);
  }

  if (rows.length === 0) {
    // All rows were malformed but we don't want the client to retry
    // forever — return 200 so its cursor advances.
    return new Response("ok (no valid rows)", { status: 200 });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { error } = await sb.from("skill_events").insert(rows);

  if (error) {
    return new Response(`insert failed: ${error.message}`, { status: 500 });
  }

  return new Response(`ok (${rows.length} inserted)`, { status: 200 });
});
