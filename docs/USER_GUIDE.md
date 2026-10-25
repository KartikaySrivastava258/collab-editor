# User guide

## First launch

1. Start the server (see the README) and open it in a browser (`http://localhost:8080` with Docker
   or the Go binary serving the frontend; `http://localhost:3000` with the dev setup).
2. Click **New document**. The address becomes `…/#doc-xxxxxxxx`; that hash *is* the room.
3. While connecting you see a short loading state, then **Connected** in the header.
4. Start typing. The status bar shows **Syncing N changes…** until the server acknowledges them,
   then **All changes synced to server memory**.

## Writing together

1. Click **Share** to copy the room link and send it to a collaborator (anyone with the link can
   edit; there are no accounts).
2. When they open it, their avatar appears in the header and the count in the status bar rises.
3. Both of you can type anywhere at the same time; changes merge automatically and nothing typed
   is lost. Your caret stays where it was when others edit before or after it.
4. When someone closes the tab, their avatar disappears.

## Editing features

| Action | How |
|---|---|
| Undo / redo your own edits | Toolbar, `Ctrl/⌘+Z`, `Ctrl/⌘+Shift+Z` or `Ctrl+Y`. Collaborators' edits are never undone. |
| Copy all text / download `.txt` | Toolbar |
| AI continuation (if the server has an AI key) | **Suggest** → review the suggestion (only you see it) → **Insert at cursor** or **Discard**. Inserted text is one undo step. If AI isn't configured, the button is disabled and its tooltip says why. |
| Rename yourself | Sidebar → **Rename** (shown to collaborators) |
| Join a room | Sidebar → paste a room ID or a full link → **Join** |
| Recent rooms | Sidebar list (stored only in this browser) |
| Hide sidebar | Header button (remembered); on narrow screens use the ☰ menu |
| Skip to editor | Press `Tab` once after the page loads, then `Enter` |

## When the connection drops

- The header shows **Reconnecting…** or **Can't reach server**, and a banner says when the next
  attempt happens. **Retry now** tries immediately.
- You can keep typing. The status bar shows **N changes waiting to sync — kept in this tab**.
  They are sent automatically when the connection returns, merged with anything others wrote
  meanwhile, and you get a **Reconnected** notice.
- If you try to switch rooms with unsynced changes you are asked to confirm, and closing the tab
  triggers the browser's "leave site?" warning.
- If the server restarted and lost the room, your open tab restores it automatically.

## What to know about storage

Documents are kept **in the server's memory**, not on disk. They survive page refreshes and
reconnects, but are lost if the server restarts while no one has the document open. Use
**Download .txt** for anything you need to keep.
