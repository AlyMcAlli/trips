// Reads a travel confirmation (pasted text, a photo/screenshot, or a PDF) with Claude
// and returns the plans it finds, ready for the Trips app to add to the right days.
//
// Vercel settings → Environment Variables:
//   ANTHROPIC_API_KEY  your key from console.anthropic.com
//   FAMILY_PASSCODE    any word or number the family types once in the app
//   CLAUDE_MODEL       optional; defaults to claude-sonnet-5-5

const crypto = require('crypto');

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const TYPES = ['flight', 'hotel', 'ship', 'dining', 'travel', 'activity', 'note'];

const SYSTEM = `You read travel confirmations (airline, hotel, cruise, car rental, tours, restaurant reservations, park tickets) and pull out the plans a family needs on their trip schedule.

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

const TOOL = {
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
          properties: {
            date: { type: 'string' },
            day: { type: 'integer' },
            title: { type: 'string' }
          },
          required: ['date', 'day', 'title']
        }
      }
    },
    required: ['summary', 'items', 'day_titles']
  }
};

function samePasscode(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
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
  const text = typeof body?.text === 'string' ? body.text.slice(0, 60000) : '';
  const file = body?.file && typeof body.file.data === 'string' ? body.file : null;
  const trip = body?.trip && typeof body.trip === 'object' ? body.trip : {};
  if (!text.trim() && !file) return res.status(400).json({ error: 'empty' });

  const content = [];
  if (file) {
    if (file.mediaType === 'application/pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data } });
    } else if (/^image\/(jpeg|png|gif|webp)$/.test(file.mediaType || '')) {
      content.push({ type: 'image', source: { type: 'base64', media_type: file.mediaType, data: file.data } });
    } else {
      return res.status(400).json({ error: 'unsupported_file' });
    }
  }
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

  let r, data;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        system: SYSTEM + '\n\nAlways answer by calling the add_to_trip tool exactly once. Do not reply with plain text.',
        tools: [TOOL],
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content }]
      })
    });
    data = await r.json().catch(() => ({}));
  } catch (e) {
    return res.status(502).json({ error: 'claude_unreachable' });
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
    return res.status(502).json({ error: code, detail: msg });
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
    console.error('Claude returned no plans', data.stop_reason, JSON.stringify(blocks).slice(0, 500));
    return res.status(502).json({ error: 'no_result' });
  }
  const clean = s => String(s || '').slice(0, 2000);
  return res.status(200).json({
    summary: clean(out.summary),
    items: (Array.isArray(out.items) ? out.items : []).slice(0, 80).map(i => ({
      date: clean(i.date), day: Number(i.day) || 0, time: /^\d{1,2}:\d{2}$/.test(i.time || '') ? i.time.padStart(5, '0') : '',
      type: TYPES.includes(i.type) ? i.type : 'activity', label: clean(i.label).slice(0, 120), notes: clean(i.notes)
    })),
    day_titles: (Array.isArray(out.day_titles) ? out.day_titles : []).slice(0, 80).map(d => ({ date: clean(d.date), day: Number(d.day) || 0, title: clean(d.title).slice(0, 80) }))
  });
};
