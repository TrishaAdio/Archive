# Get Pleasure

A members-only video archive. Viewers enter an access key, the key locks to their network,
and they stream from a library you fill by browsing folders on your own VPS.

One Node process serves the API and the three pages. No build step.

- `/` — access key gate
- `/watch` — library, archive listing, player
- `/admin` — owner console

## One-command install on a VPS

On a fresh Ubuntu 22.04/24.04 or Debian 12 server:

```bash
git clone https://github.com/TrishaAdio/Archive.git
cd Archive
sudo bash setup.sh
```

When it finishes it prints the link to open, for example:

```
  Website        http://203.0.113.10:3000
  Owner console  http://203.0.113.10:3000/admin
  Admin token    3f9c…
```

The same summary is saved to `/root/getpleasure-access.txt`, readable by root only.

What the script does:

1. Checks the OS, CPU, RAM and that the port is free.
2. Installs Node.js 22, ffmpeg (for thumbnails), and MongoDB 8.0 as a single-node replica set
   that only listens on `127.0.0.1`.
3. Copies the app to `/opt/getpleasure`, installs production dependencies, and creates a
   `getpleasure` system user to run it.
4. Generates the admin token and secrets into `/etc/getpleasure/getpleasure.env`.
5. Registers a systemd service that starts on boot and restarts on crash.
6. Opens the port in ufw, firewalld, or iptables, whichever is active.
7. Starts the site, waits for it to report healthy, and prints the `http://IP:PORT` link.

Options:

| Flag | Default | |
| --- | --- | --- |
| `--port N` | `3000` | Port the site listens on |
| `--media PATH` | `/srv/getpleasure/media` | Folder the admin console can browse |
| `--mongodb-uri URI` | local install | Use Atlas or another replica set instead |
| `--ip-mode MODE` | `relaxed` | `strict` locks keys to the exact IP |

Re-run `sudo bash setup.sh` after `git pull` to update. It keeps your admin token, secrets,
port and data.

Things the script cannot do for you:

- **Cloud firewalls.** AWS security groups, Oracle security lists, and the GCP, Azure and Hetzner
  firewalls sit outside the server. Allow TCP on your port there as well.
- **CPUs without AVX.** MongoDB 8.0 needs AVX. On older or very cheap CPUs the script stops and
  tells you to use a free MongoDB Atlas cluster with `--mongodb-uri`.
- **HTTPS.** The link is plain HTTP, so access keys and session cookies travel unencrypted, and
  the Paste and Copy buttons fall back to manual paste because browsers only allow clipboard
  access over HTTPS. Point a domain at the server and put HTTPS in front before selling keys.

## Manual install

```bash
npm install
npm run secrets        # prints three secrets
cp .env.example .env   # paste the secrets in, set MEDIA_ROOT and MONGODB_URI
npm start
```

`MEDIA_ROOT` is the only folder the admin console can browse. Put your videos under it.

MongoDB must run as a replica set (MongoDB Atlas already is). The app writes with
`w:"majority", j:true`, which a standalone server cannot acknowledge. For a single local
server, start it with `--replSet rs0` and run `rs.initiate()` once.

## Tests

```bash
npm run test:e2e        # 214 API and security checks against a temporary MongoDB
npm run test:browser    # 129 checks driving real Chromium, including video playback
npm run screenshots     # writes screenshots/ for a visual pass
```

Both suites start their own MongoDB and server, so nothing needs to be running first.

## How the pieces fit together

### Category codes and archives

A **category code** is a number you put on an access key, for example `12`. A **category**
gives that code a display name. An **archive** is a named collection of videos filed under
one category code.

A viewer whose key carries code `12` sees the category name as their home page heading and
only the archives filed under `12`. Requesting an archive from another category returns 403,
so a code is a real access boundary, not just a label.

### Video numbering

Each archive numbers its videos `#1`, `#2`, … up to however many it holds. Numbers come from
an atomic MongoDB counter: an import of 1400 files reserves a block of 1400 numbers in a
single operation, so there are no gaps, duplicates, or races between simultaneous imports.
Re-importing the same folder adds nothing and consumes no numbers.

### Importing from your VPS

The Library tab browses `MEDIA_ROOT`, and you import either a folder or a `.zip`.

Videos are read in place and are never copied into a web-served directory. A zip is extracted
into `MEDIA_ROOT/_extracted/<archiveId>/` first.

`.mp4`, `.m4v`, `.webm` and `.ogv` play in browsers directly. `.mkv`, `.mov`, `.avi`, `.ts`,
`.wmv` and `.flv` are imported but marked **needs transcode**, because no browser plays them.
Convert those to MP4 before expecting playback:

```bash
ffmpeg -i input.mkv -c:v libx264 -crf 21 -c:a aac -movflags +faststart output.mp4
```

### Thumbnails

In order of preference: an image file sitting next to the video with the same name
(`episode-01.mp4` + `episode-01.jpg`), then an ffmpeg-generated frame if ffmpeg is installed,
then a generated SVG card in a colour derived from the video id. Thumbnails are served through
a session-checked endpoint, never as static files.

### Resume, likes, and ordering

Watch position is saved every 10 seconds, on pause, and when the page is hidden or closed. The
home page shows a "Pick up where you left off" row for anything started but not finished.

The default ordering inside an archive is most-watched first, then by number. Views are counted
once per key per video per `VIEW_DEDUPE_HOURS`, so replays do not inflate the count. Likes are
one per key per video and toggle off.

### Live viewers and broadcasts

Open viewer pages send a heartbeat every 20 seconds. The dashboard counts sessions seen within
`PRESENCE_WINDOW_SECONDS`. The same heartbeat delivers broadcasts, so a message appears on every
screen within about 20 seconds, blocks the page until the viewer presses **I Read**, and never
reappears for that viewer. The console shows how many people have read it.

### Subscriptions

Every key stores `planStartsAt` and `planExpiresAt`. **Expire now** in the Access keys tab sets
the expiry to now, marks the key revoked, and deletes that viewer's sessions, so an open player
is locked out on its next request rather than at the end of the day. **+30 days** reactivates an
expired key. **Unlock IP** clears the network binding so the key can be claimed from somewhere
new.

## Security

### What is actually enforced

| Control | Implementation |
| --- | --- |
| Keys are never stored | Only a SHA-256 hash is saved; a database dump yields no usable key |
| Keys lock to a network | First redemption records the IP; a different IP is refused even with the correct key |
| Session cookies are bound | Cookie is HMAC-signed, `HttpOnly`, `SameSite=Strict`, and re-checked against the recorded IP on every request |
| Video URLs expire | Each playback URL is an HMAC over session + video + IP + expiry, valid for `STREAM_TOKEN_TTL_SECONDS` |
| Files are never public | No static route reaches `MEDIA_ROOT`; every byte passes the session and token check |
| Admin console is separate | Constant-time token comparison, rate limited to 10 attempts per 15 minutes |
| Category isolation | A key only reaches archives matching its own category code |
| Path traversal | Admin paths are resolved through `realpath` and rejected unless inside `MEDIA_ROOT`; null bytes rejected |
| Zip slip | Entry names are validated before extraction; `../`, absolute paths, and symlink entries are skipped |
| Revocation is immediate | Expiring a key deletes its sessions and the next request fails |
| Strict CSP | `default-src 'none'`, no inline script or style anywhere in the app |

The test suites cover each of these, including stolen-cookie replay from a second IP, forged
stream tokens, traversal attempts, and a zip built with a `../` entry.

### What download protection can and cannot do

Playback links are signed, expire in about two minutes, are tied to one session and one IP, and
the browser download control is removed. A copied URL pasted elsewhere fails almost immediately.

It does not make video theft impossible, and no web player can. Anyone who can watch a video can
capture it, whether with screen recording or by reading the bytes their own browser already
received. Treat the design goal as "casual copying and link sharing do not work", not "the file
cannot be taken".

For that reason the viewer's key hint is drawn as a moving watermark over the video. It does not
prevent capture; it makes a leaked recording traceable to the account it came from, which is the
strongest practical deterrent.

**The site does not tell users it cannot be hacked.** The gate lists four specific, true
protections instead. A false security promise is both untrue and an invitation, and if it were
ever broken it would be the thing users remember.

### Buffering

Video is served over HTTP range requests, so seeking jumps straight to the requested bytes and
the browser buffers ahead on a single connection. That is as smooth as a single file can be, but
it is one fixed quality: a viewer on a weak connection still waits.

Eliminating that needs adaptive streaming, where each video is pre-packaged into several
bitrates as HLS and the player switches between them live. That is an ffmpeg packaging step plus
an HLS player, and it is the natural next piece of work.

## Operating notes

### IP locking on mobile networks

`IP_MATCH_MODE=strict` matches the exact IP. It is the tightest setting and the one to use for
desktop or fixed connections.

Mobile IPs change constantly: switching between Wi-Fi and mobile data, moving between cell
towers, or carrier NAT rotation all produce a new address. Under `strict` those viewers are
locked out mid-session and need **Unlock IP** every time.

`IP_MATCH_MODE=relaxed` matches the IPv4 `/24` or IPv6 `/64` instead. It still blocks a key
shared with someone in another city or country while tolerating normal mobile drift. For a
mobile-first audience, start here. `.env.example` ships with `relaxed` for that reason; the test
suite exercises `strict`.

### TRUST_PROXY_HOPS

This must match your deployment or IP locking is unsound.

- `0` — Node is exposed directly. The socket address is used and `X-Forwarded-For` is ignored.
- `1` — exactly one reverse proxy you control (nginx, Caddy) sits in front.
- `2` — two, for example Cloudflare in front of nginx.

Too high and a visitor can forge the header to pick their own IP, defeating the lock. Too low
and every viewer appears to come from your proxy, so all keys lock to one address.

### Durability

Writes use `w:"majority", j:true`: MongoDB acknowledges only after the write is journaled on a
majority of replica set members, so an acknowledged write survives a primary failure.
`retryWrites` covers transient network blips and elections.

Nothing is deleted on a timer. Expiry is a date comparison, so expired keys and finished
subscriptions remain fully auditable. The only TTL collections are ephemeral: sessions and
view-dedupe marks.

### Before going live

1. Terminate TLS at a reverse proxy and keep `COOKIE_SECURE=true`. Cookies marked `Secure` are
   not sent over plain HTTP, so the site will not work over `http://` with that setting on.
2. Set `TRUST_PROXY_HOPS` to your real proxy count.
3. Keep `ADMIN_TOKEN` out of the repository. `.env` is gitignored.
4. Back up MongoDB. The database holds every key, subscription, and watch position; the video
   files are separate and are never modified by this app.
5. Decide the two things this code cannot decide for you: whether your audience needs age
   verification before entry, and that you hold distribution rights to everything you import.
   Both are legal requirements in most places for a paid video archive, and both are far cheaper
   to handle now than after a complaint.

## Project layout

```
src/
  server.js              startup, graceful shutdown
  app.js                 middleware, CSP, routing
  config.js              env parsing and validation
  db.js                  connection, collections, indexes
  lib/
    crypto.js            hashing, HMAC signing, stream tokens
    ip.js                client IP resolution and fingerprinting
    errors.js            typed HTTP errors
  security/auth.js       session and admin middleware
  services/
    accessKeys.js        key creation, IP claiming, plan lifecycle
    sessions.js          signed cookies, presence
    catalog.js           categories, archives, import, numbering
    media.js             sandboxed filesystem access, zip, thumbnails
    engagement.js        progress, likes, view counting
    broadcasts.js        broadcasts and acknowledgements
    counters.js          atomic sequence blocks
  routes/                gate, catalog, stream, engagement, admin
public/
  index.html watch.html admin.html
  css/   theme.css (tokens, shared) + gate, app, admin
  js/    api, gate, app, player, presence, admin
  fonts/ self-hosted Bricolage Grotesque + Instrument Sans
tests/
  e2e.mjs        API and security
  browser.mjs    real Chromium
  screenshots.mjs
```

## Design

The direction is editorial and nocturnal, closer to a fashion magazine than a dashboard.

| Role | Typeface | Why |
| --- | --- | --- |
| Headings and text | Plus Jakarta Sans | Tall x-height and open letter shapes stay clear at 12px on phones, and its 800 weight gives tight, heavy headlines |
| Accent words | Bodoni Moda italic | The high-contrast italic sets words like *Pleasure* and *archives* apart from the sans |
| Codes and numbers | Martian Mono | Keys, `#numbers`, timers and labels, so identifiers always read as data |

A high-contrast serif italic next to a plain sans is a standard editorial pairing: the two never
compete because their roles are obvious. All three are variable WOFF2 files under the SIL Open
Font License, self-hosted so no third party sees your traffic. Colour runs from rose through peach to champagne over a violet-black background with
a slow aurora and a faint film grain.

### Interaction

- **First visit:** a splash screen shows the banner with "Wait, loading your experience" and a
  real progress bar while it downloads the seal video, fonts, character art and the home page
  scripts. It stays at least 2.2 seconds, gives up waiting after 10, and only appears once per
  browser.
- **Gate:** a circular seal playing a looping video, with a pink and cyan glow on its sides. A
  character peeks over the key card: she smiles while idle, a different character looks down when
  a key is wrong, and a happy one hops on success.
- **Unlock:** a correct key turns the field and button green, a gradient ring sweeps round the
  seal, the seal thumps, shockwaves and about 34 sparks burst out, a check mark draws in, and an
  iris wipe opens from the seal into the home page, which fades in to continue the motion.
- **Wrong key:** the card and seal shake with a haptic buzz, and when a viewer is signed out, the
  gate explains why.
- **Home:** a time-of-day greeting, a character cut-out behind the hero with a slow parallax on
  scroll, stat chips, and archive cards built from a mosaic of the three most-watched thumbnails. On desktop the cards tilt and light up under the pointer.
- **Archive:** a sticky search that jumps straight to a number (`#42` or `42`) or matches titles,
  a sort control whose highlight slides between options, and infinite scroll.
- **Player:** an ambient glow taken from the thumbnail, a "Resuming from 3:12" chip, a burst
  animation on like, and a Netflix-style up-next card with a 6-second countdown that cancels if
  the viewer scrubs back.
- **Account sheet:** a ring showing how much of the plan is left, counting down to the days
  remaining.
- **Owner console:** stat values that count up, styled confirmation sheets instead of browser
  dialogs, toasts for every action, clickable folder breadcrumbs, and one-tap plan presets.

View changes use the View Transitions API where the browser supports it. Primary buttons pull
toward the pointer and ripple on press. Every animation sits behind a `prefers-reduced-motion`
guard and collapses to near-zero duration for people who ask for less motion.

Character art also appears in the account and broadcast sheets, the empty states and the owner
login. Backgrounds were removed with the BiRefNet segmentation model, and each cut-out is a
transparent WebP of about 15 to 42 KB. The seal loop is 400px square, about 300 KB as MP4 and
340 KB as WebM, with a 10 KB poster shown instantly. It does not autoplay when the phone asks for
reduced motion or data saving.

The layout is mobile-first, designed at 414px wide, with tap targets of at least 40px and
safe-area insets respected on notched phones.
