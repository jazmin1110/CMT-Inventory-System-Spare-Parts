// Authentication helpers — PIN pad on the login screen.
// We hash the PIN client-side with SHA-256 (Web Crypto) and look it up
// in the `users` table. If found, store the user in localStorage and
// redirect based on role.
import { supabase } from './supabase.js';

/**
 * Hash a string using SHA-256 and return a lowercase hex string.
 * Used both at login (lookup) and when creating users in the dashboard.
 */
export async function sha256Hex(text) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Save the current user to localStorage. */
export function saveUser(user) {
  localStorage.setItem('cmt_user', JSON.stringify(user));
}

/** Read the current user from localStorage (or null). */
export function getUser() {
  try {
    const raw = localStorage.getItem('cmt_user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Clear the current user and bounce to the login screen. */
export function logout() {
  localStorage.removeItem('cmt_user');
  window.location.href = './index.html';
}

/**
 * Guard a page so only the right role can see it.
 * If unauthenticated, redirect to login.
 * If a required role is given and the user has the wrong role, also bounce.
 */
export function requireRole(requiredRole) {
  const user = getUser();
  if (!user) {
    window.location.href = './index.html';
    return null;
  }
  if (requiredRole && user.role !== requiredRole) {
    window.location.href = './index.html';
    return null;
  }
  return user;
}

/**
 * Wire up the PIN pad on the login screen.
 * - Renders 4 dots showing how many digits have been pressed
 * - Once 4 digits are entered, hashes the PIN and looks it up in `users`
 * - On success: saves user to localStorage and redirects by role
 * - On failure: shakes the dots and clears the PIN
 */
export function initLoginScreen() {
  const dotsEl = document.querySelector('#pin-dots');
  const padEl = document.querySelector('#pin-pad');
  if (!dotsEl || !padEl) return;

  let pin = '';
  let busy = false;

  function renderDots() {
    [...dotsEl.children].forEach((dot, i) => {
      dot.classList.toggle('filled', i < pin.length);
    });
  }

  function shake() {
    dotsEl.classList.remove('shake');
    void dotsEl.offsetWidth;
    dotsEl.classList.add('shake');
  }

  async function tryLogin() {
    if (busy) return;
    busy = true;
    try {
      const hash = await sha256Hex(pin);
      const { data, error } = await supabase
        .from('users')
        .select('id, name, role')
        .eq('pin', hash)
        .maybeSingle();

      if (error) throw error;

      if (data) {
        saveUser({ id: data.id, name: data.name, role: data.role });
        const target =
          data.role === 'manager' ? './dashboard.html' : './worker.html';
        window.location.href = target;
        return;
      }
      shake();
      pin = '';
      renderDots();
    } catch (err) {
      console.error(err);
      showBanner('Login failed: ' + (err.message || err), 'error');
      shake();
      pin = '';
      renderDots();
    } finally {
      busy = false;
    }
  }

  function press(value) {
    if (busy) return;
    if (value === 'back') {
      pin = pin.slice(0, -1);
    } else if (value === 'clear') {
      pin = '';
    } else if (/^\d$/.test(value) && pin.length < 4) {
      pin += value;
    }
    renderDots();
    if (pin.length === 4) tryLogin();
  }

  padEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-key]');
    if (!btn) return;
    press(btn.dataset.key);
  });

  // Allow physical keyboard for desktop testing.
  document.addEventListener('keydown', (e) => {
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('back');
    else if (e.key === 'Escape') press('clear');
  });

  renderDots();
}

/** Tiny toast banner used by login + other screens. */
export function showBanner(text, type = 'info', timeoutMs = 3500) {
  const el = document.createElement('div');
  el.className = `banner ${type}`;
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), timeoutMs);
}
