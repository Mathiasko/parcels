/** One banner. `groupKey` makes a later banner with the same key replace the earlier one. */
export interface Notification {
  groupKey: string
  title: string
  message: string
  url?: string
}

export interface Notifier {
  /** Best-effort: resolves whether or not anything was delivered, and never rejects. */
  send(n: Notification): Promise<void>
}
