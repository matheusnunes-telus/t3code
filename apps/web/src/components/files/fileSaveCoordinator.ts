import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

export interface FileSaveCoordinatorOptions<A, E> {
  readonly debounceMs: number;
  /** False holds edits until `save()` (mod+S) instead of saving after the debounce. */
  readonly autoSave?: () => boolean;
  readonly canPersist?: () => boolean;
  readonly persist: (contents: string) => Promise<AtomCommandResult<A, E>>;
  readonly onPendingChange: (pending: boolean) => void;
  /** Return false when another editor has newer unsaved contents. */
  readonly onConfirmed: (contents: string) => boolean | void;
  /** Called when a write pass ends with nothing further scheduled. */
  readonly onSettled?: () => void;
}

export class FileSaveCoordinator<A = unknown, E = unknown> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latestContents = "";
  private latestRevision = 0;
  private confirmedRevision = 0;
  private lastChangeAt = 0;
  private saving = false;
  private disposed = false;
  private flushing = false;

  constructor(private readonly options: FileSaveCoordinatorOptions<A, E>) {}

  change(contents: string): void {
    if (this.disposed) return;
    this.latestContents = contents;
    this.latestRevision += 1;
    this.lastChangeAt = Date.now();
    this.options.onPendingChange(true);
    if (this.autoSaves()) this.schedule(this.options.debounceMs);
  }

  /** Saves the latest edit now. */
  save(): void {
    if (this.disposed) return;
    this.clearTimer();
    void this.persistLatest();
  }

  hasUnsavedChanges(): boolean {
    return this.latestRevision !== this.confirmedRevision;
  }

  /** The newest contents not yet written, which is the last write this coordinator will make. */
  get unconfirmedContents(): string | null {
    return this.latestRevision === this.confirmedRevision ? null : this.latestContents;
  }

  /** Writes the newest draft now instead of after the debounce, then any draft queued behind it. */
  flush(): void {
    this.clearTimer();
    this.flushing = true;
    void this.persistLatest();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    // Without auto-save, closing keeps the edit unsaved (it stays in the file's
    // cached contents) rather than writing it behind the user's back.
    if (this.latestRevision > 0 && this.autoSaves()) void this.persistLatest();
  }

  private autoSaves(): boolean {
    return this.options.autoSave?.() !== false;
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persistLatest();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private async persistLatest(): Promise<void> {
    if (this.saving) return;
    if (this.latestRevision === this.confirmedRevision || this.options.canPersist?.() === false) {
      this.settle();
      return;
    }

    this.saving = true;
    const contents = this.latestContents;
    const revision = this.latestRevision;
    const result = await this.options.persist(contents);
    const succeeded = result._tag === "Success";
    let confirmed = false;
    if (succeeded) {
      this.confirmedRevision = revision;
      confirmed = this.options.onConfirmed(contents) !== false;
    }

    this.saving = false;
    if (revision === this.latestRevision) {
      if (confirmed) this.options.onPendingChange(false);
      this.settle();
      return;
    }

    const remainingDebounce = Math.max(
      0,
      this.options.debounceMs - (Date.now() - this.lastChangeAt),
    );
    if (this.flushing || (this.disposed && this.autoSaves())) {
      void this.persistLatest();
    } else if (!this.disposed && this.autoSaves()) {
      this.schedule(remainingDebounce);
    }
  }

  private settle(): void {
    this.flushing = false;
    this.options.onSettled?.();
  }
}
