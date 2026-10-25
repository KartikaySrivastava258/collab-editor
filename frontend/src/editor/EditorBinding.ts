/**
 * Binds a plain <textarea> to a SyncClient.
 *
 *  - Local input: the browser performs the edit; on `input` we diff the old
 *    and new value (textDiff) and turn the change into CRDT ops that reference
 *    atom IDs. Works for typing, selection replacement, paste, cut, drag and
 *    drop, autocorrect, emoji pickers and IME (applied at compositionend).
 *  - Remote changes: written to the textarea outside IME composition; the
 *    selection is anchored to atom IDs (not offsets), so remote inserts before
 *    the caret shift it correctly and the caret never jumps.
 *  - Undo/redo: intercepted and served by EditHistory (own edits only).
 *  - The textarea is uncontrolled; React never re-renders it per keystroke.
 */
import type { AtomId, Op } from '../crdt/rga.ts';
import { codePoints } from '../crdt/rga.ts';
import { diffText, utf16ToCodePointIndex, codePointIndexToUtf16 } from './textDiff.ts';
import type { TextEdit } from './textDiff.ts';
import { EditHistory } from './history.ts';
import type { SyncClient } from '../sync/SyncClient.ts';

export interface BindingEvents {
  /** A local edit was refused (e.g. document size limit). */
  onRejected?: (reason: string) => void;
  /** Undo/redo availability or text changed. */
  onChange?: () => void;
}

export class EditorBinding {
  readonly history = new EditHistory();
  private el: HTMLTextAreaElement;
  private sync: SyncClient;
  private events: BindingEvents;
  private domText = '';
  private domIds: AtomId[] = [];
  private domValues: string[] = [];
  /** True if the text may contain surrogate pairs (UTF-16 offset ≠ code-point index). */
  private astral = false;
  private composing = false;
  private dirty = false;
  private cleanup: (() => void)[] = [];

  constructor(el: HTMLTextAreaElement, sync: SyncClient, events: BindingEvents = {}) {
    this.el = el;
    this.sync = sync;
    this.events = events;
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      el.addEventListener(type, fn as EventListener);
      this.cleanup.push(() => el.removeEventListener(type, fn as EventListener));
    };
    on('input', e => { if (!this.composing && !(e as InputEvent).isComposing) this.syncFromDom(); });
    on('compositionstart', () => { this.composing = true; });
    on('compositionend', () => {
      this.composing = false;
      this.syncFromDom();
      if (this.dirty) this.render();
    });
    on('beforeinput', e => {
      const t = (e as InputEvent).inputType;
      if (t === 'historyUndo' || t === 'historyRedo') {
        e.preventDefault();
        if (t === 'historyUndo') this.undo(); else this.redo();
      }
    });
    on('keydown', e => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); this.redo(); }
    });
    this.cleanup.push(sync.onDocChange(kind => {
      if (kind === 'reset') this.history.clear();
      if (kind !== 'local') this.render();
    }));
    // Initial render must not emit events: callers are still constructing us.
    this.render(true, false);
  }

  destroy(): void {
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
  }

  get text(): string { return this.domText; }

  focus(): void { this.el.focus(); }

  // ── local edits ──────────────────────────────────────────────────────────

  private syncFromDom(): void {
    const value = this.el.value;
    if (value === this.domText) return;
    const edit = diffText(this.domText, value, this.el.selectionEnd ?? value.length);
    if (edit) this.applyEdit(edit, false);
  }

  /** Replace the current selection with `text` (used for AI suggestions). */
  replaceSelection(text: string): void {
    const start = this.el.selectionStart ?? this.domText.length;
    const end = this.el.selectionEnd ?? start;
    this.applyEdit({ start, removed: end - start, inserted: text }, true);
    this.el.focus();
  }

  /**
   * Apply an edit expressed against `domText`. When `fromApi` is true the DOM
   * has not been changed by the browser yet.
   */
  private applyEdit(edit: TextEdit, fromApi: boolean): void {
    const doc = this.sync.doc;
    const startCp = this.cpIndex(edit.start);
    const endCp = this.cpIndex(edit.start + edit.removed);
    const inserted = codePoints(edit.inserted);
    if (inserted.length > 0 && !this.sync.canInsert(inserted.length)) {
      this.rerender({ caretAfter: startCp > 0 ? this.domIds[startCp - 1] : null });
      this.events.onRejected?.(`This change would exceed the document limit of ${this.sync.limits.maxDocAtoms.toLocaleString()} characters (including deleted history).`);
      return;
    }
    const after = startCp > 0 ? this.domIds[startCp - 1] : null;
    const ops: Op[] = [];
    const del = doc.deleteIds(this.domIds.slice(startCp, endCp));
    ops.push(...del);
    const ins = inserted.length > 0 ? doc.insertText(this.sync.clientId, after, inserted.join('')) : [];
    ops.push(...ins);
    // API insertions (AI suggestions) are their own undo step.
    this.history.record(ins.map(o => o.id), del.map(o => o.id), after, Date.now(), !fromApi);
    this.sync.submit(ops);
    const caretAfter = ins.length > 0 ? ins[ins.length - 1].id : after;
    let modelText: string;
    if (this.dirty) {
      // Remote changes arrived during IME composition: rebuild from the model.
      modelText = this.readModel();
    } else {
      // Fast path (profiled hot spot): the DOM mirrored the model before this
      // edit, so apply the same splice to the bookkeeping arrays — O(edit)
      // array work instead of rebuilding every visible atom per keystroke.
      this.domIds.splice(startCp, endCp - startCp, ...ins.map(o => o.id));
      this.domValues.splice(startCp, endCp - startCp, ...inserted);
      const startU = edit.start;
      modelText = this.domText.slice(0, startU) + inserted.join('') + this.domText.slice(startU + edit.removed);
      this.domText = modelText;
      this.astral = this.astral || inserted.some(v => v.length === 2);
    }
    if (fromApi || modelText !== this.el.value) {
      // DOM must change: API insertions, normalised lone surrogates, or
      // remote edits that arrived during IME composition.
      this.writeDom(modelText, caretAfter, caretAfter);
    }
    this.events.onChange?.();
  }

  /** UTF-16 offset → code-point index; O(1) when the text has no surrogate pairs. */
  private cpIndex(offset: number): number {
    return this.astral ? utf16ToCodePointIndex(this.domText, offset) : Math.min(offset, this.domText.length);
  }

  /** Debug/test helper: true if the bookkeeping mirrors the CRDT exactly. */
  checkConsistency(): boolean {
    const { ids, values } = this.sync.doc.visibleAtoms();
    return values.join('') === this.domText && ids.length === this.domIds.length &&
      ids.every((id, i) => id.c === this.domIds[i].c && id.t === this.domIds[i].t);
  }

  undo(): void { this.runHistory(true); }
  redo(): void { this.runHistory(false); }

  private runHistory(isUndo: boolean): void {
    if (this.composing) return;
    const r = isUndo ? this.history.undo(this.sync.doc, this.sync.clientId) : this.history.redo(this.sync.doc, this.sync.clientId);
    if (!r) return;
    this.sync.submit(r.ops);
    this.writeDom(this.readModel(), r.caretAfter, r.caretAfter);
    this.events.onChange?.();
  }

  // ── rendering ────────────────────────────────────────────────────────────

  /** Pull model state into the bookkeeping arrays; returns the model text. */
  private readModel(): string {
    const { ids, values } = this.sync.doc.visibleAtoms();
    this.domIds = ids;
    this.domValues = values;
    this.domText = values.join('');
    this.astral = this.domText.length !== values.length;
    return this.domText;
  }

  /** Re-render from the model after a remote change, keeping the selection anchored. */
  render(force = false, notify = true): void {
    if (this.composing) { this.dirty = true; return; }
    this.dirty = false;
    const el = this.el;
    // Anchor selection to the atoms left of each selection edge in the *old* DOM.
    const anchorOf = (off: number): AtomId | null => {
      const cp = this.cpIndex(off);
      return cp > 0 ? this.domIds[cp - 1] ?? null : null;
    };
    const startAnchor = anchorOf(el.selectionStart ?? 0);
    const endAnchor = anchorOf(el.selectionEnd ?? 0);
    const text = this.readModel();
    if (!force && text === el.value) { if (notify) this.events.onChange?.(); return; }
    this.writeDom(text, startAnchor, endAnchor);
    if (notify) this.events.onChange?.();
  }

  private rerender(o: { caretAfter: AtomId | null }): void {
    this.writeDom(this.readModel(), o.caretAfter, o.caretAfter);
  }

  private writeDom(text: string, startAfter: AtomId | null, endAfter: AtomId | null): void {
    const el = this.el;
    const doc = this.sync.doc;
    const focused = typeof document !== 'undefined' && document.activeElement === el;
    const direction = el.selectionDirection ?? 'none';
    const scrollTop = el.scrollTop;
    if (el.value !== text) el.value = text;
    const toOffset = (anchor: AtomId | null) => {
      const n = doc.visibleCountThrough(anchor);
      return codePointIndexToUtf16(this.domValues, n < 0 ? this.domValues.length : n);
    };
    const s = toOffset(startAfter);
    const e = Math.max(s, toOffset(endAfter));
    if (focused) el.setSelectionRange(s, e, direction as 'forward' | 'backward' | 'none');
    el.scrollTop = scrollTop;
  }
}
