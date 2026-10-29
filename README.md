# CPE Explorer — standalone package

A course-explorer game for the KMUTT B.Eng. Computer Engineering (International) curriculum, B.E. 2569.
Everything the game needs is in this folder: the 3D engine (three.js), the fonts, the pictures and the course data.
**The page makes no requests to outside websites.**

```
cpe-explorer/
  server.js                   ← game + scoreboard server (Node.js, no packages to install)
  Dockerfile, docker-compose.yml
  .env.example                ← settings: port, admin key
  admin.sh                    ← list / delete / rename / reset scoreboard entries
  data/                       ← scores.json is created here
  public/                     ← the game itself
    index.html
    config.js                 ← where the scoreboard lives
    data/world.js             ← courses, descriptions, quiz questions (EN/TH)
    img/                      ← course pictures and banners (WebP)
    fonts/                    ← Chakra Petch + Mitr (SIL Open Font License, see OFL.txt)
    vendor/three/             ← three.js r128 (MIT licence)
```

---

## Fastest: run the published image (one command)

Every update to this repository is built automatically by GitHub Actions and published as
`ghcr.io/santitham/cpe-explorer`. A server only needs Docker — no source code, no build:

```bash
docker run -d --name cpe-explorer --restart unless-stopped -p 8080:8080 \
  -e ADMIN_KEY=change-me -v cpe-data:/app/data \
  ghcr.io/santitham/cpe-explorer:latest
```
Open `http://<server>:8080`. Scores live in the Docker volume `cpe-data` and survive updates.

**Update to the newest version**
```bash
docker pull ghcr.io/santitham/cpe-explorer:latest
docker rm -f cpe-explorer      # the scores stay in the cpe-data volume
# …then run the same docker run command again
```

**Prefer compose?** Copy `deploy/docker-compose.yml` and `.env.example` (renamed `.env`) to a folder on the server, then
`docker compose up -d`; update with `docker compose pull && docker compose up -d`. Scores are kept in `./data` next to it.

**Pin a version** instead of `latest`: use a release tag such as `ghcr.io/santitham/cpe-explorer:1.0.0`
(published when a `v1.0.0` git tag is pushed) or a commit tag like `sha-abc1234`.

**Back up scores** (volume version): `docker cp cpe-explorer:/app/data/scores.json ./scores-backup.json`.
**Admin commands** work the same way: `URL=http://<server>:8080 ADMIN_KEY=… ./admin.sh list`.

---

## Other ways to run it

| | Shared scoreboard | Needs |
|---|---|---|
| **A. Docker** (recommended for a server) | Yes | Docker |
| **B. Node.js** | Yes | Node.js 18 or newer |
| **C. Offline file** | No — each device keeps its own | A modern browser |
| **D. Any static web host** (Apache, nginx, GitHub Pages…) | No — each device keeps its own | Copy `public/` |

### A. Docker

```bash
cp .env.example .env          # then edit ADMIN_KEY (any long random text)
docker compose up -d          # builds the image and starts it
```
Open `http://<server>:8080`. Scores are saved in `./data/scores.json` on the host, so they survive restarts and upgrades.

- Stop: `docker compose down` · Logs: `docker compose logs -f`
- Change the port: set `PORT=80` (or any) in `.env`, then `docker compose up -d` again.
- If the build fails with `429 Too Many Requests` from Docker Hub, add
  `NODE_IMAGE=mirror.gcr.io/library/node:22-alpine` to `.env` and run `docker compose up -d --build`.
- The container runs the server as an unprivileged user and makes `./data` writable for it on start-up.

### B. Node.js without Docker

```bash
cp .env.example .env          # optional; edit ADMIN_KEY
node server.js                # → http://localhost:8080
```
There is no `npm install` step — the server only uses Node's built-in modules.
To keep it running after logout, use your usual process manager, e.g. `pm2 start server.js --name cpe-explorer`
or a systemd service.

### C. Offline single file

(Shipped in the zip package, not stored in this repository.)

Copy `cpe-explorer-offline.html` to any computer and double-click it. No server and no internet needed.
The scoreboard is kept in that browser only.

### D. Static web hosting

Upload the **contents of `public/`** to any web space. Then edit `public/config.js` and set `scoreApi: ""`,
because there is no scoreboard server. Each device will keep its own scoreboard.

---

## Putting it behind the university web server (HTTPS)

Run the game with A or B on an internal port, then forward a public address to it.

**nginx** (game at `https://example.kmutt.ac.th/cpe-explorer/`):
```nginx
location /cpe-explorer/ {
    proxy_pass http://127.0.0.1:8080/;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```
**Caddy**:
```
example.kmutt.ac.th {
    handle_path /cpe-explorer/* { reverse_proxy 127.0.0.1:8080 }
}
```
All paths inside the game are relative, so it works at a sub-path like `/cpe-explorer/`.
Set `TRUST_PROXY=true` in `.env` so the rate limit sees each visitor's real IP address.

---

## Scoreboard

**How it works.** Each player gets a random id stored in their browser. While they play, the game sends
their nickname and totals (courses found, stars, shards, island stars, title) to `api/scores`.
The board shows the top 200.

**Built-in protection** (it is a public page):
- **Impossible scores are rejected.** The server recomputes the score from the totals and checks every number
  against the game's limits (e.g. 81 courses, 79 questions, maximum score 3,390).
- **Rate limit:** one save per player per 2 seconds.
- **Nicknames:** limited to 14 letters/numbers; names containing a blocked word become "Explorer".
  Add your own blocked words to `data/blocklist.txt`, one per line, then restart.
- **Size cap:** the board keeps the best 5,000 entries (`MAX_ENTRIES` in `.env` to change).

**If the server is down** the game keeps working and shows the scoreboard saved on that device instead.

**Admin** (needs `ADMIN_KEY` in `.env`):
```bash
./admin.sh list                    # id, score, nickname
./admin.sh rename <id> "New name"  # fix an inappropriate nickname
./admin.sh delete <id>             # remove one entry
./admin.sh reset                   # clear the board (a backup file is written to data/ first)
URL=https://example.kmutt.ac.th/cpe-explorer ./admin.sh list   # manage a remote server
```
The same actions are plain HTTP calls with header `X-Admin-Key`:
`GET /api/admin/scores`, `PATCH|DELETE /api/admin/scores/<id>`, `POST /api/admin/reset`.

**Backup:** copy `data/scores.json`. To restore, stop the server, put the file back, start it.

---

## Editing content

- **Course text and quiz questions:** `public/data/world.js`. Each course has `bank`: 4 questions, each with
  `en` and `th` arrays: `[question, correct answer, wrong 1, wrong 2, wrong 3, wrong 4]`.
  The game shows one question at random, with the correct answer and 2 of the 4 wrong answers.
  After editing, reload the page (no rebuild). Keep the file valid JavaScript — a missing comma stops the game from loading.
- **Pictures:** replace a file in `public/img/` with another WebP of the same name (4:3 for courses).
- **Scoreboard location:** `public/config.js`.

The offline single file contains its own copy of everything; ask for it to be rebuilt after content changes.

---

## Updating to a new version

Replace everything **except** `data/` and `.env`, then:
- Docker: `docker compose up -d --build`
- Node: restart `node server.js`

---

## ภาษาไทย — เริ่มต้นใช้งานอย่างย่อ

0. **เร็วที่สุด:** `docker run -d --name cpe-explorer --restart unless-stopped -p 8080:8080 -e ADMIN_KEY=รหัสลับ -v cpe-data:/app/data ghcr.io/santitham/cpe-explorer:latest`
1. **มี Docker:** `cp .env.example .env` แก้ `ADMIN_KEY` แล้วรัน `docker compose up -d` → เปิด `http://<server>:8080`
2. **มีแค่ Node.js 18+:** `node server.js` (ไม่ต้อง `npm install`)
3. **ไม่มีเซิร์ฟเวอร์:** ดับเบิลคลิก `cpe-explorer-offline.html` เล่นได้ทันที (ตารางคะแนนเก็บแยกในแต่ละเครื่อง)

- คะแนนเก็บที่ `data/scores.json` — สำรองไฟล์นี้ไว้เป็นระยะ
- จัดการตารางคะแนน: `./admin.sh list | rename | delete | reset`
- แก้คำถามหรือเนื้อหารายวิชา: `public/data/world.js` แล้วรีโหลดหน้าเว็บ
