import { describeError, memoId, type Memo, type MemosClient } from "./usememos_api.ts";

/*
 * Read-only, paginated list of the user's memos, PAGE_SIZE rows at a time.
 * The API pages forward only, so the tokens of visited pages are kept to step
 * back.
 */
const PAGE_SIZE = 20;
const SNIPPET_MAX = 120;

function snippet(memo: Memo): string {
  const line = memo.content
    .split(/\r?\n/)
    .map((l) => l.replace(/^[#\s]+/, "").trim())
    .find((l) => l !== "");
  if (line === undefined) return "(empty)";
  return line.length > SNIPPET_MAX ? line.slice(0, SNIPPET_MAX - 3) + "..." : line;
}

function when(memo: Memo): string {
  if (memo.updateTime === undefined) return "";
  const t = new Date(memo.updateTime);
  return Number.isNaN(t.getTime()) ? "" : t.toLocaleString();
}

export class MemoBrowser {
  private readonly root: HTMLElement;
  private readonly rows: HTMLElement;
  private readonly info: HTMLElement;
  private readonly prev: HTMLButtonElement;
  private readonly next: HTMLButtonElement;

  /* tokens[i] fetches page i; tokens[0] is "" (the first page). */
  private tokens: string[] = [""];
  private page = 0;
  private nextToken = "";
  private loading = false;

  constructor(
    root: HTMLElement,
    private readonly client: () => Promise<MemosClient>,
    /* Opens the memo for editing; resolves to an error message or null. */
    private readonly onOpen: (id: string) => Promise<string | null>,
  ) {
    this.root = root;
    const q = <T extends Element>(sel: string) => {
      const el = root.querySelector<T>(sel);
      if (el === null) throw new Error(`browser: missing ${sel}`);
      return el;
    };
    this.rows = q<HTMLElement>(".rows");
    this.info = q<HTMLElement>(".info");
    this.prev = q<HTMLButtonElement>(".prev");
    this.next = q<HTMLButtonElement>(".next");

    this.prev.addEventListener("click", () => void this.go(this.page - 1));
    this.next.addEventListener("click", () => void this.go(this.page + 1));
    q<HTMLButtonElement>(".close-browser").addEventListener("click", () => this.close());
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.close();
      }
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  async open(): Promise<void> {
    this.root.hidden = false;
    this.root.focus();
    this.tokens = [""];
    this.page = 0;
    this.nextToken = "";
    await this.go(0);
  }

  close(): void {
    this.root.hidden = true;
  }

  private async go(page: number): Promise<void> {
    if (this.loading || page < 0 || page >= this.tokens.length + (this.nextToken ? 1 : 0)) return;
    if (page === this.tokens.length) this.tokens.push(this.nextToken);

    this.loading = true;
    this.setControls();
    this.info.textContent = "loading...";
    try {
      let client: MemosClient;
      try {
        client = await this.client();
      } catch (error) {
        this.rows.replaceChildren();
        this.info.textContent = `could not start the Memos client: ${error instanceof Error ? error.message : String(error)}`;
        return;
      }
      const reply = await client.listMemosPage({ pageSize: PAGE_SIZE }, this.tokens[page]!);
      if (!reply.ok) {
        this.rows.replaceChildren();
        this.info.textContent = `could not load memos: ${describeError(reply.error)}`;
        return;
      }
      this.page = page;
      this.nextToken = reply.value.nextPageToken;
      this.tokens.length = page + 1;
      this.render(reply.value.memos);
    } finally {
      this.loading = false;
      this.setControls();
    }
  }

  private async open_(id: string): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.setControls();
    this.info.textContent = `opening ${id}...`;
    try {
      const failure = await this.onOpen(id);
      if (failure === null) this.close();
      else this.info.textContent = `could not open ${id}: ${failure}`;
    } finally {
      this.loading = false;
      this.setControls();
    }
  }

  private render(memos: Memo[]): void {
    this.rows.replaceChildren(
      ...memos.map((m) => {
        const row = document.createElement("div");
        row.className = "row";
        const text = document.createElement("span");
        text.className = "snippet";
        text.textContent = snippet(m);
        const time = document.createElement("span");
        time.className = "time";
        time.textContent = when(m);
        const id = document.createElement("button");
        id.className = "memo-id";
        id.textContent = memoId(m);
        id.title = "Open for editing";
        id.addEventListener("click", () => void this.open_(memoId(m)));
        row.append(text, time, id);
        return row;
      }),
    );
    const from = this.page * PAGE_SIZE + 1;
    this.info.textContent =
      memos.length === 0 ? "no memos" : `page ${this.page + 1} | ${from}-${from + memos.length - 1}`;
  }

  private setControls(): void {
    this.prev.disabled = this.loading || this.page === 0;
    this.next.disabled = this.loading || this.nextToken === "";
  }
}
