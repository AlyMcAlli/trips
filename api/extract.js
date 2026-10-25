// The Trips app's connection to Claude. Three jobs, picked by `mode`:
//   confirm (default)  read a travel confirmation and return plans for the schedule
//   outfits            turn a pasted outfit plan into a day-by-day table plus packing counts
//   counts             work out packing counts from a day-by-day outfit table
//
// Vercel settings → Environment Variables:
//   ANTHROPIC_API_KEY  your key from console.anthropic.com
//   FAMILY_PASSCODE    any word or number the family types once in the app
//   CLAUDE_MODEL       optional; defaults to claude-sonnet-5-5

const crypto = require('crypto');

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const TYPES = ['flight', 'hotel', 'ship', 'dining', 'travel', 'activity', 'note'];
const BAGS = ['wear', 'personal', 'carryon', 'checked', 'car'];

/* ---------- confirmations ---------- */
const CONFIRM_SYSTEM = `You read travel confirmations (airline, hotel, cruise, car rental, tours, restaurant reservations, park tickets) and pull out the plans a family needs on their trip schedule.

Rules:
- Only record what the confirmation actually says. Never guess times, dates or numbers.
- Use the local date (YYYY-MM-DD) and local 24-hour time (HH:MM) at the place the event happens. Leave time empty if none is given.
- If the year is missing, pick the one that fits the trip context; otherwise the next upcoming occurrence.
- Flights: one "flight" item for each departure and one for each arrival. Departure label like "Delta 2040 · SLC → HNL"; arrival label like "Arrive Honolulu (HNL)". Notes: confirmation code, seats, terminal, duration when shown.
- Hotels and rentals: a "hotel" item for check-in labeled "Check in · <hotel name>" with notes "<n> nights · Conf <number> · <address>", and one for check-out labeled "Check out · <hotel name>".
- Car rentals: "travel" items for pickup and drop-off with company, location and confirmation.
- Cruises: on embarkation, "ship" items for boarding (terminal address, booking number) and ship departure. For each port day, a "ship" item "Guests ashore" at the arrival time and "All aboard" at the all-aboard or departure time, and a day title with the port name. Sea days get the title "At Sea". Include dining times or dress codes only if stated.
- Tours, tickets, shows: "activity" with meeting point and confirmation in notes. Restaurant reservations: "dining".
- Keep labels short (under 60 characters). Put details in notes, one fact per line.
- Fill the day field only when no calendar date is known; otherwise set day to 0.
- If you find nothing usable, return an empty items list and say why in the summary.`;

const CONFIRM_TOOL = {
  name: 'add_to_trip',
  description: 'Record the travel plans found in the confirmation.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One short sentence on what was found, e.g. "Round-trip Delta flights and a 3-night hotel stay."' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Local date YYYY-MM-DD, or empty if unknown' },
            day: { type: 'integer', description: 'Trip day number (1 = first day) only when no date is known; otherwise 0' },
            time: { type: 'string', description: 'Local 24-hour time HH:MM, or empty' },
            type: { type: 'string', enum: TYPES },
            label: { type: 'string' },
            notes: { type: 'string' }
          },
          required: ['date', 'day', 'time', 'type', 'label', 'notes']
        }
      },
      day_titles: {
        type: 'array',
        description: 'Day titles worth setting, such as a cruise port name for that day.',
        items: {
          type: 'object',
          properties: { date: { type: 'string' }, day: { type: 'integer' }, title: { type: 'string' } },
          required: ['date', 'day', 'title']
        }
      }
    },
    required: ['summary', 'items', 'day_titles']
  }
};

/* ---------- outfits & packing counts ---------- */
const COUNT_RULES = `How to work out packing counts:
- Count the distinct pieces this person must pack, per kind of clothing: tops/T-shirts, other tops, sweatshirts and layers, jeans, shorts, pants/skirts, dresses, costumes, swimsuits, cover-ups, pajamas, workout wear, shoes, and foundations (garment tops and bottoms, slips, bras, sports bras, underwear, socks).
- Re-wearing: pieces the plan repeats (the same sweatshirt, lounge set, shoes, travel outfit) count once. Foundations, underwear and socks are counted per wear unless the plan says they carry over.
- Laundry: if the plan or laundry note says laundry happens partway through, items washed can be worn again after it, so count only the most needed before laundry comes back. Explain this in the note.
- Include what is worn on the travel day; say so in the note when it is worn rather than packed.
- Match each count to the person's existing packing list item when it is the same kind of thing (use its item_id, e.g. "T-shirts (3–5)" for T-shirts). Use an empty item_id only for kinds that have no match, and give those a short name and the bag they belong in.
- Only count clothing, shoes, foundations, swim, sleepwear and layers. Skip toiletries, electronics and documents.
- Keep each note under 90 characters, e.g. "8 days, laundry on day 4; Mon and Thu dinners".
- Never invent clothing the plan does not mention.`;

const OUTFITS_SYSTEM = `You turn a traveler's outfit plan (pasted text, a screenshot or a PDF) into a day-by-day table for their trip app, then work out how many of each kind of clothing they need to pack.

Day-by-day table:
- Match each day of the plan to the trip day by date when dates are given, otherwise by order or by the day titles provided.
- For each day fill four short fields: daytime, evening, shoes, foundations. Keep the person's own words for pieces (e.g. "Bo Peep costume", "navy half-zip sweatsuit"). Use " · " between pieces. Leave a field empty if the plan says nothing for it.
- foundations means underlayers: garments, slips, bras, underwear, socks.
- Include only days that are in the plan.

${COUNT_RULES}`;

const COUNTS_SYSTEM = `You work out how many of each kind of clothing a traveler needs to pack, from their day-by-day outfit plan in a trip app.

${COUNT_RULES}`;

const COUNTS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      item_id: { type: 'string', description: 'The matching packing list item_id, or empty if no item matches' },
      name: { type: 'string', description: 'Short name for this kind of clothing, e.g. "Garment slips"' },
      count: { type: 'integer', description: 'How many to pack' },
      bag: { type: 'string', enum: BAGS, description: 'Bag for a new item (empty item_id); otherwise the matching item\'s bag' },
      note: { type: 'string', description: 'Why this number, under 90 characters' }
    },
    required: ['item_id', 'name', 'count', 'bag', 'note']
  }
};
const OUTFITS_TOOL = {
  name: 'save_outfit_plan',
  description: 'Save the day-by-day outfit table and packing counts.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One short sentence on what was found' },
      laundry_note: { type: 'string', description: 'The laundry or re-wear plan if the outfit plan mentions one, in one short sentence; otherwise empty' },
      days: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            day: { type: 'integer', description: 'Trip day number, 1 = first day' },
            daytime: { type: 'string' }, evening: { type: 'string' }, shoes: { type: 'string' }, foundations: { type: 'string' }
          },
          required: ['day', 'daytime', 'evening', 'shoes', 'foundations']
        }
      },
      counts: COUNTS_SCHEMA
    },
    required: ['summary', 'laundry_note', 'days', 'counts']
  }
};
const COUNTS_TOOL = {
  name: 'save_packing_counts',
  description: 'Save how many of each kind of clothing to pack.',
  input_schema: {
    type: 'object',
    properties: { summary: { type: 'string' }, counts: COUNTS_SCHEMA },
    required: ['summary', 'counts']
  }
};

function samePasscode(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}
const clean = (s, n = 2000) => String(s == null ? '' : s).slice(0, n);
const short = (v, n) => JSON.stringify(v == null ? null : v).slice(0, n);

async function askClaude(key, system, tool, content) {
  let r, data;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        system: system + `\n\nAlways answer by calling the ${tool.name} tool exactly once. Do not reply with plain text.`,
        tools: [tool],
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content }]
      })
    });
    data = await r.json().catch(() => ({}));
  } catch (e) {
    return { status: 502, body: { error: 'claude_unreachable' } };
  }
  if (!r.ok) {
    const msg = (data && data.error && data.error.message) || ('HTTP ' + r.status);
    const kind = (data && data.error && data.error.type) || '';
    console.error('Claude API error', r.status, kind, msg);
    let code = 'claude_error';
    if (r.status === 401 || kind === 'authentication_error') code = 'bad_key';
    else if (r.status === 403 || kind === 'permission_error') code = 'bad_key';
    else if (/credit balance|billing|spend limit|usage limit/i.test(msg)) code = 'no_credit';
    else if (r.status === 404 || kind === 'not_found_error') code = 'model_unavailable';
    else if (r.status === 429) code = 'rate_limited';
    else if (r.status === 529 || kind === 'overloaded_error') code = 'busy';
    else if (r.status === 413 || /too large|too long|maximum/i.test(msg)) code = 'too_big';
    return { status: 502, body: { error: code, detail: msg } };
  }
  const blocks = data.content || [];
  const use = blocks.find(b => b.type === 'tool_use' && b.input);
  let out = use ? use.input : null;
  if (!out) {
    // Fallback: the model answered in text. Pull the first JSON object out of it.
    const txt = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
    const a = txt.indexOf('{'), z = txt.lastIndexOf('}');
    if (a >= 0 && z > a) { try { out = JSON.parse(txt.slice(a, z + 1)); } catch (e) { out = null; } }
  }
  if (!out) {
    console.error('Claude returned nothing usable', data.stop_reason, JSON.stringify(blocks).slice(0, 500));
    return { status: 502, body: { error: 'no_result' } };
  }
  return { status: 200, out };
}

function fileBlock(file) {
  if (file.mediaType === 'application/pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data } };
  if (/^image\/(jpeg|png|gif|webp)$/.test(file.mediaType || '')) return { type: 'image', source: { type: 'base64', media_type: file.mediaType, data: file.data } };
  return null;
}
function cleanCounts(list, ids) {
  return (Array.isArray(list) ? list : []).slice(0, 60).map(c => ({
    item_id: ids.has(String(c.item_id || '')) ? String(c.item_id) : '',
    name: clean(c.name, 60),
    count: Math.max(0, Math.min(99, Math.round(Number(c.count) || 0))),
    bag: BAGS.includes(c.bag) ? c.bag : 'checked',
    note: clean(c.note, 160)
  })).filter(c => c.name && c.count > 0);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const key = process.env.ANTHROPIC_API_KEY;
  const passcode = process.env.FAMILY_PASSCODE;
  if (!key || !passcode) return res.status(503).json({ error: 'not_configured' });
  if (!samePasscode(req.headers['x-family-passcode'] || '', passcode)) return res.status(401).json({ error: 'bad_passcode' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body && typeof body === 'object' ? body : {};
  const mode = ['outfits', 'counts'].includes(body.mode) ? body.mode : 'confirm';
  const text = typeof body.text === 'string' ? body.text.slice(0, 60000) : '';
  const file = body.file && typeof body.file.data === 'string' ? body.file : null;
  const trip = body.trip && typeof body.trip === 'object' ? body.trip : {};

  const content = [];
  if (file) {
    const fb = fileBlock(file);
    if (!fb) return res.status(400).json({ error: 'unsupported_file' });
    content.push(fb);
  }

  /* --- outfit plan or counts --- */
  if (mode === 'outfits' || mode === 'counts') {
    const days = Array.isArray(body.days) ? body.days.slice(0, 61) : [];
    const items = Array.isArray(body.items) ? body.items.slice(0, 400) : [];
    const ids = new Set(items.map(i => String(i && i.id || '')));
    const traveler = body.traveler && typeof body.traveler === 'object' ? body.traveler : {};
    const outfits = body.outfits && typeof body.outfits === 'object' ? body.outfits : {};
    if (mode === 'outfits' && !text.trim() && !file) return res.status(400).json({ error: 'empty' });
    if (mode === 'counts' && !Object.keys(outfits).length) return res.status(400).json({ error: 'empty' });
    const ctx = [
      `Traveler: ${clean(traveler.name, 60) || 'unnamed'} (${traveler.kind === 'kid' ? 'kid' : 'adult'})`,
      `Trip: ${[trip.cruise ? 'cruise' : 'land', trip.intl ? 'international' : 'domestic', trip.disney ? 'Disney' : null].filter(Boolean).join(', ')}, ${Number(trip.nights) || 0} nights`,
      `Trip days: ${short(days, 8000)}`,
      `Laundry / re-wear note: ${clean(body.laundry, 600) || 'none given'}`,
      `Packing list items (item_id, name, category, bag): ${short(items, 30000)}`
    ].join('\n');
    if (mode === 'outfits') {
      content.push({ type: 'text', text: ctx + '\n\n' + (text.trim() ? `Outfit plan:\n"""\n${text}\n"""` : 'Read the attached outfit plan.') });
    } else {
      content.push({ type: 'text', text: ctx + `\n\nDay-by-day outfits (keyed by trip day):\n${short(outfits, 30000)}` });
    }
    const got = await askClaude(key, mode === 'outfits' ? OUTFITS_SYSTEM : COUNTS_SYSTEM, mode === 'outfits' ? OUTFITS_TOOL : COUNTS_TOOL, content);
    if (got.status !== 200) return res.status(got.status).json(got.body);
    const out = got.out;
    const result = { summary: clean(out.summary, 300), counts: cleanCounts(out.counts, ids) };
    if (mode === 'outfits') {
      result.laundry_note = clean(out.laundry_note, 400);
      result.days = (Array.isArray(out.days) ? out.days : []).slice(0, 61).map(d => ({
        day: Math.round(Number(d.day) || 0),
        daytime: clean(d.daytime, 400), evening: clean(d.evening, 400), shoes: clean(d.shoes, 200), foundations: clean(d.foundations, 300)
      })).filter(d => d.day > 0);
    }
    return res.status(200).json(result);
  }

  /* --- confirmations --- */
  if (!text.trim() && !file) return res.status(400).json({ error: 'empty' });
  const context = {
    trip_type: [trip.cruise ? 'cruise' : 'land', trip.intl ? 'international' : 'domestic', trip.disney ? 'Disney' : null].filter(Boolean).join(', '),
    nights: Number(trip.nights) || 0,
    first_day: trip.start || 'not set yet',
    today: new Date().toISOString().slice(0, 10)
  };
  content.push({
    type: 'text',
    text: `Trip context: ${JSON.stringify(context)}\n\n` +
      (text.trim() ? `Confirmation text:\n"""\n${text}\n"""` : 'Read the attached confirmation.')
  });
  const got = await askClaude(key, CONFIRM_SYSTEM, CONFIRM_TOOL, content);
  if (got.status !== 200) return res.status(got.status).json(got.body);
  const out = got.out;
  return res.status(200).json({
    summary: clean(out.summary),
    items: (Array.isArray(out.items) ? out.items : []).slice(0, 80).map(i => ({
      date: clean(i.date), day: Number(i.day) || 0, time: /^\d{1,2}:\d{2}$/.test(i.time || '') ? i.time.padStart(5, '0') : '',
      type: TYPES.includes(i.type) ? i.type : 'activity', label: clean(i.label).slice(0, 120), notes: clean(i.notes)
    })),
    day_titles: (Array.isArray(out.day_titles) ? out.day_titles : []).slice(0, 80).map(d => ({ date: clean(d.date), day: Number(d.day) || 0, title: clean(d.title).slice(0, 80) }))
  });
};
