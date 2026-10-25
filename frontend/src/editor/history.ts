/**
 * Undo/redo of this client's own edits only.
 *
 * The browser's native undo stack cannot be used: it is cleared whenever the
 * editor writes remote changes into the textarea, and it would undo remote
 * users' text. Instead each local edit records the atom IDs it inserted and
 * deleted. Undo deletes the inserted atoms and re-inserts copies of deleted
 * text immediately after the (still present) tombstones, so restored text
 * returns to its original place even if others edited around it meanwhile.
 * Both directions produce ordinary CRDT ops, so collaborators see them too.
 */
import type { AtomId, Op, RgaDocument } from '../crdt/rga.ts';
import { sameId } from '../crdt/rga.ts';

export interface HistoryEntry {
  inserted: AtomId[];
  deleted: AtomId[];
  at: number;
  /** Sealed entries (e.g. an inserted AI suggestion) never merge with neighbours. */
  sealed?: boolean;
}

export interface HistoryResult {
  ops: Op[];
  /** Caret goes after this atom (works for tombstones); null = start. */
  caretAfter: AtomId | null;
}

const MERGE_WINDOW_MS = 1000;

export class EditHistory {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private limit: number;

  constructor(limit = 500) {
    this.limit = limit;
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  /**
   * Record a local edit. Consecutive pure insertions that continue the
   * previous run within one second are merged into one undo step.
   */
  record(inserted: AtomId[], deleted: AtomId[], after: AtomId | null, now = Date.now(), mergeable = true): void {
    if (inserted.length === 0 && deleted.length === 0) return;
    this.redoStack = [];
    const last = this.undoStack[this.undoStack.length - 1];
    if (
      mergeable && last && !last.sealed && deleted.length === 0 && last.deleted.length === 0 && inserted.length > 0 &&
      now - last.at < MERGE_WINDOW_MS && last.inserted.length > 0 &&
      sameId(after, last.inserted[last.inserted.length - 1])
    ) {
      last.inserted.push(...inserted);
      last.at = now;
      return;
    }
    this.undoStack.push({ inserted: [...inserted], deleted: [...deleted], at: now, sealed: !mergeable });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
  }

  undo(doc: RgaDocument, clientId: string): HistoryResult | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    const { result, inverse } = invert(doc, clientId, entry);
    this.redoStack.push(inverse);
    return result;
  }

  redo(doc: RgaDocument, clientId: string): HistoryResult | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    const { result, inverse } = invert(doc, clientId, entry);
    this.undoStack.push(inverse);
    return result;
  }
}

function invert(doc: RgaDocument, clientId: string, entry: HistoryEntry): { result: HistoryResult; inverse: HistoryEntry } {
  const removedNow = entry.inserted.filter(id => doc.has(id) && !doc.isDeleted(id));
  const ops: Op[] = [...doc.deleteIds(removedNow)];
  let restored: AtomId[] = [];
  const toRestore = entry.deleted.filter(id => doc.has(id));
  if (toRestore.length > 0) {
    const text = toRestore.map(id => doc.valueOf(id) ?? '').join('');
    const anchor = toRestore[toRestore.length - 1]; // tombstone stays in the sequence
    const inserts = doc.insertText(clientId, anchor, text);
    ops.push(...inserts);
    restored = inserts.map(op => op.id);
  }
  const caretAfter = restored.length > 0
    ? restored[restored.length - 1]
    : entry.inserted.length > 0 ? entry.inserted[0] : null;
  // Caret after an undone insertion goes where the insertion began: the atom
  // before it. Using the first (now deleted) inserted atom's position works
  // because visibleCountThrough() counts only visible atoms up to it.
  return {
    result: { ops, caretAfter },
    inverse: { inserted: restored, deleted: removedNow, at: 0 },
  };
}
