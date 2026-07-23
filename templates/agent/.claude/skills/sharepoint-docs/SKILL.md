---
name: sharepoint-docs
description: "You need to read, write, or browse files in the newly-mounted WYRE SharePoint document library — the Product/AI/Conduit folder is now available as a normal read-write directory. Use this before treating the mount as read-only, before assuming a write landed on the cloud instantly, or before leaving any test/scratch file behind in it. This is a LIVE company drive with real business content, not a sandbox."
triggers: ["sharepoint", "onedrive", "wyre-o365-conduit", "harness onedrive", "sharepoint mount", "product/ai/conduit", "conduit sharepoint folder", "write to sharepoint", "upload to sharepoint", "sharepoint docs", "rclone mount", "shared documents"]
---

# Working with the WYRE SharePoint Mount

WYRE's SharePoint `Product/AI/Conduit` folder is mounted locally and reachable as a normal read-write directory. This is a real, live company drive — not a sandbox, not a copy. Treat every read and write accordingly.

---

## Where it is

- **Real mount**: `/mnt/wyre-o365-conduit` on `wyre-os-dev` — one `rclone` FUSE mount, `systemd`-managed (`rclone-onedrive-conduit.service`, `Restart=on-failure` + `WantedBy=default.target`), comes back automatically after a reboot or crash. No manual intervention needed.
- **Symlinked in per-harness**: `~/.claude/harness-angela/onedrive` and `~/.claude/harness-tyler/onedrive` both point at the same real mount. It is **one shared folder**, not siloed per harness — a file either harness writes is immediately visible to the other, because it's the same underlying mount, not a sync or a copy.
- **Mode**: read-write, by explicit design (not read-only).

## What it actually is

- Backend: `wyretechnology.sharepoint.com`, site `WyreTechnology`, default document library, specifically the **`Product/AI/Conduit` subfolder** — nested under `Product/AI`, not the library/drive root. Don't expect to see anything above `Conduit` when browsing from the mount root.
- Reference URL: `https://wyretechnology.sharepoint.com/sites/WyreTechnology/Shared%20Documents/Product/AI/Conduit`
- Anything read or written through `~/.claude/harness-<name>/onedrive/...` is a real file in that real SharePoint folder — the same file a human would see opening the SharePoint web UI or the OneDrive desktop app. Not a cache-only view.

## How to use it

Plain filesystem operations — no special SDK or API call needed:

```bash
ls ~/.claude/harness-angela/onedrive/
markitdown ~/.claude/harness-angela/onedrive/some-file.docx
echo "..." > ~/.claude/harness-angela/onedrive/notes.md
cp local-file.pdf ~/.claude/harness-angela/onedrive/
mv / rm work the same way
```

`ls`, `echo >`, `cp`, `mv`, `rm` through the symlinked path all just work like any normal directory.

## Convert non-markdown files through markitdown before reading them

Most of what lives in this drive is not markdown — `.docx`, `.xlsx`, `.pptx`, `.pdf`. Do not `cat` those directly: `.docx`/`.xlsx`/`.pptx` are zip containers of XML, and a raw `cat` returns binary noise, not content. `.pdf` is not readable as plain text either.

Convert first, every time:

```bash
markitdown ~/.claude/harness-angela/onedrive/some-file.docx -o /tmp/some-file.md
cat /tmp/some-file.md
```

- `markitdown` (Microsoft's CLI, installed via pipx — see TOOLS.md) turns `.docx`/`.xlsx`/`.pptx`/`.pdf`/`.html` into clean markdown
- Meaningfully cuts token usage vs any raw-extraction fallback — measured ~64% smaller converting a real doc from this exact folder (48.8KB raw XML down to 17.5KB markdown)
- Write the converted `.md` to `/tmp` or your scratchpad, not back into the SharePoint folder — the mount holds the original documents, converted copies are a local reading aid only
- `.md` files already in the mount need no conversion — read them directly

---

## The gotcha that matters most: writes are not instant on the backend

`rclone` runs with `vfs-cache-mode full` — it buffers writes locally and uploads to the actual SharePoint backend roughly **5+ seconds** after a file is last touched.

- Reading a file back **through the same mount** is instant (served from local cache) — this part behaves exactly like a normal filesystem.
- The delay is specifically for the **round-trip to the cloud backend**. If you write a file and then immediately check for it a *different* way — the SharePoint web UI, a Graph API call, a separate process — it may not be there yet.

**Practical rule**: if you need to confirm a write actually landed on SharePoint (not just locally), wait a few seconds before checking externally. An empty external check immediately after a write does not mean the write failed.

## The gotcha that matters second most: do not leave stray files

This is a **live company drive** with real business content (marketing collateral, sales research, brand assets — currently ~30 real folders in there). Any test or scratch write must be cleaned up:

- Use a name that can't collide with anything real — a clear prefix like `forge-test-` or `<agent>-test-` is a good convention.
- Actually delete it when done, and **confirm it's gone** — don't just delete locally and assume that's sufficient.
- **A write that reads back through the mount is not proof it landed in the right real-world place.** This bit forge directly: a `root_folder_id` scoping bug during setup caused test writes to silently land at the SharePoint **drive root** instead of the `Conduit` folder, even though they read back fine through the mount. Found and cleaned up 5 stray files via the Graph API before calling the mount done. If in doubt, verify the file's actual location directly (Graph API or the SharePoint web UI), don't trust the mount-local read-back alone.

## Safety net that exists (SharePoint-level, not mount-level)

SharePoint document libraries have their own Recycle Bin (roughly 90+ day retention) and file version history, independent of the mount — so an accidental delete or overwrite is not permanently unrecoverable. Recovery means someone going into the SharePoint web UI directly, not a local undo. This is a backstop, not a substitute for care — don't rely on it in place of double-checking before you write or delete.

---

## Quick reference

| Question | Answer |
|---|---|
| Where do I read/write? | `~/.claude/harness-<name>/onedrive/` (symlink) |
| What's the real path? | `/mnt/wyre-o365-conduit` |
| What SharePoint folder is this? | `Product/AI/Conduit`, under the `WyreTechnology` site's default document library |
| Is it shared across harnesses? | Yes — one mount, both `angela` and `tyler` see the same files |
| Read-only or read-write? | Read-write |
| Survives a reboot? | Yes — `systemd` unit `rclone-onedrive-conduit.service` restarts it automatically |
| Do writes land instantly? | Locally yes, on the actual SharePoint backend ~5+ seconds later |
| Can I use it for scratch/test files? | Only with a clear disposable-name prefix, and only if you delete + confirm-gone when done |
| What if I delete/overwrite something real by accident? | SharePoint's own Recycle Bin (~90+ days) and version history are a backstop — but don't rely on it instead of care |
| How do I read a `.docx`/`.xlsx`/`.pptx`/`.pdf`? | Convert with `markitdown` first — never `cat` these directly, see above |
