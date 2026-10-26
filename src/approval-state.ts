export type ApproveResult =
  | "approved"
  | "remaining"
  | "not-authorized"
  | "already-approved"
  | "closed";

export type RejectResult =
  | "rejected"
  | "remaining"
  | "not-authorized"
  | "already-rejected"
  | "closed";

export interface ApprovalRecord {
  user: string;
  ts: number;
}

export class ApprovalState {
  private eligible: Set<string>;
  private approvals: ApprovalRecord[] = [];
  private rejections: ApprovalRecord[] = [];
  private readonly minimum: number;
  private readonly minimumRejects: number;
  private mutex: Promise<unknown> = Promise.resolve();
  // Set once by whichever event decides the outcome first (approve/reject
  // threshold, timeout, cancel) so exactly one terminal path ever runs.
  private closed = false;

  constructor(
    eligible: string[],
    minimumApprovals: number,
    minimumRejects = 1,
  ) {
    this.eligible = new Set(eligible);
    this.minimum = minimumApprovals;
    this.minimumRejects = minimumRejects;
  }

  get minimumCount(): number {
    return this.minimum;
  }

  get minimumRejectCount(): number {
    return this.minimumRejects;
  }

  async tryApprove(userId: string): Promise<ApproveResult> {
    return this.serialize<ApproveResult>(() => {
      if (this.closed) return "closed";
      if (this.approvals.some(a => a.user === userId)) return "already-approved";
      if (!this.eligible.has(userId)) return "not-authorized";
      this.approvals.push({ user: userId, ts: Date.now() });
      if (this.approvals.length < this.minimum) return "remaining";
      this.closed = true;
      return "approved";
    });
  }

  async tryReject(userId: string): Promise<RejectResult> {
    return this.serialize<RejectResult>(() => {
      if (this.closed) return "closed";
      if (this.rejections.some(r => r.user === userId)) return "already-rejected";
      if (!this.eligible.has(userId)) return "not-authorized";
      this.rejections.push({ user: userId, ts: Date.now() });
      if (this.rejections.length < this.minimumRejects) return "remaining";
      this.closed = true;
      return "rejected";
    });
  }

  /** Claims the outcome for a non-vote ending (timeout, cancel). False if already decided. */
  close(): boolean {
    if (this.closed) return false;
    this.closed = true;
    return true;
  }

  isClosed(): boolean {
    return this.closed;
  }

  private async serialize<T>(fn: () => T): Promise<T> {
    const next = this.mutex.then(() => fn());
    this.mutex = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  getApprovers(): string[] {
    return this.approvals.map(a => a.user);
  }

  getApprovalRecords(): ApprovalRecord[] {
    return [...this.approvals];
  }

  getRejecters(): string[] {
    return this.rejections.map(r => r.user);
  }

  getRejectionRecords(): ApprovalRecord[] {
    return [...this.rejections];
  }

  getRemaining(): string[] {
    const approved = new Set(this.approvals.map(a => a.user));
    return [...this.eligible].filter(u => !approved.has(u));
  }

  isComplete(): boolean {
    return this.approvals.length >= this.minimum;
  }
}
