export type WidgetAction = "session" | "compare";

export type TurnstileWidget = {
  action: WidgetAction | null;
  mount(action: WidgetAction): void;
  takeToken(): Promise<string>;
};

/** Token for POST /api/session. Always uses action=session, remounting the widget if needed. */
export async function tokenForSessionMint(
  widget: TurnstileWidget,
  opts: { siteKey: string; testSiteKey: boolean; dummy: string },
): Promise<string | undefined> {
  if (!opts.siteKey) return undefined;
  if (opts.testSiteKey) return opts.dummy;
  if (widget.action !== "session") widget.mount("session");
  return widget.takeToken();
}

export function remountCompareAfterMint(widget: TurnstileWidget, opts: { siteKey: string; testSiteKey: boolean }): void {
  if (opts.siteKey && !opts.testSiteKey) widget.mount("compare");
}
