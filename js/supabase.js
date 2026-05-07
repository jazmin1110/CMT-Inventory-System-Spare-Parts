// Supabase client — single shared instance for the whole app.
//
// We import the SDK directly from a CDN (esm.sh) so the project works
// as plain static files: no npm install, no bundler, no .env. The URL
// and anon key are inlined below; the anon key is meant to be public
// (Row Level Security in Supabase is what protects the data).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://kmxyzefizirgjbcznvei.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtteHl6ZWZpemlyZ2piY3pudmVpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxMjMwOTMsImV4cCI6MjA5MzY5OTA5M30.fHwmf6fiYXrXf6jXS8sUcPUMLeFPyxfq9jy1lGQ-2Yw';

// We disable persistSession because this app uses its own PIN-based auth
// (see auth.js) — we are not using Supabase Auth's email/password flow.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
