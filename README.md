# World Clock

A self-hosted world clock — add any city, see its time update live, all synced from real internet time servers when you're online, and still fully working from your device's own clock when you're not. No build step, no dependencies — it runs directly on the official `node` image with your code just mounted in as files, exactly like Simple Contacts.

## What's in this folder

```
world-clock/
├── app/                  ← the app itself, goes in ZimaOS's file manager
│   ├── server.js
│   └── public/
│       ├── index.html
│       ├── styles.css
│       ├── app.js
│       ├── manifest.webmanifest
│       ├── service-worker.js
│       ├── fonts/
│       └── icons/
├── data/                 ← empty folder; this is where clocks.json will be saved
└── docker-compose.yml    ← paste this into ZimaOS's "Custom Install"
```

## Installing on ZimaOS, using only the web UI

**1. Copy the files onto ZimaOS**

Open the ZimaOS **Files** app and create a folder, for example:
`/DATA/AppData/world-clock/`

Inside it, upload:
- the `app` folder (with `server.js` and `public/` inside it)
- an empty `data` folder

So you end up with `/DATA/AppData/world-clock/app/server.js` and `/DATA/AppData/world-clock/data/` (empty, for now).

*(If your ZimaOS uses a different root than `/DATA`, just note the actual path shown in the Files app — you'll use it in step 3.)*

**2. Open the Custom Install screen**

In the ZimaOS App Store, choose **Install a Custom App** (sometimes labeled **Custom Install** on the app card, or a "Docker Compose" tab in the install dialog).

**3. Paste the compose file**

Open `docker-compose.yml` from this folder, copy its contents, and paste it into the Docker Compose box. Before submitting, check the two `source:` paths under `volumes:` — they need to match wherever you actually put the `app` and `data` folders in step 1. They're currently set to:
```
/DATA/AppData/world-clock/app
/DATA/AppData/world-clock/data
```
Edit those two lines if your folder path is different.

**4. Submit / Install**

ZimaOS will pull the standard `node:20-alpine` image (no custom build needed) and start the container.

**5. Open it**

Visit `http://<your-zimaos-ip>:8089` from any device on your network — phone, laptop, tablet. If port 8089 is already taken, change the `published:` value in the compose file before installing.

## Installing it like an app on your phone

Open that address in your phone's browser, then use **Add to Home Screen** (Safari) or **Install app** (Chrome). It'll get its own icon and open full-screen, no browser bar — a real app on your home screen, backed by your own server.

## How the time sync works

The server queries six independent public time servers directly over NTP — Google, Cloudflare, Microsoft, Apple, NIST, and the NTP Pool — takes the median offset from whichever respond, and hands that corrected time to the browser. You can see exactly which servers answered, their round-trip time, and the resulting offset by tapping the sync pill in the top bar.

**If your server's internet connection drops, the app keeps working.** Every clock falls back to using the server/device's own system clock instead — nothing freezes or errors out, it just quietly stops correcting for drift until a time server is reachable again. The sync pill turns from green ("Synced • n/6 servers") to a neutral "Offline · device clock" so you always know which mode you're in.

Your saved list of cities is stored server-side in `data/clocks.json`, so every device that opens the same URL sees the same clocks — add a city from your phone, see it on your laptop too.

## Backups

Use the "⋯" menu in the app to **Export** a JSON backup any time, or **Import** one back in. Your live data also just sits as a plain file at `data/clocks.json` in the folder you made in step 1, so you can copy it directly from the Files app too.
