# Running TaleShed as a systemd service

Run TaleShed in the background, independent of SSH, and start it automatically after reboot.

You can run:

- **MCP only** – one service for the HTTP MCP server.
- **Authoring only** – a second service for the authoring web app (optional, if you don’t use the combined option).
- **MCP + Authoring together** – one service that starts both; a single restart restarts both (see below).

---

## Option A: MCP server only (one service)

### 1. Create the service file

On the server, create a systemd unit file (adjust paths and user if needed):

```bash
sudo nano /etc/systemd/system/taleshed.service
```

Paste the following. Replace `jpmoo` with your Linux username and `/home/jpmoo/taleshed` with your TaleShed install path. If Node is not in `/usr/bin/node`, use `which node` and put that path in `ExecStart`.

```ini
[Unit]
Description=TaleShed MCP Server (HTTP)
After=network.target

[Service]
Type=simple
User=jpmoo
Group=jpmoo
WorkingDirectory=/home/jpmoo/taleshed

# Load .env from the project dir (TALESHED_PORT, etc.)
EnvironmentFile=-/home/jpmoo/taleshed/.env

ExecStart=/usr/bin/node -r dotenv/config dist/http.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

- **User/Group:** Run as your user so the process can read your repo and write `taleshed.db` and logs.
- **WorkingDirectory:** Must be the TaleShed project root (where `dist/` and `.env` live).
- **EnvironmentFile:** Optional. If `.env` exists, variables like `TALESHED_PORT` are loaded. The `-` means “ignore if missing.”
- **ExecStart:** If `node` is elsewhere (e.g. nvm), use the full path from `which node`.

Save and exit.

## 2. Reload systemd and enable the service

```bash
sudo systemctl daemon-reload
sudo systemctl enable taleshed.service
sudo systemctl start taleshed.service
```

- **enable:** Start TaleShed on boot.
- **start:** Start it now.

## 3. Check status and logs

```bash
sudo systemctl status taleshed.service
journalctl -u taleshed.service -f
```

Log file path (from the app) is printed at startup, e.g. `Request/error log: /home/jpmoo/taleshed/taleshed-errors.log`.

## 4. Useful commands

| Command | Purpose |
|--------|--------|
| `sudo systemctl start taleshed` | Start the service |
| `sudo systemctl stop taleshed` | Stop the service |
| `sudo systemctl restart taleshed` | Restart after code/config changes |
| `sudo systemctl disable taleshed` | Do not start on boot |
| `journalctl -u taleshed -n 100` | Last 100 log lines |

## 5. After updating the code

Rebuild and restart:

```bash
cd ~/taleshed
git pull
npm run build
sudo systemctl restart taleshed
```

If you re-seed the DB, restart the service so it uses the new database state.

---

## Option B: One service runs both MCP and authoring (restart restarts both)

To have **one** systemd service start both the MCP server and the authoring web app, use the wrapper script. A single `systemctl restart taleshed` then restarts both processes.

1. Make the script executable (once, in the project):

   ```bash
   chmod +x /home/jpmoo/taleshed/scripts/run-with-authoring.sh
   ```

2. Ensure `.env` includes authoring settings (at least `TALESHED_WEB_API_KEY`). See `.env.example`.

3. Use the same `taleshed.service` as above, but change **ExecStart** to the script:

   ```ini
   ExecStart=/home/jpmoo/taleshed/scripts/run-with-authoring.sh
   ```

   If Node is not on the default `PATH` when systemd runs the service, set it:

   ```ini
   Environment=PATH=/usr/bin:/bin
   ```
   or set `Environment=NODE=/full/path/to/node` if you use nvm.

4. Reload and restart:

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl restart taleshed
   ```

If either the MCP server or the authoring server exits, the script exits and systemd will restart both (when `Restart=on-failure`).

**If the service keeps restarting (exit code 1):** check logs with `journalctl -u taleshed -n 80 --no-pager`. The authoring server exits with code 1 if `TALESHED_WEB_API_KEY` is missing or empty in `.env` — add it and restart. If you see "node not found", set `Environment=NODE=/full/path/to/node` (or add Node to `PATH`) in the service file.

**If you see status=203/EXEC:** systemd could not execute the script. Check: (1) the path in `ExecStart` is correct and the file exists, (2) the script is executable (`chmod +x /home/jpmoo/taleshed/scripts/run-with-authoring.sh`), (3) the script has Unix line endings — if it was edited on Windows or copied with CRLF, run `sed -i 's/\r$//' /home/jpmoo/taleshed/scripts/run-with-authoring.sh` on the server, then `systemctl restart taleshed`.

---

## Option C: Two separate services (MCP and authoring)

If you prefer to run and restart MCP and authoring independently, keep the MCP-only service above and add a second unit:

```bash
sudo nano /etc/systemd/system/taleshed-authoring.service
```

```ini
[Unit]
Description=TaleShed Authoring Web App
After=network.target

[Service]
Type=simple
User=jpmoo
Group=jpmoo
WorkingDirectory=/home/jpmoo/taleshed
EnvironmentFile=-/home/jpmoo/taleshed/.env
ExecStart=/usr/bin/node -r dotenv/config dist/authoring-server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl enable taleshed-authoring
sudo systemctl start taleshed-authoring
```

Restart only the authoring app with `sudo systemctl restart taleshed-authoring`, or both with `sudo systemctl restart taleshed taleshed-authoring`.
