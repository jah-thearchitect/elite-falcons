// Elite Falcons booking emails.
// Stripe sends "checkout.session.completed" here after a parent pays.
// This looks up the scheduled sessions in the Google Sheet and emails them via Resend.
//
// Vercel environment variables:
//   STRIPE_WEBHOOK_SECRET   whsec_...  (from the Stripe webhook endpoint)
//   STRIPE_SECRET_KEY       rk_live_... restricted key with Checkout Sessions: Read
//   RESEND_API_KEY          re_...
//   NOTIFY_EMAIL            where booking alerts go (comma-separate for several)
//   FROM_EMAIL              optional, e.g. "Elite Falcons <bookings@elite-falcons.com>" once the domain is verified in Resend
//   SEND_PARENT_CONFIRMATION optional, "yes" to also email the parent (needs a verified domain)
//   SHEET_ID                optional, defaults to the Elite Falcons Schedule sheet
import crypto from 'node:crypto';

const SHEET_ID = process.env.SHEET_ID || '1qf6vmLK-AO9KXc1pxNVydgFx5E38RH2-nVYk736PtIs';
const TZ = 'America/New_York';

export async function POST(request) {
  const raw = await request.text();
  const sig = request.headers.get('stripe-signature') || '';
  if (!verifyStripe(raw, sig, process.env.STRIPE_WEBHOOK_SECRET)) {
    return new Response('Bad signature', { status: 400 });
  }
  const event = JSON.parse(raw);
  if (event.type !== 'checkout.session.completed') return new Response('ignored', { status: 200 });
  const s = event.data.object;
  if (s.payment_status && s.payment_status !== 'paid') return new Response('not paid', { status: 200 });

  // Only handle Elite Falcons checkouts (they carry our client_reference_id or our custom fields).
  const fields = Object.fromEntries((s.custom_fields || []).map(f => [f.label?.custom || f.key, f.text?.value || f.dropdown?.value || f.numeric?.value || '']));
  const ref = s.client_reference_id || '';
  const isFalcons = /^(week|session)-/.test(ref) || Object.keys(fields).some(k => /athlete/i.test(k));
  if (!isFalcons) return new Response('not falcons', { status: 200 });

  try {
    const [items, sessions] = await Promise.all([lineItems(s.id), loadSessions()]);
    const booking = describe(ref, sessions);
    const qty = items.reduce((n, i) => n + (i.quantity || 0), 0) || 1;
    const product = items.map(i => i.description).join(', ') || 'Elite Falcons training';
    const cust = s.customer_details || {};
    const data = {
      parent: cust.name || '', email: cust.email || '', phone: cust.phone || '',
      athletes: fields['Athlete names or team name'] || firstMatch(fields, /athlete/i),
      typedWeek: fields['Training week or session date'] || firstMatch(fields, /week|date/i),
      qty, product, total: money((s.amount_total || 0) / 100), paidAt: fmtDateTime(new Date((s.created || event.created) * 1000)),
      booking, stripeUrl: s.payment_intent ? `https://dashboard.stripe.com/payments/${s.payment_intent}` : 'https://dashboard.stripe.com/payments'
    };
    const to = (process.env.NOTIFY_EMAIL || '').split(',').map(x => x.trim()).filter(Boolean);
    const from = process.env.FROM_EMAIL || 'Elite Falcons <onboarding@resend.dev>';
    await sendEmail({ from, to, reply_to: data.email || undefined, subject: `New booking: ${data.athletes || data.parent} · ${booking.label}`, html: coachEmail(data) });
    if (/^y/i.test(process.env.SEND_PARENT_CONFIRMATION || '') && data.email) {
      await sendEmail({ from, to: [data.email], reply_to: to[0], subject: `You're booked: Elite Falcons · ${booking.label}`, html: parentEmail(data) });
    }
    return new Response('ok', { status: 200 });
  } catch (e) {
    console.error(e);
    return new Response('error: ' + e.message, { status: 500 }); // Stripe retries on 500
  }
}

function verifyStripe(payload, header, secret) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=')));
  const t = parts.t; const sigs = header.split(',').filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 600) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return sigs.some(v => v.length === expected.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected)));
}

async function lineItems(id) {
  if (!process.env.STRIPE_SECRET_KEY) return [];
  const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${id}/line_items?limit=10`, { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } });
  if (!r.ok) throw new Error('Stripe line items ' + r.status);
  return (await r.json()).data || [];
}

async function sendEmail(body) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('Resend ' + r.status + ' ' + (await r.text()));
}

/* ---------- Google Sheet ---------- */
async function loadSessions() {
  try {
    const r = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&headers=1&sheet=Sessions`);
    if (!r.ok) return [];
    const rows = csv(await r.text()); const h = (rows[0] || []).map(x => x.trim().toLowerCase());
    return rows.slice(1).map(r => Object.fromEntries(h.map((k, i) => [k, (r[i] || '').trim()]))).map(o => ({
      sport: o.sport || 'Volleyball', date: toDate(o.date), start: toTime(o.start), end: o.end ? toTime(o.end) : '',
      location: o.location, focus: o.focus, bring: o.bring
    })).filter(x => x.date);
  } catch { return []; }
}
function csv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c; }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const pad = n => String(n).padStart(2, '0');
function toDate(s) { let m = String(s).match(/(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`; m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${pad(m[1])}-${pad(m[2])}`; return ''; }
function toTime(s) { const m = String(s).match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/); if (!m) return String(s || ''); let h = +m[1]; const ap = m[3] ? m[3].toUpperCase() : (h >= 12 ? 'PM' : 'AM'); if (!m[3]) h = h % 12 || 12; return `${h}:${m[2]} ${ap}`; }
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function parseD(ds) { const [y, m, d] = ds.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)); }
function weekKey(ds) { const d = parseD(ds); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); }
function fmtDay(ds) { return parseD(ds).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); }
function fmtDateTime(d) { return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ }); }

function describe(ref, sessions) {
  let m = ref.match(/^week-(\d{4}-\d{2}-\d{2})-?(.*)$/);
  if (m) {
    const key = m[1], sport = m[2];
    const list = sessions.filter(x => weekKey(x.date) === key && (!sport || slug(x.sport) === sport)).sort((a, b) => a.date.localeCompare(b.date));
    const end = parseD(key); end.setUTCDate(end.getUTCDate() + 6);
    return { label: `Week of ${fmtDay(key)} – ${fmtDay(end.toISOString().slice(0, 10))}`, type: 'Weekly group rate', sessions: list };
  }
  m = ref.match(/^session-(\d{4}-\d{2}-\d{2})-?(.*)$/);
  if (m) {
    const list = sessions.filter(x => x.date === m[1] && (!m[2] || slug(x.sport) === m[2]));
    return { label: fmtDay(m[1]), type: 'Single session', sessions: list };
  }
  return { label: 'Week not selected on site', type: '', sessions: [] };
}
const firstMatch = (o, re) => { const k = Object.keys(o).find(k => re.test(k)); return k ? o[k] : ''; };
const money = n => '$' + (n % 1 ? n.toFixed(2) : n);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- emails ---------- */
function sessionRows(list) {
  if (!list.length) return '<p style="margin:0;color:#56675C">No matching sessions found in the schedule sheet. Check the training week the parent typed below.</p>';
  return '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">' + list.map(x =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid #E3E5D8;font-weight:700;white-space:nowrap;vertical-align:top">${esc(fmtDay(x.date))}</td>` +
    `<td style="padding:8px 0 8px 12px;border-bottom:1px solid #E3E5D8">${esc(x.start)}${x.end ? ' – ' + esc(x.end) : ''}<br><span style="color:#56675C">${esc(x.focus || '')}${x.location ? ' · ' + esc(x.location) : ''}</span></td></tr>`).join('') + '</table>';
}
function shell(title, inner) {
  return `<div style="background:#F1EFE4;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#0F2219"><div style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden">` +
    `<div style="background:#0C3F2A;color:#F3EFDF;padding:18px 22px;border-bottom:4px solid #F5A11C"><div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#F5A11C">Elite Falcons</div><div style="font-size:22px;font-weight:700;margin-top:4px">${esc(title)}</div></div>` +
    `<div style="padding:20px 22px;font-size:15px;line-height:1.5">${inner}</div></div></div>`;
}
function coachEmail(d) {
  return shell('New booking', `
    <p style="margin:0 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#56675C">${esc(d.booking.type || 'Booking')}</p>
    <p style="margin:0 0 14px;font-size:20px;font-weight:700">${esc(d.booking.label)}</p>
    ${sessionRows(d.booking.sessions)}
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-top:18px;font-size:14px">
      <tr><td style="color:#56675C;padding:3px 0;width:150px">Athlete(s)</td><td style="font-weight:700">${esc(d.athletes || '—')}</td></tr>
      <tr><td style="color:#56675C;padding:3px 0">Athletes paid for</td><td>${d.qty}</td></tr>
      <tr><td style="color:#56675C;padding:3px 0">Parent</td><td>${esc(d.parent)}</td></tr>
      <tr><td style="color:#56675C;padding:3px 0">Email</td><td>${esc(d.email)}</td></tr>
      <tr><td style="color:#56675C;padding:3px 0">Phone</td><td>${esc(d.phone)}</td></tr>
      <tr><td style="color:#56675C;padding:3px 0">They typed</td><td>${esc(d.typedWeek || '—')}</td></tr>
      <tr><td style="color:#56675C;padding:3px 0">Paid</td><td>${esc(d.total)} · ${esc(d.product)} · ${esc(d.paidAt)}</td></tr>
    </table>
    <p style="margin:18px 0 0"><a href="${d.stripeUrl}" style="color:#0C3F2A;font-weight:700">View payment in Stripe</a></p>`);
}
function parentEmail(d) {
  return shell("You're booked", `
    <p style="margin:0 0 12px">Thanks${d.parent ? ', ' + esc(d.parent.split(' ')[0]) : ''}. ${esc(d.athletes || 'Your athlete')} is booked for <b>${esc(d.booking.label)}</b>.</p>
    ${sessionRows(d.booking.sessions)}
    <p style="margin:16px 0 0;color:#56675C;font-size:14px">Paid ${esc(d.total)} for ${d.qty} athlete${d.qty === 1 ? '' : 's'}. Workouts and warm-ups are at <a href="https://elite-falcons.com" style="color:#0C3F2A">elite-falcons.com</a>. Reply to this email with any questions.</p>`);
}
